/**
 * src/modules/campaigns/diagnosis.service.ts
 *
 * Works out why a campaign is behind, or whether it will reach its goal, from its
 * own data. It forecasts the rest of the flight with the budget that's left, then
 * compares what each limit allows: matching traffic, budget, daily limits and the
 * frequency cap. The smallest one is what holds the campaign back.
 *
 * Every number here comes from the database and the forecast, so the dashboard can
 * show it directly and the AI assistant can explain it without inventing causes.
 */
import { CreativeStatus, type Campaign } from '@prisma/client';
import { env } from '@/config/env';
import type { Actor } from '@/lib/actor';
import { prisma } from '@/lib/prisma';
import type { ForecastDto } from './campaigns.schema';
import { campaignsService } from './campaigns.service';
import { forecastCampaign } from './forecast.service';

const DAY_MS = 86_400_000;
const RECENT_DAYS = 7;

export type FactorSeverity = 'blocker' | 'limit' | 'info';

export interface DiagnosisFactor {
  code:
    | 'PAUSED'
    | 'NOT_STARTED'
    | 'FINISHED'
    | 'GOAL_REACHED'
    | 'NO_APPROVED_AD'
    | 'BID_BELOW_FLOOR'
    | 'INVENTORY'
    | 'BUDGET'
    | 'DAILY_BUDGET'
    | 'DAILY_TARGET'
    | 'FREQUENCY_CAP'
    | 'AUCTION_LEFTOVERS'
    | 'SCHEDULE'
    | 'TARGETING'
    | 'AUDIENCE_CONSENT'
    | 'INVALID_TRAFFIC'
    | 'RECENT_PACE';
  severity: FactorSeverity;
  title: string;
  detail: string;
  /** Impressions this limit allows over the rest of the flight, where it applies. */
  capacity?: number;
}

export interface Diagnosis {
  campaignId: string;
  title: string;
  status: Campaign['status'];
  pacing: string;
  delivered: number;
  goal: number;
  expectedByNow: number;
  /** Delivered as a share of an even schedule. 1 means exactly on schedule. */
  position: number;
  remainingGoal: number;
  remainingDays: number;
  neededPerDay: number;
  recentPerDay: number;
  /** Delivery the forecast expects by the end, at current settings. */
  projectedTotal: number;
  willReachGoal: boolean;
  factors: DiagnosisFactor[];
  summary: string;
}

const formatNumber = (value: number): string => Math.round(value).toLocaleString('en-GB');
const percent = (value: number): string => `${Math.round(value * 100)}%`;
const day = (date: Date): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: env.PLATFORM_TIMEZONE,
    day: 'numeric',
    month: 'short',
  }).format(date);

/** The forecast's view of the rest of the flight, with what's left of the budget and goal. */
const remainingDto = (
  campaign: Campaign,
  now: Date,
  remainingBudgetCents: number,
  remainingGoal: number,
): ForecastDto => ({
  title: campaign.title,
  advertiser: campaign.advertiser,
  status: campaign.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE',
  budgetCents: Math.max(1, remainingBudgetCents),
  cpmCents: campaign.cpmCents,
  impressionGoal: Math.max(1, remainingGoal),
  startsAt: now,
  endsAt: campaign.endsAt,
  targetCountries: campaign.targetCountries,
  targetGenres: campaign.targetGenres,
  targetDevices: campaign.targetDevices,
  targetSlots: campaign.targetSlots,
  targetSegmentIds: campaign.targetSegmentIds,
  deliveryType: campaign.deliveryType,
  pacingMode: campaign.pacingMode,
  dailyBudgetCents: campaign.dailyBudgetCents,
  dailyImpressionTarget: campaign.dailyImpressionTarget,
  frequencyCapPerDay: campaign.frequencyCapPerDay,
  activeHours: campaign.activeHours,
  activeDays: campaign.activeDays,
  competitiveCategory: campaign.competitiveCategory,
});

export class DiagnosisService {
  async diagnose(id: string, actor: Actor, now = new Date()): Promise<Diagnosis> {
    const campaign = await campaignsService.findOneOrFail(id, actor);
    const [[analytics], recent, creatives, filtered] = await Promise.all([
      campaignsService.getAnalytics(actor, { from: campaign.startsAt, to: now }, id),
      campaignsService.getPeriodTotals(
        actor,
        {
          from: new Date(
            Math.max(campaign.startsAt.getTime(), now.getTime() - RECENT_DAYS * DAY_MS),
          ),
          to: now,
        },
        id,
      ),
      prisma.creative.groupBy({
        by: ['status'],
        where: { campaignId: id },
        _count: { _all: true },
      }),
      prisma.filteredEvent.aggregate({
        where: { campaignId: id, bucket: { gte: new Date(now.getTime() - RECENT_DAYS * DAY_MS) } },
        _sum: { count: true },
      }),
    ]);

    const delivered = analytics?.lifetimeImpressions ?? 0;
    const spentCents = analytics?.lifetimeSpendCents ?? 0;
    const flight = campaign.endsAt.getTime() - campaign.startsAt.getTime();
    const elapsed = Math.min(Math.max(0, now.getTime() - campaign.startsAt.getTime()), flight);
    const expectedByNow = campaign.impressionGoal * (elapsed / flight);
    const remainingGoal = Math.max(0, campaign.impressionGoal - delivered);
    const remainingDays = Math.max(0, (campaign.endsAt.getTime() - now.getTime()) / DAY_MS);
    const recentDays = Math.max(1 / 24, Math.min(RECENT_DAYS, elapsed / DAY_MS));
    const recentPerDay = recent.impressions / recentDays;
    const neededPerDay = remainingDays > 0 ? remainingGoal / remainingDays : 0;
    const factors: DiagnosisFactor[] = [];

    const base = {
      campaignId: id,
      title: campaign.title,
      status: campaign.status,
      pacing: analytics?.pacing ?? 'NOT_STARTED',
      delivered,
      goal: campaign.impressionGoal,
      expectedByNow: Math.round(expectedByNow),
      position: expectedByNow > 0 ? delivered / expectedByNow : 1,
      remainingGoal,
      remainingDays: Number(remainingDays.toFixed(1)),
      neededPerDay: Math.round(neededPerDay),
      recentPerDay: Math.round(recentPerDay),
    };

    // Campaigns that aren't running have one answer, whatever the numbers say.
    if (remainingGoal === 0) {
      factors.push({
        code: 'GOAL_REACHED',
        severity: 'info',
        title: 'Goal reached',
        detail: `All ${formatNumber(campaign.impressionGoal)} impressions are delivered.`,
      });
      return {
        ...base,
        projectedTotal: delivered,
        willReachGoal: true,
        factors,
        summary: 'The impression goal is reached.',
      };
    }
    if (campaign.status === 'COMPLETED' || now >= campaign.endsAt) {
      factors.push({
        code: 'FINISHED',
        severity: 'info',
        title: 'Flight ended',
        detail: `It ended with ${formatNumber(delivered)} of ${formatNumber(campaign.impressionGoal)} impressions (${percent(delivered / campaign.impressionGoal)}).`,
      });
      return {
        ...base,
        projectedTotal: delivered,
        willReachGoal: false,
        factors,
        summary: `The campaign has ended, ${formatNumber(remainingGoal)} impressions short of its goal.`,
      };
    }
    if (now < campaign.startsAt) {
      factors.push({
        code: 'NOT_STARTED',
        severity: 'info',
        title: 'Not started',
        detail: `It starts on ${day(campaign.startsAt)}.`,
      });
    }
    if (campaign.status === 'PAUSED') {
      factors.push({
        code: 'PAUSED',
        severity: 'blocker',
        title: 'Paused',
        detail: 'A paused campaign gets no impressions until it is resumed.',
      });
    }

    const approved =
      creatives.find(({ status }) => status === CreativeStatus.APPROVED)?._count._all ?? 0;
    const waiting =
      creatives.find(({ status }) => status === CreativeStatus.PENDING_REVIEW)?._count._all ?? 0;
    if (approved === 0) {
      factors.push({
        code: 'NO_APPROVED_AD',
        severity: 'blocker',
        title: 'No approved video ad',
        detail:
          waiting > 0
            ? `${waiting} ad${waiting === 1 ? ' is' : 's are'} waiting for review. Video players can't show the campaign until one is approved.`
            : 'Video players can only show a campaign that has an approved ad. Upload one on the campaign page.',
      });
    }

    const belowFloor =
      campaign.deliveryType === 'AUCTION' && campaign.cpmCents < env.AUCTION_FLOOR_CPM_CENTS;
    if (belowFloor) {
      factors.push({
        code: 'BID_BELOW_FLOOR',
        severity: 'blocker',
        title: 'Bid under the auction minimum',
        detail: `The highest bid of €${(campaign.cpmCents / 100).toFixed(2)} is under the €${(env.AUCTION_FLOOR_CPM_CENTS / 100).toFixed(2)} floor, so it never competes.`,
      });
    }

    const remainingBudgetCents = Math.max(0, campaign.budgetCents - spentCents);
    const dto = remainingDto(
      campaign,
      new Date(Math.max(now.getTime(), campaign.startsAt.getTime())),
      remainingBudgetCents,
      remainingGoal,
    );
    const untargeted = {
      ...dto,
      targetCountries: [],
      targetGenres: [],
      targetDevices: [],
      targetSlots: [],
      targetSegmentIds: [],
      activeHours: [],
      activeDays: [],
    };
    const [forecast, wide] = await Promise.all([
      forecastCampaign(dto, { asOf: now.getTime(), excludeCampaignId: id }),
      forecastCampaign(untargeted, { asOf: now.getTime(), excludeCampaignId: id }),
    ]);

    // What each limit allows over the rest of the flight.
    const inventory = belowFloor
      ? 0
      : Math.max(0, forecast.availableImpressions - forecast.bookedImpressions);
    const budget = Math.floor((remainingBudgetCents * 1000) / campaign.cpmCents);
    const limits: DiagnosisFactor[] = [
      {
        code: campaign.deliveryType === 'AUCTION' ? 'AUCTION_LEFTOVERS' : 'INVENTORY',
        severity: 'limit',
        title:
          campaign.deliveryType === 'AUCTION' ? 'Spare traffic for auctions' : 'Matching traffic',
        detail:
          campaign.deliveryType === 'AUCTION'
            ? `About ${formatNumber(forecast.availableImpressions)} matching ad requests are expected before the end, and guaranteed campaigns still need ${formatNumber(forecast.bookedImpressions)} of them. Auctions only get what's left.`
            : `About ${formatNumber(forecast.availableImpressions)} ad requests matching the targeting are expected before the end. Other guaranteed campaigns need ${formatNumber(forecast.bookedImpressions)} of them, leaving about ${formatNumber(inventory)}.`,
        capacity: inventory,
      },
      {
        code: 'BUDGET',
        severity: 'limit',
        title: 'Budget left',
        detail: `€${(remainingBudgetCents / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} is left, which buys about ${formatNumber(budget)} impressions at the €${(campaign.cpmCents / 100).toFixed(2)} CPM.`,
        capacity: budget,
      },
    ];
    if (campaign.dailyBudgetCents) {
      const perDay = (campaign.dailyBudgetCents * 1000) / campaign.cpmCents;
      limits.push({
        code: 'DAILY_BUDGET',
        severity: 'limit',
        title: 'Daily budget',
        detail: `The €${(campaign.dailyBudgetCents / 100).toFixed(2)} daily budget allows about ${formatNumber(perDay)} impressions a day; ${formatNumber(neededPerDay)} a day are needed.`,
        capacity: Math.floor(perDay * remainingDays),
      });
    }
    if (campaign.pacingMode === 'CUSTOM' && campaign.dailyImpressionTarget) {
      limits.push({
        code: 'DAILY_TARGET',
        severity: 'limit',
        title: 'Daily impression target',
        detail: `Custom pacing stops at ${formatNumber(campaign.dailyImpressionTarget)} impressions a day; ${formatNumber(neededPerDay)} a day are needed.`,
        capacity: Math.floor(campaign.dailyImpressionTarget * remainingDays),
      });
    }

    // The forecast also applies the frequency cap. If it expects less than every other
    // limit allows, the cap is what's binding.
    const otherLimits = Math.min(...limits.map(({ capacity }) => capacity ?? Infinity));
    if (
      campaign.frequencyCapPerDay &&
      forecast.expectedImpressions < Math.min(otherLimits, remainingGoal) * 0.98
    ) {
      limits.push({
        code: 'FREQUENCY_CAP',
        severity: 'limit',
        title: 'Frequency cap',
        detail: `Each viewer can see it ${campaign.frequencyCapPerDay} time${campaign.frequencyCapPerDay === 1 ? '' : 's'} a day, which limits it to about ${formatNumber(forecast.expectedImpressions)} more impressions with the audience available.`,
        capacity: forecast.expectedImpressions,
      });
    }

    const binding = limits
      .filter(({ capacity }) => (capacity ?? Infinity) < remainingGoal)
      .sort((a, b) => (a.capacity ?? 0) - (b.capacity ?? 0));
    factors.push(...binding);

    // Context that explains the numbers above.
    const scheduledHours = (campaign.activeHours.length || 24) * (campaign.activeDays.length || 7);
    if (scheduledHours < 168) {
      factors.push({
        code: 'SCHEDULE',
        severity: 'info',
        title: 'Schedule',
        detail: `Ads only run in ${scheduledHours} of the week's 168 hours (${percent(scheduledHours / 168)}), which is already counted in the matching traffic.`,
      });
    }
    if (
      wide.availableImpressions > 0 &&
      forecast.availableImpressions < wide.availableImpressions
    ) {
      factors.push({
        code: 'TARGETING',
        severity: 'info',
        title: 'Targeting',
        detail: `The targeting and schedule match about ${percent(forecast.availableImpressions / wide.availableImpressions)} of the platform's ad requests.`,
      });
    }
    if (forecast.warnings.includes('AUDIENCE_NEEDS_CONSENT')) {
      factors.push({
        code: 'AUDIENCE_CONSENT',
        severity: 'info',
        title: 'Audiences need consent',
        detail:
          'Audience targeting only reaches viewers who consented to interest-based ads, which narrows the traffic.',
      });
    }
    const filteredCount = filtered._sum.count ?? 0;
    if (filteredCount > 0 && filteredCount / (filteredCount + recent.impressions) > 0.05) {
      factors.push({
        code: 'INVALID_TRAFFIC',
        severity: 'info',
        title: 'Invalid traffic removed',
        detail: `${formatNumber(filteredCount)} events in the last ${RECENT_DAYS} days were rejected as invalid and not counted.`,
      });
    }
    if (now >= campaign.startsAt) {
      factors.push({
        code: 'RECENT_PACE',
        severity: 'info',
        title: 'Recent pace',
        detail: `It delivered about ${formatNumber(recentPerDay)} impressions a day recently; ${formatNumber(neededPerDay)} a day are needed to finish on time.`,
      });
    }

    // The outlook follows what the campaign actually delivers, capped by the limits that
    // are certain (budget and daily caps). The forecast's traffic estimate stays a cause
    // above, because history can understate a campaign that is already delivering.
    const blocked = factors.some(({ severity }) => severity === 'blocker');
    const hardCap = Math.min(
      remainingGoal,
      ...limits
        .filter(
          ({ code }) => code === 'BUDGET' || code === 'DAILY_BUDGET' || code === 'DAILY_TARGET',
        )
        .map(({ capacity }) => capacity ?? Infinity),
    );
    const startsIn = Math.max(0, campaign.startsAt.getTime() - now.getTime()) / DAY_MS;
    const pace =
      now >= campaign.startsAt
        ? recentPerDay
        : forecast.expectedImpressions / Math.max(1, remainingDays - startsIn);
    // Only days inside the flight deliver, so the wait before a later start doesn't count.
    const projectedTotal =
      delivered + (blocked ? 0 : Math.min(hardCap, pace * Math.max(0, remainingDays - startsIn)));
    const willReachGoal = !blocked && projectedTotal >= campaign.impressionGoal * 0.98;
    const main = factors.find(({ severity }) => severity !== 'info');

    const where =
      base.position < 0.9
        ? `Behind schedule: ${formatNumber(delivered)} of the ${formatNumber(expectedByNow)} impressions expected by now (${percent(base.position)}).`
        : `On or ahead of schedule: ${formatNumber(delivered)} of the ${formatNumber(expectedByNow)} impressions expected by now.`;
    const outlook = willReachGoal
      ? `At its recent pace it should reach its ${formatNumber(campaign.impressionGoal)} goal by ${day(campaign.endsAt)}.`
      : `At its recent pace it would reach about ${formatNumber(projectedTotal)} of ${formatNumber(campaign.impressionGoal)} by ${day(campaign.endsAt)}.`;
    const reason = main ? ` Main reason: ${main.title.toLowerCase()}.` : '';

    return {
      ...base,
      projectedTotal: Math.round(projectedTotal),
      willReachGoal,
      factors,
      summary: `${where} ${outlook}${willReachGoal ? '' : reason}`,
    };
  }
}

export const diagnosisService = new DiagnosisService();
