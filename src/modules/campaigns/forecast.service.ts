/**
 * src/modules/campaigns/forecast.service.ts
 *
 * Predicts a campaign's delivery before it launches.
 *
 * 1. Recorded ad requests give an average for each hour of the week, limited to
 *    the campaign's targeting. Walking through the flight adds those up.
 * 2. Other campaigns already booked on the same inventory come off that total.
 * 3. Delivery is the smallest of what's available and what the limits allow.
 * 4. Reach assumes each impression lands on a random viewer in the matching
 *    audience, which gives reach = audience × (1 - e^(-impressions / audience)).
 */
import { Prisma } from '@prisma/client';
import { localTimeAt } from '@/lib/platform-time';
import { prisma } from '@/lib/prisma';
import type { ForecastDto } from './campaigns.schema';

const LOOKBACK_DAYS = 28;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const FORECAST_MARGIN = 0.15;

export type ForecastWarning =
  | 'NO_HISTORY'
  | 'NOT_ENOUGH_INVENTORY'
  | 'BUDGET_BELOW_GOAL'
  | 'LIMITS_BELOW_GOAL'
  | 'AUDIENCE_NEEDS_CONSENT';

export interface Forecast {
  availableImpressions: number;
  expectedImpressions: number;
  lowImpressions: number;
  highImpressions: number;
  expectedReach: number;
  averageFrequency: number;
  expectedSpendCents: number;
  goalDeliveryRate: number;
  warnings: ForecastWarning[];
}

const listFilter = (column: Prisma.Sql, values: string[], type?: string): Prisma.Sql => {
  if (values.length === 0) return Prisma.sql`TRUE`;
  return type === 'enum'
    ? Prisma.sql`${column}::text = ANY(${values}::text[])`
    : Prisma.sql`${column} = ANY(${values}::text[])`;
};

/** Average requests for each hour of the week, as "weekday-hour". */
const weeklyProfile = async (dto: ForecastDto, asOf: number): Promise<Map<string, number>> => {
  const from = new Date(asOf - LOOKBACK_DAYS * DAY_MS);

  const rows = await prisma.$queryRaw<Array<{ bucket: Date; requests: bigint }>>(Prisma.sql`
    SELECT bucket, SUM(requests) AS requests
    FROM inventory_hours
    WHERE bucket >= ${from} AND bucket < ${new Date(asOf)}
      AND ${listFilter(Prisma.sql`genre`, dto.targetGenres)}
      AND ${listFilter(Prisma.sql`country`, dto.targetCountries)}
      AND ${listFilter(Prisma.sql`slot`, dto.targetSlots, 'enum')}
      AND ${listFilter(Prisma.sql`device`, dto.targetDevices, 'enum')}
    GROUP BY bucket
  `);

  const totals = new Map<string, { sum: number; weeks: number }>();
  for (const { bucket, requests } of rows) {
    const { weekday, hour } = localTimeAt(bucket.getTime());
    const key = `${weekday}-${hour}`;
    const entry = totals.get(key) ?? { sum: 0, weeks: 0 };
    entry.sum += Number(requests);
    entry.weeks += 1;
    totals.set(key, entry);
  }

  return new Map([...totals].map(([key, { sum, weeks }]) => [key, sum / weeks]));
};

/** The share of a rival's inventory that overlaps ours, one dimension at a time. */
const overlap = (ours: string[], theirs: string[], all: number): number => {
  const mine = ours.length > 0 ? ours : null;
  const other = theirs.length > 0 ? theirs : null;
  if (!mine && !other) return 1;
  if (!mine) return 1;
  if (!other) return mine.length / all;
  return mine.filter((value) => other.includes(value)).length / other.length;
};

/** Impressions other guaranteed campaigns still need from our inventory. */
const bookedDemand = async (dto: ForecastDto, excludeId?: string): Promise<number> => {
  const others = await prisma.campaign.findMany({
    where: {
      status: 'ACTIVE',
      deliveryType: 'GUARANTEED',
      startsAt: { lt: dto.endsAt },
      endsAt: { gt: dto.startsAt },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: {
      id: true,
      impressionGoal: true,
      startsAt: true,
      endsAt: true,
      targetCountries: true,
      targetGenres: true,
      targetDevices: true,
      targetSlots: true,
    },
  });
  if (others.length === 0) return 0;

  const delivered = await prisma.metric.groupBy({
    by: ['campaignId'],
    where: { campaignId: { in: others.map(({ id }) => id) } },
    _sum: { impressions: true },
  });
  const deliveredById = new Map(
    delivered.map((row) => [row.campaignId, row._sum.impressions ?? 0]),
  );

  const shared = await prisma.$queryRaw<
    Array<{ genres: bigint; countries: bigint }>
  >`SELECT COUNT(DISTINCT genre) AS genres, COUNT(DISTINCT country) AS countries FROM inventory_hours`;
  const allGenres = Number(shared[0]?.genres ?? 1);
  const allCountries = Number(shared[0]?.countries ?? 1);

  return others.reduce((sum, other) => {
    const remaining = Math.max(0, other.impressionGoal - (deliveredById.get(other.id) ?? 0));
    const start = Math.max(Date.now(), other.startsAt.getTime());
    const end = other.endsAt.getTime();
    const shareOfFlight =
      Math.max(0, Math.min(end, dto.endsAt.getTime()) - Math.max(start, dto.startsAt.getTime())) /
      Math.max(end - start, 1);

    const shareOfInventory =
      overlap(dto.targetGenres, other.targetGenres, allGenres) *
      overlap(dto.targetCountries, other.targetCountries, allCountries) *
      overlap(dto.targetDevices, other.targetDevices, 4) *
      overlap(dto.targetSlots, other.targetSlots, 3);

    return sum + remaining * shareOfFlight * shareOfInventory;
  }, 0);
};

/** The latest audience figures, or nothing before any viewers have been seen. */
const audienceFigures = (): Promise<{
  viewers: number;
  consented: number;
  allTime: number;
} | null> => prisma.audienceDay.findFirst({ orderBy: { day: 'desc' } });

/** Genres targeted through segments narrow the audience to those genres' share. */
const segmentGenres = async (ids: string[]): Promise<string[]> => {
  if (ids.length === 0) return [];
  const segments = await prisma.audienceSegment.findMany({
    where: { id: { in: ids } },
    select: { genres: true },
  });
  return [...new Set(segments.flatMap(({ genres }) => genres))];
};

export const forecastCampaign = async (
  dto: ForecastDto,
  { asOf = Date.now(), excludeCampaignId }: { asOf?: number; excludeCampaignId?: string } = {},
): Promise<Forecast> => {
  const segments = await segmentGenres(dto.targetSegmentIds);
  const targetGenres =
    dto.targetGenres.length > 0
      ? dto.targetGenres.filter((genre) => segments.length === 0 || segments.includes(genre))
      : segments;

  const profile = await weeklyProfile({ ...dto, targetGenres }, asOf);
  const allProfile = await weeklyProfile(
    { ...dto, targetGenres: [], targetCountries: [], targetDevices: [], targetSlots: [] },
    asOf,
  );

  const hours = new Set(dto.activeHours);
  const days = new Set(dto.activeDays);
  let matching = 0;
  let wholePlatform = 0;

  const firstHour = Math.ceil(dto.startsAt.getTime() / HOUR_MS) * HOUR_MS;
  for (let time = firstHour; time < dto.endsAt.getTime(); time += HOUR_MS) {
    const { weekday, hour } = localTimeAt(time);
    const key = `${weekday}-${hour}`;
    wholePlatform += allProfile.get(key) ?? 0;

    if ((hours.size === 0 || hours.has(hour)) && (days.size === 0 || days.has(weekday))) {
      matching += profile.get(key) ?? 0;
    }
  }

  const audience = await audienceFigures();
  const consentShare = audience && audience.viewers > 0 ? audience.consented / audience.viewers : 1;
  const usesSegments = dto.targetSegmentIds.length > 0;
  const available = matching * (usesSegments ? consentShare : 1);

  const booked = await bookedDemand({ ...dto, targetGenres }, excludeCampaignId);
  const open = dto.deliveryType === 'AUCTION' ? Math.max(0, available - booked) : available;
  const contested = dto.deliveryType === 'AUCTION' ? open : Math.max(0, available - booked);

  const flightDays = Math.max(1, (dto.endsAt.getTime() - dto.startsAt.getTime()) / DAY_MS);
  const shareOfPlatform = wholePlatform > 0 ? matching / wholePlatform : 0;
  const population = (audience?.allTime ?? 0) * shareOfPlatform;
  const dailyAudience = (audience?.viewers ?? 0) * shareOfPlatform;

  const budgetLimit = Math.floor((dto.budgetCents * 1000) / dto.cpmCents);
  const dailyBudgetLimit = dto.dailyBudgetCents
    ? ((dto.dailyBudgetCents * 1000) / dto.cpmCents) * flightDays
    : Infinity;
  const dailyTargetLimit =
    dto.pacingMode === 'CUSTOM' && dto.dailyImpressionTarget
      ? dto.dailyImpressionTarget * flightDays
      : Infinity;
  const frequencyLimit = dto.frequencyCapPerDay
    ? dailyAudience * dto.frequencyCapPerDay * flightDays
    : Infinity;

  const limit = Math.min(dto.impressionGoal, budgetLimit, dailyBudgetLimit, dailyTargetLimit);
  const expected = Math.round(Math.min(contested, limit, frequencyLimit));
  const reach = population > 0 ? population * (1 - Math.exp(-expected / population)) : 0;

  const warnings: ForecastWarning[] = [];
  if (profile.size === 0) warnings.push('NO_HISTORY');
  else if (expected < dto.impressionGoal && contested < limit)
    warnings.push('NOT_ENOUGH_INVENTORY');
  if (budgetLimit < dto.impressionGoal) warnings.push('BUDGET_BELOW_GOAL');
  if (Math.min(dailyBudgetLimit, dailyTargetLimit, frequencyLimit) < dto.impressionGoal) {
    warnings.push('LIMITS_BELOW_GOAL');
  }
  if (usesSegments) warnings.push('AUDIENCE_NEEDS_CONSENT');

  return {
    availableImpressions: Math.round(available),
    expectedImpressions: expected,
    lowImpressions: Math.round(expected * (1 - FORECAST_MARGIN)),
    highImpressions: Math.round(Math.min(limit, expected * (1 + FORECAST_MARGIN))),
    expectedReach: Math.round(reach),
    averageFrequency: reach > 0 ? Number((expected / reach).toFixed(2)) : 0,
    expectedSpendCents: Math.round((expected * dto.cpmCents) / 1000),
    goalDeliveryRate: expected / dto.impressionGoal,
    warnings,
  };
};
