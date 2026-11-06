/**
 * src/modules/delivery/delivery.service.ts
 *
 * Chooses which ad to play. Campaigns come from an in-memory snapshot and live
 * counts from Redis, so a decision never queries the database. Serving reserves
 * the ad atomically, which keeps every limit intact at any concurrency.
 *
 * Guaranteed campaigns behind schedule go first, because they've promised
 * delivery. Auctions fill what's left: the top bid wins and pays just above the
 * next one. Guaranteed campaigns ahead of schedule come last.
 */
import type { Creative } from '@prisma/client';
import { env } from '@/config/env';
import { localTimeNow, type LocalTime } from '@/lib/platform-time';
import { counterKeys, redis, viewKeys } from '@/lib/redis';
import { decisionCache, type CachedCampaign, type CachedSegment } from './decision-cache';
import type { AdDecisionQuery } from './delivery.schema';
import { recordAdRequest, viewerInterests } from './viewer-activity';
import { adDecisions } from '@/lib/metrics';

// EVEN pacing lets a campaign run this far ahead of schedule before holding it back.
const EVEN_PACING_TOLERANCE = 1.05;

export interface AdDecision {
  campaignId: string;
  title: string;
  advertiser: string;
  /** What this impression costs, per 1,000. */
  priceCpmCents: number;
  /** Set when the caller asked for a campaign that has a playable ad. */
  creative?: Creative;
}

export interface DecisionOptions {
  requireCreative?: boolean;
  viewerId?: string | undefined;
  breakId?: string | undefined;
  consent?: boolean | undefined;
}

interface Candidate {
  campaign: CachedCampaign;
  priceCpmCents: number;
}

const matches = (allowed: Set<string>, value: string): boolean =>
  allowed.size === 0 || allowed.has(value);

const inSchedule = (campaign: CachedCampaign, time: LocalTime): boolean =>
  (campaign.activeHours.size === 0 || campaign.activeHours.has(time.hour)) &&
  (campaign.activeDays.size === 0 || campaign.activeDays.has(time.weekday));

/** How far along an even schedule a campaign is. Lower means further behind. */
const schedulePosition = (campaign: CachedCampaign, delivered: number, now: number): number => {
  const elapsed = (now - campaign.startsAt) / (campaign.endsAt - campaign.startsAt);
  return delivered / Math.max(campaign.impressionGoal * elapsed, 1);
};

const inSegment = (segment: CachedSegment, interests: Map<string, number>): boolean => {
  const views = segment.genres.reduce((sum, genre) => sum + (interests.get(genre) ?? 0), 0);
  return views >= segment.minViews;
};

/** A targeted campaign needs the viewer in at least one of its segments. */
const inAudience = (campaign: CachedCampaign, interests: Map<string, number>): boolean =>
  campaign.segments.length === 0 ||
  campaign.segments.some((segment) => inSegment(segment, interests));

/** Second-price: the winner pays one cent over the next bid, or the floor. */
const clearingPrice = (bid: number, nextBid: number | undefined): number =>
  Math.min(bid, Math.max((nextBid ?? 0) + 1, env.AUCTION_FLOOR_CPM_CENTS));

const orderCandidates = (
  campaigns: CachedCampaign[],
  counts: Array<string | null>,
  now: number,
): Candidate[] => {
  const guaranteed: Array<Candidate & { position: number }> = [];
  const auction: CachedCampaign[] = [];

  campaigns.forEach((campaign, index) => {
    const delivered = Number(counts[index] ?? 0);
    if (delivered >= campaign.impressionGoal) return;

    if (campaign.deliveryType === 'AUCTION') {
      if (campaign.cpmCents >= env.AUCTION_FLOOR_CPM_CENTS) auction.push(campaign);
      return;
    }

    const position = schedulePosition(campaign, delivered, now);
    if (campaign.pacingMode === 'EVEN' && position > EVEN_PACING_TOLERANCE) return;
    guaranteed.push({ campaign, position, priceCpmCents: campaign.cpmCents });
  });

  guaranteed.sort((a, b) => a.position - b.position || b.campaign.cpmCents - a.campaign.cpmCents);
  auction.sort((a, b) => b.cpmCents - a.cpmCents);

  const bids = auction.map((campaign, index) => ({
    campaign,
    priceCpmCents: clearingPrice(campaign.cpmCents, auction[index + 1]?.cpmCents),
  }));

  return [
    ...guaranteed.filter(({ position }) => position < 1),
    ...bids,
    ...guaranteed.filter(({ position }) => position >= 1),
  ];
};

/** Picks an ad in proportion to its weight. */
const pickCreative = (creatives: Creative[]): Creative => {
  const total = creatives.reduce((sum, { weight }) => sum + weight, 0);
  let remaining = Math.random() * total;

  for (const creative of creatives) {
    remaining -= creative.weight;
    if (remaining < 0) return creative;
  }
  return creatives[creatives.length - 1] as Creative;
};

export class DeliveryService {
  /** Picks the ad for a break, or returns null when nothing can run here. */
  /** Chooses an ad for a break, and counts whether one was found. */
  async decide(query: AdDecisionQuery, options: DecisionOptions = {}): Promise<AdDecision | null> {
    const decision = await this.choose(query, options);
    adDecisions.inc({ result: decision ? 'served' : 'none' });
    return decision;
  }

  private async choose(
    query: AdDecisionQuery,
    { requireCreative = false, viewerId, breakId, consent }: DecisionOptions,
  ): Promise<AdDecision | null> {
    const { campaigns, genreByShow } = await decisionCache.get();
    const genre = genreByShow.get(query.showId);
    if (genre === undefined) return null;

    recordAdRequest({ ...query, genre, viewerId, consent });

    const now = Date.now();
    const time = localTimeNow(now);

    let eligible = campaigns.filter(
      (campaign) =>
        now >= campaign.startsAt &&
        now < campaign.endsAt &&
        inSchedule(campaign, time) &&
        matches(campaign.countries, query.country) &&
        matches(campaign.genres, genre) &&
        matches(campaign.devices, query.device) &&
        matches(campaign.slots, query.slot) &&
        (!requireCreative || campaign.creatives.length > 0),
    );

    if (eligible.some(({ segments }) => segments.length > 0)) {
      const interests =
        consent && viewerId ? await viewerInterests(viewerId) : new Map<string, number>();
      eligible = eligible.filter((campaign) => inAudience(campaign, interests));
    }
    if (eligible.length === 0) return null;

    const counts = await redis.mget(eligible.map(({ id }) => counterKeys(id).delivered));

    // Another request may take the last ad first, so fall through to the next campaign.
    for (const { campaign, priceCpmCents } of orderCandidates(eligible, counts, now)) {
      const keys = counterKeys(campaign.id);
      const view = viewKeys(campaign.id, time.day, viewerId, breakId);

      const reserved = await redis.reserveAd(
        keys.served,
        keys.delivered,
        keys.lastServed,
        keys.spent,
        view.dailySpent,
        view.dailyServed,
        view.frequency,
        view.adBreak,
        campaign.impressionGoal,
        campaign.budgetMillicents,
        priceCpmCents,
        now,
        campaign.dailyBudgetMillicents,
        campaign.dailyImpressionLimit,
        viewerId ? campaign.frequencyCapPerDay : 0,
        breakId ? campaign.competitiveCategory : '',
        breakId ? campaign.id : '',
      );
      if (!reserved) continue;

      const decision = {
        campaignId: campaign.id,
        title: campaign.title,
        advertiser: campaign.advertiser,
        priceCpmCents,
      };
      return requireCreative
        ? { ...decision, creative: pickCreative(campaign.creatives) }
        : decision;
    }

    return null;
  }
}

export const deliveryService = new DeliveryService();
