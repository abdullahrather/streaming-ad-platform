/**
 * src/modules/reports/reports.service.ts
 *
 * Runs reports and keeps saved ones. A report is one SQL statement over the hourly
 * rollups, grouped by a fixed expression, so it stays fast however many campaigns
 * it covers. Reach comes from the daily Redis sketches.
 */
import { Prisma, ReportGrouping, ReportSchedule, type Report } from '@prisma/client';
import { env } from '@/config/env';
import { canManageCampaigns, seesAllOrganisations, type Actor } from '@/lib/actor';
import { localTimeAt } from '@/lib/platform-time';
import { prisma } from '@/lib/prisma';
import { dailyReachKeys, reachBetween, redis } from '@/lib/redis';
import { AppError } from '@/middleware/errorHandler';
import type { ReportColumn, ReportDefinition, SaveReportDto } from './reports.schema';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
// A total reach above this many sketches would be slow to merge, so it's left out.
const MAX_REACH_KEYS = 5000;

export type ReportValues = Partial<Record<ReportColumn, number>>;

export interface ReportRow {
  key: string;
  label: string;
  values: ReportValues;
}

export interface ReportResult {
  from: Date;
  to: Date;
  groupBy: ReportGrouping;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: ReportValues;
}

/** Which organisation a report reads. Undefined reads every organisation. */
export interface ReportScope {
  organisationId: string | undefined;
}

interface SumRow {
  key: string;
  label: string;
  impressions: bigint;
  clicks: bigint;
  firstQuartiles: bigint;
  midpoints: bigint;
  thirdQuartiles: bigint;
  completions: bigint;
  costMillicents: bigint;
}

type Sums = Omit<SumRow, 'key' | 'label'>;

// Fixed SQL per grouping. Nothing from the request reaches these strings.
const GROUPING_SQL: Record<ReportGrouping, { key: string; label: string; order: string }> = {
  DAY: {
    key: `to_char((m.bucket AT TIME ZONE '${env.PLATFORM_TIMEZONE.replace(/'/g, "''")}')::date, 'YYYY-MM-DD')`,
    label: '',
    order: 'key ASC',
  },
  CAMPAIGN: { key: 'c.id', label: 'c.title', order: 'impressions DESC, label ASC' },
  SLOT: { key: 'm.slot::text', label: '', order: 'impressions DESC' },
  COUNTRY: { key: 'm.country', label: '', order: 'impressions DESC' },
  DEVICE: { key: 'm.device::text', label: '', order: 'impressions DESC' },
  SHOW: { key: 's.id', label: 's.title', order: 'impressions DESC, label ASC' },
};

const SLOT_NAMES: Record<string, string> = {
  PRE_ROLL: 'Pre-roll',
  MID_ROLL: 'Mid-roll',
  POST_ROLL: 'Post-roll',
};

const DEVICE_NAMES: Record<string, string> = {
  CTV: 'Connected TV',
  MOBILE: 'Mobile',
  WEB: 'Web',
  TABLET: 'Tablet',
};

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });

/** A readable name for a row, where the grouping has codes rather than titles. */
const labelFor = (groupBy: ReportGrouping, key: string, label: string): string => {
  if (groupBy === ReportGrouping.SLOT) return SLOT_NAMES[key] ?? key;
  if (groupBy === ReportGrouping.DEVICE) return DEVICE_NAMES[key] ?? key;
  if (groupBy === ReportGrouping.COUNTRY) {
    try {
      return countryNames.of(key) ?? key;
    } catch {
      return key;
    }
  }
  return label || key;
};

const rate = (part: bigint, whole: bigint): number =>
  whole > 0n ? (Number(part) / Number(whole)) * 100 : 0;

const valuesOf = (sums: Sums, columns: ReportColumn[]): ReportValues => {
  const impressions = Number(sums.impressions);
  const spend = Number(sums.costMillicents) / 100_000;
  const all: Record<Exclude<ReportColumn, 'reach' | 'averageFrequency'>, number> = {
    impressions,
    clicks: Number(sums.clicks),
    ctr: rate(sums.clicks, sums.impressions),
    firstQuartileRate: rate(sums.firstQuartiles, sums.impressions),
    midpointRate: rate(sums.midpoints, sums.impressions),
    thirdQuartileRate: rate(sums.thirdQuartiles, sums.impressions),
    completions: Number(sums.completions),
    completionRate: rate(sums.completions, sums.impressions),
    spend,
    ecpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
  };
  return Object.fromEntries(
    columns
      .filter((column) => column in all)
      .map((column) => [column, all[column as keyof typeof all]]),
  );
};

const withReach = (values: ReportValues, columns: ReportColumn[], reach: number): ReportValues => ({
  ...values,
  ...(columns.includes('reach') ? { reach } : {}),
  ...(columns.includes('averageFrequency')
    ? { averageFrequency: reach > 0 ? Math.max(1, (values.impressions ?? 0) / reach) : 0 }
    : {}),
});

/** The window a report covers: the last rangeDays up to the current hour. */
export const reportWindow = (rangeDays: number, now: Date): { from: Date; to: Date } => {
  const to = new Date(Math.ceil(now.getTime() / HOUR_MS) * HOUR_MS);
  return { from: new Date(to.getTime() - rangeDays * DAY_MS), to };
};

/**
 * The next time a schedule is due after a moment, on the hour in the platform
 * time zone. Walking hour by hour keeps it right across daylight saving changes.
 */
export const nextRunAfter = (
  report: Pick<Report, 'schedule' | 'sendHour' | 'sendWeekday'>,
  after: Date,
): Date | null => {
  if (report.schedule === ReportSchedule.NONE) return null;

  let time = Math.floor(after.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS;
  for (let step = 0; step < 8 * 24 + 2; step += 1, time += HOUR_MS) {
    const local = localTimeAt(time);
    if (local.hour !== report.sendHour) continue;
    if (report.schedule === ReportSchedule.WEEKLY && local.weekday !== report.sendWeekday) continue;
    return new Date(time);
  }
  return null;
};

export class ReportsService {
  /** Runs a report over the organisations the scope can see. */
  async run(
    scope: ReportScope,
    definition: ReportDefinition,
    now = new Date(),
  ): Promise<ReportResult> {
    const { from, to } = reportWindow(definition.rangeDays, now);
    const grouping = GROUPING_SQL[definition.groupBy];
    const organisation =
      scope.organisationId === undefined
        ? Prisma.sql`TRUE`
        : Prisma.sql`c.organisation_id = ${scope.organisationId}`;
    const campaigns =
      definition.campaignIds.length > 0
        ? Prisma.sql`c.id = ANY(${definition.campaignIds})`
        : Prisma.sql`TRUE`;
    const label = grouping.label ? Prisma.raw(grouping.label) : Prisma.raw(grouping.key);
    const showJoin =
      definition.groupBy === ReportGrouping.SHOW
        ? Prisma.sql`JOIN shows s ON s.id = m.show_id`
        : Prisma.empty;

    const rows = await prisma.$queryRaw<SumRow[]>(Prisma.sql`
      SELECT
        ${Prisma.raw(grouping.key)} AS key,
        ${label} AS label,
        SUM(m.impressions) AS impressions,
        SUM(m.clicks) AS clicks,
        SUM(m.first_quartiles) AS "firstQuartiles",
        SUM(m.midpoints) AS midpoints,
        SUM(m.third_quartiles) AS "thirdQuartiles",
        SUM(m.completions) AS completions,
        SUM(m.cost_millicents) AS "costMillicents"
      FROM metrics m
      JOIN campaigns c ON c.id = m.campaign_id
      ${showJoin}
      WHERE m.bucket >= ${from} AND m.bucket < ${to} AND ${organisation} AND ${campaigns}
      GROUP BY 1, 2
      ORDER BY ${Prisma.raw(grouping.order)}
    `);

    const { columns } = definition;
    const needsReach = columns.some(
      (column) => column === 'reach' || column === 'averageFrequency',
    );

    const reportRows = await Promise.all(
      rows.map(async (row) => {
        const values = valuesOf(row, columns);
        return {
          key: row.key,
          label: labelFor(definition.groupBy, row.key, row.label),
          values: needsReach
            ? withReach(values, columns, await reachBetween(row.key, from, to))
            : values,
        };
      }),
    );

    const sums = rows.reduce<Sums>(
      (total, row) => ({
        impressions: total.impressions + BigInt(row.impressions),
        clicks: total.clicks + BigInt(row.clicks),
        firstQuartiles: total.firstQuartiles + BigInt(row.firstQuartiles),
        midpoints: total.midpoints + BigInt(row.midpoints),
        thirdQuartiles: total.thirdQuartiles + BigInt(row.thirdQuartiles),
        completions: total.completions + BigInt(row.completions),
        costMillicents: total.costMillicents + BigInt(row.costMillicents),
      }),
      {
        impressions: 0n,
        clicks: 0n,
        firstQuartiles: 0n,
        midpoints: 0n,
        thirdQuartiles: 0n,
        completions: 0n,
        costMillicents: 0n,
      },
    );

    let totals = valuesOf(sums, columns);
    if (needsReach) {
      // Merging every campaign's sketches counts a viewer who saw two campaigns once.
      const keys = rows.flatMap((row) => dailyReachKeys(row.key, from, to));
      const reach =
        keys.length > 0 && keys.length <= MAX_REACH_KEYS
          ? await redis.pfcount(...(keys as [string, ...string[]]))
          : 0;
      totals = withReach(totals, columns, reach);
    }

    return { from, to, groupBy: definition.groupBy, columns, rows: reportRows, totals };
  }

  scopeOf(actor: Actor): ReportScope {
    return {
      organisationId: seesAllOrganisations(actor) ? undefined : (actor.organisationId ?? ''),
    };
  }

  async list(actor: Actor): Promise<Report[]> {
    if (!actor.organisationId) return [];
    return prisma.report.findMany({
      where: { organisationId: actor.organisationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOneOrFail(id: string, actor: Actor): Promise<Report> {
    const report = await prisma.report.findFirst({
      where: { id, organisationId: actor.organisationId ?? '' },
    });
    if (!report) throw new AppError(404, 'Report not found.');
    return report;
  }

  async create(actor: Actor, dto: SaveReportDto, now = new Date()): Promise<Report> {
    if (!actor.organisationId) throw new AppError(409, 'Choose an organisation first.');
    await this.assertOwned(actor.organisationId, dto);

    return prisma.report.create({
      data: {
        ...dto,
        organisationId: actor.organisationId,
        createdById: actor.sub,
        nextRunAt: nextRunAfter(dto, now),
      },
    });
  }

  async update(id: string, actor: Actor, dto: SaveReportDto, now = new Date()): Promise<Report> {
    const report = await this.findOneOrFail(id, actor);
    await this.assertOwned(report.organisationId, dto);

    return prisma.report.update({
      where: { id },
      data: { ...dto, nextRunAt: nextRunAfter(dto, now) },
    });
  }

  async remove(id: string, actor: Actor): Promise<Report> {
    await this.findOneOrFail(id, actor);
    return prisma.report.delete({ where: { id } });
  }

  /** Only managers change saved reports; everyone in the organisation can run them. */
  assertCanManage(actor: Actor): void {
    if (!canManageCampaigns(actor) || !actor.organisationId) {
      throw new AppError(403, 'Your role can run reports but not change saved ones.');
    }
  }

  /** Campaigns and recipients must belong to the report's organisation. */
  private async assertOwned(organisationId: string, dto: SaveReportDto): Promise<void> {
    const campaignIds = [...new Set(dto.campaignIds)];
    if (campaignIds.length > 0) {
      const owned = await prisma.campaign.count({
        where: { id: { in: campaignIds }, organisationId },
      });
      if (owned !== campaignIds.length) {
        throw new AppError(422, 'One of those campaigns was not found.');
      }
    }

    const recipientIds = [...new Set(dto.recipientIds)];
    if (recipientIds.length > 0) {
      const members = await prisma.membership.count({
        where: { userId: { in: recipientIds }, organisationId },
      });
      if (members !== recipientIds.length) {
        throw new AppError(422, 'Reports can only be sent to members of this organisation.');
      }
    }
  }
}

export const reportsService = new ReportsService();
