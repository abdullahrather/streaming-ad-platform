/**
 * src/modules/ai/ai.tools.ts
 *
 * The only ways the assistant can see data. Every tool reads through the same
 * services as the dashboard, scoped to the person asking, so it can never see more
 * than they can. None of them change anything.
 *
 * Results leave out emails and internal user and organisation IDs, which the model
 * doesn't need.
 */
import { z } from 'zod';
import { CreativeStatus } from '@prisma/client';
import type { Actor } from '@/lib/actor';
import { prisma } from '@/lib/prisma';
import { reachBetween } from '@/lib/redis';
import { previousRange } from '@/modules/campaigns/campaigns.schema';
import { campaignsService } from '@/modules/campaigns/campaigns.service';
import { diagnosisService } from '@/modules/campaigns/diagnosis.service';
import { alertsService } from '@/modules/alerts/alerts.service';
import { REPORT_COLUMNS, reportDefinitionSchema } from '@/modules/reports/reports.schema';
import { reportsService } from '@/modules/reports/reports.service';
import type { AiTool } from './providers/types';

const DAY_MS = 86_400_000;
const round = (value: number, digits = 4): number => Number(value.toFixed(digits));
const date = (value: Date): string => value.toISOString().slice(0, 10);

const campaignIdSchema = z.object({ campaign_id: z.string().min(1).max(64) });

const object = (properties: Record<string, unknown>): Record<string, unknown> => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const buildTools = (actor: Actor, now = new Date()): AiTool[] => {
  const lastDays = (days: number): { from: Date; to: Date } => ({
    from: new Date(now.getTime() - days * DAY_MS),
    to: now,
  });

  return [
    {
      name: 'list_campaigns',
      description:
        'Lists the campaigns the user can see, with status, pacing, delivery against the goal, the last 7 days of results and spend. Use it to find a campaign by name before asking about it.',
      inputSchema: object({
        status: { type: 'string', enum: ['ANY', 'ACTIVE', 'PAUSED', 'COMPLETED'] },
      }),
      run: async (input): Promise<unknown> => {
        const { status } = z
          .object({ status: z.enum(['ANY', 'ACTIVE', 'PAUSED', 'COMPLETED']) })
          .parse(input);
        const rows = await campaignsService.getAnalytics(actor, lastDays(7));
        return rows
          .filter((row) => status === 'ANY' || row.status === status)
          .map((row) => ({
            campaign_id: row.id,
            title: row.title,
            advertiser: row.advertiser,
            status: row.status,
            pacing: row.pacing,
            delivery_type: row.deliveryType,
            flight: `${date(row.startsAt)} to ${date(row.endsAt)}`,
            impression_goal: row.impressionGoal,
            delivered: row.lifetimeImpressions,
            delivered_share: round(row.deliveryRate),
            last_7_days: {
              impressions: row.impressions,
              ctr: round(row.ctr),
              completion_rate: round(row.completionRate),
            },
            spend_eur: round(row.lifetimeSpendCents / 100, 2),
            budget_eur: round(row.budgetCents / 100, 2),
          }));
      },
    },
    {
      name: 'diagnose_campaign',
      description:
        "Works out from the campaign's own data whether it will reach its goal and what holds it back: the binding limit (matching traffic, budget, daily limits, frequency cap) and blockers such as being paused or having no approved ad. Use this for any question about why a campaign is behind or how it will finish.",
      inputSchema: object({ campaign_id: { type: 'string' } }),
      run: async (input): Promise<unknown> => {
        const { campaign_id } = campaignIdSchema.parse(input);
        return diagnosisService.diagnose(campaign_id, actor, now);
      },
    },
    {
      name: 'campaign_details',
      description:
        "One campaign's settings (targeting, schedule, pacing, limits, price), results for a recent period with the change against the period before, reach and average frequency, how results split by ad slot, device, country and show, and impressions per day.",
      inputSchema: object({
        campaign_id: { type: 'string' },
        days: { type: 'integer', minimum: 1, maximum: 90 },
      }),
      run: async (input): Promise<unknown> => {
        const { campaign_id, days } = campaignIdSchema
          .extend({ days: z.number().int().min(1).max(90) })
          .parse(input);
        const range = lastDays(days);
        const earlier = previousRange(range);
        const campaign = await campaignsService.findOneOrFail(campaign_id, actor);
        const [current, previous, breakdown, timeseries, reach, creatives] = await Promise.all([
          campaignsService.getPeriodTotals(actor, range, campaign_id),
          campaignsService.getPeriodTotals(actor, earlier, campaign_id),
          campaignsService.getBreakdown(campaign_id, actor, range),
          campaignsService.getTimeseries(actor, { from: range.from, to: range.to }, campaign_id),
          reachBetween(campaign_id, range.from, range.to),
          prisma.creative.groupBy({
            by: ['status'],
            where: { campaignId: campaign_id },
            _count: { _all: true },
          }),
        ]);
        const summarise = (totals: typeof current): Record<string, number> => ({
          impressions: totals.impressions,
          clicks: totals.clicks,
          ctr: round(totals.ctr),
          completion_rate: round(totals.completionRate),
          spend_eur: round(totals.spendCents / 100, 2),
        });
        const top = (rows: typeof breakdown.slot): Array<Record<string, unknown>> =>
          rows.slice(0, 6).map((row) => ({
            key: row.key,
            impressions: row.impressions,
            ctr: round(row.ctr),
            completion_rate: round(row.completionRate),
          }));
        return {
          title: campaign.title,
          advertiser: campaign.advertiser,
          status: campaign.status,
          settings: {
            flight: `${date(campaign.startsAt)} to ${date(campaign.endsAt)}`,
            impression_goal: campaign.impressionGoal,
            budget_eur: campaign.budgetCents / 100,
            cpm_eur: campaign.cpmCents / 100,
            delivery_type: campaign.deliveryType,
            pacing_mode: campaign.pacingMode,
            daily_budget_eur: campaign.dailyBudgetCents ? campaign.dailyBudgetCents / 100 : null,
            daily_impression_target: campaign.dailyImpressionTarget,
            frequency_cap_per_day: campaign.frequencyCapPerDay,
            countries: campaign.targetCountries.length ? campaign.targetCountries : 'all',
            genres: campaign.targetGenres.length ? campaign.targetGenres : 'all',
            devices: campaign.targetDevices.length ? campaign.targetDevices : 'all',
            ad_slots: campaign.targetSlots.length ? campaign.targetSlots : 'all',
            audiences: campaign.targetSegmentIds.length,
            active_hours: campaign.activeHours.length ? campaign.activeHours : 'all',
            active_days: campaign.activeDays.length ? campaign.activeDays : 'all',
            competitive_category: campaign.competitiveCategory || null,
            approved_ads:
              creatives.find(({ status }) => status === CreativeStatus.APPROVED)?._count._all ?? 0,
          },
          period: { days, ...summarise(current) },
          previous_period: summarise(previous),
          reach,
          average_frequency: reach > 0 ? round(current.impressions / reach, 2) : 0,
          by_slot: top(breakdown.slot),
          by_device: top(breakdown.device),
          by_country: top(breakdown.country),
          by_show: top(breakdown.show),
          impressions_by_time: timeseries.map((point) => ({
            time: point.time,
            impressions: point.impressions,
          })),
        };
      },
    },
    {
      name: 'run_report',
      description:
        'Runs a report over the last N days, with rows grouped by day, campaign, ad slot, country, device or show. Leave campaign_ids empty for every campaign. Reach and average frequency need group_by CAMPAIGN.',
      inputSchema: object({
        group_by: {
          type: 'string',
          enum: ['DAY', 'CAMPAIGN', 'SLOT', 'COUNTRY', 'DEVICE', 'SHOW'],
        },
        columns: { type: 'array', items: { type: 'string', enum: [...REPORT_COLUMNS] } },
        days: { type: 'integer', minimum: 1, maximum: 90 },
        campaign_ids: { type: 'array', items: { type: 'string' } },
      }),
      run: async (input): Promise<unknown> => {
        const raw = z
          .object({
            group_by: z.string(),
            columns: z.array(z.string()),
            days: z.number(),
            campaign_ids: z.array(z.string()),
          })
          .parse(input);
        const definition = reportDefinitionSchema.parse({
          groupBy: raw.group_by,
          columns: raw.columns,
          rangeDays: raw.days,
          campaignIds: raw.campaign_ids,
        });
        const result = await reportsService.run(reportsService.scopeOf(actor), definition, now);
        return { ...result, rows: result.rows.slice(0, 60) };
      },
    },
    {
      name: 'list_alerts',
      description:
        'Campaign alerts: delivery behind schedule, budget running out early, or a sudden drop in impressions.',
      inputSchema: object({ open_only: { type: 'boolean' } }),
      run: async (input): Promise<unknown> => {
        const { open_only } = z.object({ open_only: z.boolean() }).parse(input);
        const alerts = await alertsService.list(actor, { open: open_only });
        return alerts.slice(0, 30).map((alert) => ({
          campaign_id: alert.campaignId,
          campaign: alert.campaign.title,
          type: alert.type,
          message: alert.message,
          opened_at: alert.openedAt,
          resolved_at: alert.resolvedAt,
        }));
      },
    },
  ];
};
