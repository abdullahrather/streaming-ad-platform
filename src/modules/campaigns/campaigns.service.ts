/**
 * src/modules/campaigns/campaigns.service.ts
 *
 * Business logic for campaigns.
 *
 * Every analytics method runs as one SQL statement over the hourly rollup table,
 * so the database does the aggregation and the number of campaigns never adds
 * round-trips (no N+1). People see their active organisation; admins and guests see all.
 */
import { Prisma, type Campaign } from '@prisma/client';
import { seesAllOrganisations, type Actor } from '@/lib/actor';
import { prisma } from '@/lib/prisma';
import { AppError } from '@/middleware/errorHandler';
import { decisionCache } from '@/modules/delivery/decision-cache';
import { DAILY_TARGET_ERROR, hasDailyTarget } from './campaigns.schema';
import { forecastCampaign } from './forecast.service';
import type {
  CreateCampaignDto,
  DateRange,
  ListCampaignsQuery,
  UpdateCampaignDto,
} from './campaigns.schema';

const HOURLY_RANGE_LIMIT_MS = 3 * 86_400_000;
const PACING_TOLERANCE = 0.1;

// ── Typed return shapes ───────────────────────────────────────────────────────

export interface PaginatedCampaigns {
  data: Campaign[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export type Pacing = 'AHEAD' | 'ON_TRACK' | 'BEHIND' | 'NOT_STARTED' | 'FINISHED';

export interface PerformanceTotals {
  impressions: number;
  clicks: number;
  firstQuartiles: number;
  midpoints: number;
  thirdQuartiles: number;
  completions: number;
  ctr: number;
  completionRate: number;
}

export interface CampaignAnalytics extends Campaign, PerformanceTotals {
  ownerEmail: string;
  spendCents: number;
  lifetimeImpressions: number;
  lifetimeSpendCents: number;
  deliveryRate: number;
  budgetUsedRate: number;
  pacing: Pacing;
}

export interface PeriodTotals extends PerformanceTotals {
  spendCents: number;
}

export interface TimeseriesPoint extends PerformanceTotals {
  time: Date;
}

export interface BreakdownRow extends PerformanceTotals {
  key: string;
}

export interface Breakdown {
  slot: BreakdownRow[];
  country: BreakdownRow[];
  device: BreakdownRow[];
  show: BreakdownRow[];
}

type CampaignAnalyticsRow = Campaign & {
  ownerEmail: string;
  impressions: bigint;
  clicks: bigint;
  firstQuartiles: bigint;
  midpoints: bigint;
  thirdQuartiles: bigint;
  completions: bigint;
  lifetimeImpressions: bigint;
  costMillicents: bigint;
  lifetimeCostMillicents: bigint;
};

interface TotalsRow {
  impressions: bigint;
  clicks: bigint;
  firstQuartiles: bigint;
  midpoints: bigint;
  thirdQuartiles: bigint;
  completions: bigint;
}

const ZERO_TOTALS: TotalsRow = {
  impressions: 0n,
  clicks: 0n,
  firstQuartiles: 0n,
  midpoints: 0n,
  thirdQuartiles: 0n,
  completions: 0n,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// A person with no active organisation matches nothing.
const NO_ORGANISATION = '';

const organisationFilter = (actor: Actor): string | undefined =>
  seesAllOrganisations(actor) ? undefined : (actor.organisationId ?? NO_ORGANISATION);

const organisationSql = (actor: Actor): Prisma.Sql => {
  const organisationId = organisationFilter(actor);
  return organisationId === undefined
    ? Prisma.sql`TRUE`
    : Prisma.sql`c.organisation_id = ${organisationId}`;
};

const ratio = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);

const toTotals = (row: TotalsRow): PerformanceTotals => {
  const impressions = Number(row.impressions);
  const clicks = Number(row.clicks);
  const completions = Number(row.completions);
  return {
    impressions,
    clicks,
    firstQuartiles: Number(row.firstQuartiles),
    midpoints: Number(row.midpoints),
    thirdQuartiles: Number(row.thirdQuartiles),
    completions,
    ctr: ratio(clicks, impressions),
    completionRate: ratio(completions, impressions),
  };
};

const toCents = (millicents: bigint): number => Math.round(Number(millicents) / 1000);

/** Compares delivery so far with an even spread of the goal across the flight. */
const pacingOf = (campaign: Campaign, delivered: number, now: Date): Pacing => {
  if (campaign.status === 'COMPLETED' || now >= campaign.endsAt) return 'FINISHED';
  if (now < campaign.startsAt) return 'NOT_STARTED';

  const flight = campaign.endsAt.getTime() - campaign.startsAt.getTime();
  const elapsed = now.getTime() - campaign.startsAt.getTime();
  const expected = campaign.impressionGoal * (elapsed / flight);
  const position = ratio(delivered, expected);

  if (position > 1 + PACING_TOLERANCE) return 'AHEAD';
  return position < 1 - PACING_TOLERANCE ? 'BEHIND' : 'ON_TRACK';
};

const definedOnly = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;

// ── Service class ─────────────────────────────────────────────────────────────

export class CampaignsService {
  /**
   * Returns a paginated list of campaigns visible to the actor.
   * Supports optional status filtering.
   */
  async listCampaigns(actor: Actor, query: ListCampaignsQuery): Promise<PaginatedCampaigns> {
    const organisationId = organisationFilter(actor);
    const where: Prisma.CampaignWhereInput = {
      ...(organisationId === undefined ? {} : { organisationId }),
      ...(query.status ? { status: query.status } : {}),
    };

    const skip = (query.page - 1) * query.limit;

    const [total, data] = await prisma.$transaction([
      prisma.campaign.count({ where }),
      prisma.campaign.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.limit,
      }),
    ]);

    return {
      data,
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  async createCampaign(actor: Actor, dto: CreateCampaignDto): Promise<Campaign> {
    if (!actor.organisationId) throw new AppError(409, 'Choose an organisation first.');
    await this.assertOwnSegments(actor.organisationId, dto.targetSegmentIds);

    const forecast = await forecastCampaign(dto);
    const created = await prisma.campaign.create({
      data: {
        ...dto,
        userId: actor.sub,
        organisationId: actor.organisationId,
        forecastImpressions: forecast.expectedImpressions,
        forecastReach: forecast.expectedReach,
      },
    });
    decisionCache.invalidate();
    return created;
  }

  /** A campaign can only target its own organisation's segments. */
  private async assertOwnSegments(organisationId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const owned = await prisma.audienceSegment.count({
      where: { id: { in: ids }, organisationId },
    });
    if (owned !== new Set(ids).size)
      throw new AppError(422, 'One of those audiences was not found.');
  }

  async updateCampaign(id: string, actor: Actor, dto: UpdateCampaignDto): Promise<Campaign> {
    const campaign = await this.findOneOrFail(id, actor);
    await this.assertOwnSegments(campaign.organisationId, dto.targetSegmentIds ?? []);

    if (campaign.status === 'COMPLETED' && dto.status) {
      throw new AppError(409, 'A completed campaign cannot change status.');
    }
    const startsAt = dto.startsAt ?? campaign.startsAt;
    const endsAt = dto.endsAt ?? campaign.endsAt;
    if (endsAt <= startsAt) {
      throw new AppError(422, 'End date must be after the start date.');
    }
    const pacing = {
      pacingMode: dto.pacingMode ?? campaign.pacingMode,
      dailyImpressionTarget:
        dto.dailyImpressionTarget === undefined
          ? campaign.dailyImpressionTarget
          : dto.dailyImpressionTarget,
    };
    if (!hasDailyTarget(pacing)) throw new AppError(422, DAILY_TARGET_ERROR.error);

    const updated = await prisma.campaign.update({
      where: { id },
      data: definedOnly(dto) as Prisma.CampaignUpdateInput,
    });
    decisionCache.invalidate();
    return updated;
  }

  async deleteCampaign(id: string, actor: Actor): Promise<Campaign> {
    await this.findOneOrFail(id, actor);
    const deleted = await prisma.campaign.delete({ where: { id } });
    decisionCache.invalidate();
    return deleted;
  }

  /**
   * Totals per campaign for the date window, plus lifetime delivery for budget
   * and pacing. LEFT JOIN keeps campaigns with no metrics; COALESCE turns their
   * NULL sums into 0.
   */
  async getAnalytics(
    actor: Actor,
    range: DateRange,
    campaignId?: string,
  ): Promise<CampaignAnalytics[]> {
    const campaignFilter = campaignId ? Prisma.sql`c.id = ${campaignId}` : Prisma.sql`TRUE`;
    const inRange = Prisma.sql`m.bucket >= ${range.from} AND m.bucket < ${range.to}`;

    const rows = await prisma.$queryRaw<CampaignAnalyticsRow[]>(Prisma.sql`
      SELECT
        c.id,
        c.organisation_id AS "organisationId",
        c.user_id AS "userId",
        c.title,
        c.advertiser,
        c.status,
        c.budget_cents AS "budgetCents",
        c.cpm_cents AS "cpmCents",
        c.impression_goal AS "impressionGoal",
        c.starts_at AS "startsAt",
        c.ends_at AS "endsAt",
        c.target_countries AS "targetCountries",
        c.target_genres AS "targetGenres",
        c.target_devices::text[] AS "targetDevices",
        c.target_slots::text[] AS "targetSlots",
        c.target_segment_ids AS "targetSegmentIds",
        c.delivery_type AS "deliveryType",
        c.pacing_mode AS "pacingMode",
        c.daily_budget_cents AS "dailyBudgetCents",
        c.daily_impression_target AS "dailyImpressionTarget",
        c.frequency_cap_per_day AS "frequencyCapPerDay",
        c.active_hours AS "activeHours",
        c.active_days AS "activeDays",
        c.competitive_category AS "competitiveCategory",
        c.forecast_impressions AS "forecastImpressions",
        c.forecast_reach AS "forecastReach",
        c.created_at AS "createdAt",
        c.updated_at AS "updatedAt",
        u.email AS "ownerEmail",
        COALESCE(SUM(m.impressions) FILTER (WHERE ${inRange}), 0) AS impressions,
        COALESCE(SUM(m.clicks) FILTER (WHERE ${inRange}), 0) AS clicks,
        COALESCE(SUM(m.first_quartiles) FILTER (WHERE ${inRange}), 0) AS "firstQuartiles",
        COALESCE(SUM(m.midpoints) FILTER (WHERE ${inRange}), 0) AS midpoints,
        COALESCE(SUM(m.third_quartiles) FILTER (WHERE ${inRange}), 0) AS "thirdQuartiles",
        COALESCE(SUM(m.completions) FILTER (WHERE ${inRange}), 0) AS completions,
        COALESCE(SUM(m.impressions), 0) AS "lifetimeImpressions",
        COALESCE(SUM(m.cost_millicents) FILTER (WHERE ${inRange}), 0) AS "costMillicents",
        COALESCE(SUM(m.cost_millicents), 0) AS "lifetimeCostMillicents"
      FROM campaigns c
      JOIN users u ON u.id = c.user_id
      LEFT JOIN metrics m ON m.campaign_id = c.id
      WHERE ${organisationSql(actor)} AND ${campaignFilter}
      GROUP BY c.id, u.email
      ORDER BY c.created_at DESC
    `);

    const now = new Date();
    return rows.map((row) => {
      const lifetimeImpressions = Number(row.lifetimeImpressions);
      const lifetimeSpendCents = toCents(row.lifetimeCostMillicents);
      const totals = toTotals(row);

      return {
        ...row,
        ...totals,
        spendCents: toCents(row.costMillicents),
        lifetimeImpressions,
        lifetimeSpendCents,
        deliveryRate: ratio(lifetimeImpressions, row.impressionGoal),
        budgetUsedRate: ratio(lifetimeSpendCents, row.budgetCents),
        pacing: pacingOf(row, lifetimeImpressions, now),
      };
    });
  }

  /** Performance over time: hourly for up to three days, otherwise daily. */
  async getTimeseries(
    actor: Actor,
    range: DateRange,
    campaignId?: string,
  ): Promise<TimeseriesPoint[]> {
    const isHourly = range.to.getTime() - range.from.getTime() <= HOURLY_RANGE_LIMIT_MS;
    const unit = isHourly ? 'hour' : 'day';
    const campaignFilter = campaignId ? Prisma.sql`c.id = ${campaignId}` : Prisma.sql`TRUE`;

    const rows = await prisma.$queryRaw<Array<TotalsRow & { time: Date }>>(Prisma.sql`
      SELECT
        date_trunc(${unit}::text, m.bucket, 'UTC') AS time,
        SUM(m.impressions) AS impressions,
        SUM(m.clicks) AS clicks,
        SUM(m.first_quartiles) AS "firstQuartiles",
        SUM(m.midpoints) AS midpoints,
        SUM(m.third_quartiles) AS "thirdQuartiles",
        SUM(m.completions) AS completions
      FROM metrics m
      JOIN campaigns c ON c.id = m.campaign_id
      WHERE m.bucket >= ${range.from} AND m.bucket < ${range.to}
        AND ${organisationSql(actor)} AND ${campaignFilter}
      GROUP BY 1
      ORDER BY 1
    `);

    return rows.map((row) => ({ time: row.time, ...toTotals(row) }));
  }

  /** Totals and spend across every visible campaign, or one, for a date range. */
  async getPeriodTotals(
    actor: Actor,
    range: DateRange,
    campaignId?: string,
  ): Promise<PeriodTotals> {
    const campaignFilter = campaignId ? Prisma.sql`c.id = ${campaignId}` : Prisma.sql`TRUE`;

    const [row] = await prisma.$queryRaw<Array<TotalsRow & { costMillicents: bigint }>>(Prisma.sql`
      SELECT
        COALESCE(SUM(m.impressions), 0) AS impressions,
        COALESCE(SUM(m.clicks), 0) AS clicks,
        COALESCE(SUM(m.first_quartiles), 0) AS "firstQuartiles",
        COALESCE(SUM(m.midpoints), 0) AS midpoints,
        COALESCE(SUM(m.third_quartiles), 0) AS "thirdQuartiles",
        COALESCE(SUM(m.completions), 0) AS completions,
        COALESCE(SUM(m.cost_millicents), 0) AS "costMillicents"
      FROM metrics m
      JOIN campaigns c ON c.id = m.campaign_id
      WHERE m.bucket >= ${range.from} AND m.bucket < ${range.to}
        AND ${organisationSql(actor)} AND ${campaignFilter}
    `);

    return row
      ? { ...toTotals(row), spendCents: toCents(row.costMillicents) }
      : { ...toTotals(ZERO_TOTALS), spendCents: 0 };
  }

  /** Traffic rejected as invalid, by reason. Call after checking the actor can see the campaign. */
  async getFiltered(
    campaignId: string,
    range: DateRange,
  ): Promise<Array<{ reason: string; count: number }>> {
    const rows = await prisma.filteredEvent.groupBy({
      by: ['reason'],
      where: { campaignId, bucket: { gte: range.from, lt: range.to } },
      _sum: { count: true },
    });
    return rows.map(({ reason, _sum }) => ({ reason, count: _sum.count ?? 0 }));
  }

  /** Performance by slot, country, device and show in one GROUPING SETS query. */
  async getBreakdown(id: string, actor: Actor, range: DateRange): Promise<Breakdown> {
    await this.findOneOrFail(id, actor);

    const rows = await prisma.$queryRaw<
      Array<TotalsRow & { dimension: keyof Breakdown; key: string }>
    >(Prisma.sql`
      SELECT
        CASE
          WHEN GROUPING(m.slot) = 0 THEN 'slot'
          WHEN GROUPING(m.country) = 0 THEN 'country'
          WHEN GROUPING(m.device) = 0 THEN 'device'
          ELSE 'show'
        END AS dimension,
        COALESCE(m.slot::text, m.country, m.device::text, s.title) AS key,
        SUM(m.impressions) AS impressions,
        SUM(m.clicks) AS clicks,
        SUM(m.first_quartiles) AS "firstQuartiles",
        SUM(m.midpoints) AS midpoints,
        SUM(m.third_quartiles) AS "thirdQuartiles",
        SUM(m.completions) AS completions
      FROM metrics m
      JOIN shows s ON s.id = m.show_id
      WHERE m.campaign_id = ${id} AND m.bucket >= ${range.from} AND m.bucket < ${range.to}
      GROUP BY GROUPING SETS ((m.slot), (m.country), (m.device), (s.title))
      ORDER BY impressions DESC
    `);

    const breakdown: Breakdown = { slot: [], country: [], device: [], show: [] };
    rows.forEach((row) => breakdown[row.dimension].push({ key: row.key, ...toTotals(row) }));
    return breakdown;
  }

  /**
   * Finds a campaign by ID, scoped to the actor.
   * Throws 404 if not found or if it belongs to another advertiser.
   */
  async findOneOrFail(campaignId: string, actor: Actor): Promise<Campaign> {
    const organisationId = organisationFilter(actor);
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, ...(organisationId === undefined ? {} : { organisationId }) },
    });

    if (!campaign) {
      throw new AppError(404, `Campaign with id "${campaignId}" not found.`);
    }

    return campaign;
  }
}

export const campaignsService = new CampaignsService();
