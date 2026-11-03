/**
 * src/modules/delivery/decision-cache.ts
 *
 * Keeps running campaigns in memory, so choosing an ad needs no database query.
 * Live delivery counts come from Redis. The snapshot refreshes every few seconds,
 * and straight away when something changes in this process.
 */
import { CreativeStatus, type Creative, type DeliveryType, type PacingMode } from '@prisma/client';
import { env } from '@/config/env';
import { prisma } from '@/lib/prisma';
import { counterKeys, redis } from '@/lib/redis';

// Ads reserved but never reported are given back once a campaign has gone quiet.
const ABANDONED_RESERVATION_MS = 120_000;

export interface CachedSegment {
  genres: string[];
  minViews: number;
}

export interface CachedCampaign {
  id: string;
  title: string;
  advertiser: string;
  cpmCents: number;
  impressionGoal: number;
  budgetMillicents: number;
  dailyBudgetMillicents: number;
  /** Zero means no daily limit. */
  dailyImpressionLimit: number;
  frequencyCapPerDay: number;
  deliveryType: DeliveryType;
  pacingMode: PacingMode;
  competitiveCategory: string;
  activeHours: Set<number>;
  activeDays: Set<number>;
  segments: CachedSegment[];
  startsAt: number;
  endsAt: number;
  countries: Set<string>;
  genres: Set<string>;
  devices: Set<string>;
  slots: Set<string>;
  creatives: Creative[];
}

export interface DecisionSnapshot {
  campaigns: CachedCampaign[];
  genreByShow: Map<string, string>;
}

/** Starts counters from the database, without touching ones already running. */
const syncCounters = async (campaigns: CachedCampaign[]): Promise<void> => {
  if (campaigns.length === 0) return;

  const totals = await prisma.metric.groupBy({
    by: ['campaignId'],
    where: { campaignId: { in: campaigns.map(({ id }) => id) } },
    _sum: { impressions: true, costMillicents: true },
  });
  const deliveredById = new Map(totals.map((row) => [row.campaignId, row._sum.impressions ?? 0]));
  const costById = new Map(
    totals.map((row) => [row.campaignId, Number(row._sum.costMillicents ?? 0)]),
  );

  const setup = redis.pipeline();
  for (const { id } of campaigns) {
    const keys = counterKeys(id);
    const delivered = deliveredById.get(id) ?? 0;
    setup.setnx(keys.delivered, delivered);
    setup.setnx(keys.served, delivered);
    setup.setnx(keys.spent, costById.get(id) ?? 0);
  }
  await setup.exec();

  const read = campaigns.flatMap(({ id }) => {
    const keys = counterKeys(id);
    return [keys.delivered, keys.served, keys.lastServed];
  });
  const values = await redis.mget(read);

  const giveBack = redis.pipeline();
  campaigns.forEach(({ id }, index) => {
    const delivered = Number(values[index * 3] ?? 0);
    const served = Number(values[index * 3 + 1] ?? 0);
    const lastServed = Number(values[index * 3 + 2] ?? 0);

    if (served > delivered && Date.now() - lastServed > ABANDONED_RESERVATION_MS) {
      giveBack.set(counterKeys(id).served, delivered);
      giveBack.set(counterKeys(id).spent, costById.get(id) ?? 0);
    }
  });
  await giveBack.exec();
};

const load = async (): Promise<DecisionSnapshot> => {
  const now = new Date();
  const [rows, shows] = await Promise.all([
    prisma.campaign.findMany({
      where: { status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gt: now } },
      include: { creatives: { where: { status: CreativeStatus.APPROVED } } },
    }),
    prisma.show.findMany({ select: { id: true, genre: true } }),
  ]);

  const segmentIds = [...new Set(rows.flatMap(({ targetSegmentIds }) => targetSegmentIds))];
  const segments = await prisma.audienceSegment.findMany({
    where: { id: { in: segmentIds } },
    select: { id: true, genres: true, minViews: true },
  });
  const segmentsById = new Map(segments.map((segment) => [segment.id, segment]));

  const campaigns = rows.map((row) => ({
    id: row.id,
    title: row.title,
    advertiser: row.advertiser,
    cpmCents: row.cpmCents,
    impressionGoal: row.impressionGoal,
    budgetMillicents: row.budgetCents * 1000,
    dailyBudgetMillicents: (row.dailyBudgetCents ?? 0) * 1000,
    dailyImpressionLimit: row.pacingMode === 'CUSTOM' ? (row.dailyImpressionTarget ?? 0) : 0,
    frequencyCapPerDay: row.frequencyCapPerDay ?? 0,
    deliveryType: row.deliveryType,
    pacingMode: row.pacingMode,
    competitiveCategory: row.competitiveCategory,
    activeHours: new Set(row.activeHours),
    activeDays: new Set(row.activeDays),
    segments: row.targetSegmentIds.flatMap((id) => {
      const segment = segmentsById.get(id);
      return segment ? [segment] : [];
    }),
    startsAt: row.startsAt.getTime(),
    endsAt: row.endsAt.getTime(),
    countries: new Set(row.targetCountries),
    genres: new Set(row.targetGenres),
    devices: new Set<string>(row.targetDevices),
    slots: new Set<string>(row.targetSlots),
    creatives: row.creatives,
  }));

  await syncCounters(campaigns);
  return { campaigns, genreByShow: new Map(shows.map(({ id, genre }) => [id, genre])) };
};

class DecisionCache {
  private snapshot: DecisionSnapshot | null = null;
  private expiresAt = 0;
  private loading: Promise<DecisionSnapshot> | null = null;

  /** Parallel requests share one refresh. */
  async get(): Promise<DecisionSnapshot> {
    if (this.snapshot && Date.now() < this.expiresAt) return this.snapshot;

    this.loading ??= load()
      .then((snapshot) => {
        this.snapshot = snapshot;
        this.expiresAt = Date.now() + env.DECISION_CACHE_MS;
        return snapshot;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  invalidate(): void {
    this.expiresAt = 0;
  }
}

export const decisionCache = new DecisionCache();
