/**
 * src/modules/alerts/alerts.service.ts
 *
 * Watches running campaigns for three problems: delivery falling behind, budget
 * running out early, and a sudden drop in traffic. An alert opens once, emails
 * the members who want alerts, and resolves when the problem clears. Opening and
 * resolving use separate thresholds, so an alert doesn't flicker around one value.
 *
 * At most one alert per campaign and type can be open, enforced by a partial
 * unique index, so several processes checking at once never email twice.
 */
import crypto from 'node:crypto';
import { AlertType, Prisma, type Alert } from '@prisma/client';
import { env } from '@/config/env';
import { seesAllOrganisations, type Actor } from '@/lib/actor';
import { deliverEmail } from '@/lib/mailer';
import { localTimeAt } from '@/lib/platform-time';
import { prisma } from '@/lib/prisma';
import { redis, viewKeys } from '@/lib/redis';
import { logger } from '@/lib/logger';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const ALERT_RULES = {
  /** Delivery is judged once a campaign has run this long. */
  underDeliveryAfterMs: DAY_MS,
  underDeliveryOpenBelow: 0.8,
  underDeliveryResolveAt: 0.9,
  /** Budget burn uses the spend rate over this window. */
  burnWindowMs: DAY_MS,
  /** Ignore burn until a campaign has spent at least this share of its budget recently. */
  burnMinRecentShare: 0.01,
  /** Sudden drops compare the last complete hours with the same hours on earlier days. */
  dropWindowHours: 2,
  dropBaselineDays: 3,
  /** Too little traffic to judge a drop below this many impressions per window. */
  dropMinBaseline: 60,
  dropOpenBelow: 0.5,
  dropResolveAt: 0.75,
} as const;

export const ALERT_LABELS: Record<AlertType, string> = {
  UNDER_DELIVERY: 'Delivery behind schedule',
  BUDGET_BURN: 'Budget running out early',
  SUDDEN_DROP: 'Sudden drop in impressions',
};

export type AlertWithCampaign = Alert & { campaign: { title: string; advertiser: string } };

interface CampaignState {
  id: string;
  organisationId: string;
  title: string;
  impressionGoal: number;
  budgetCents: number;
  startsAt: Date;
  endsAt: Date;
  dailyBudgetCents: number | null;
  dailyImpressionTarget: number | null;
  activeHours: number[];
  activeDays: number[];
  delivered: bigint;
  spentMillicents: bigint;
  recentImpressions: bigint;
  recentMillicents: bigint;
  windowImpressions: bigint;
  baselineImpressions: bigint;
}

/** What one check found: open with this message, clear, or not judged this time. */
type Finding =
  | { state: 'open'; message: string; details: Record<string, number | string> }
  | { state: 'clear' }
  | { state: 'unknown' };

const formatNumber = (value: number): string => Math.round(value).toLocaleString('en-GB');

const formatDay = (time: number): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: env.PLATFORM_TIMEZONE,
    day: 'numeric',
    month: 'short',
  }).format(time);

const inSchedule = (campaign: CampaignState, time: number): boolean => {
  const local = localTimeAt(time);
  return (
    (campaign.activeHours.length === 0 || campaign.activeHours.includes(local.hour)) &&
    (campaign.activeDays.length === 0 || campaign.activeDays.includes(local.weekday))
  );
};

const underDelivery = (campaign: CampaignState, now: number, isOpen: boolean): Finding => {
  const elapsed = now - campaign.startsAt.getTime();
  if (elapsed < ALERT_RULES.underDeliveryAfterMs) return { state: 'unknown' };

  const flight = campaign.endsAt.getTime() - campaign.startsAt.getTime();
  const expected = campaign.impressionGoal * Math.min(1, elapsed / flight);
  const delivered = Number(campaign.delivered);
  const position = expected > 0 ? delivered / expected : 1;
  const threshold = isOpen
    ? ALERT_RULES.underDeliveryResolveAt
    : ALERT_RULES.underDeliveryOpenBelow;
  if (position >= threshold) return { state: 'clear' };

  return {
    state: 'open',
    message: `Delivery is behind: ${formatNumber(delivered)} of the ${formatNumber(expected)} impressions expected by now (${Math.round(position * 100)}%).`,
    details: { delivered, expected: Math.round(expected), position },
  };
};

const budgetBurn = (campaign: CampaignState, now: number): Finding => {
  const budget = campaign.budgetCents * 1000;
  const spent = Number(campaign.spentMillicents);
  const recent = Number(campaign.recentMillicents);
  if (recent < budget * ALERT_RULES.burnMinRecentShare) return { state: 'clear' };

  let spendPerMs = recent / ALERT_RULES.burnWindowMs;
  if (campaign.dailyBudgetCents)
    spendPerMs = Math.min(spendPerMs, (campaign.dailyBudgetCents * 1000) / DAY_MS);
  const runsOutAt = now + Math.max(0, budget - spent) / spendPerMs;

  const impressionsPerMs = Number(campaign.recentImpressions) / ALERT_RULES.burnWindowMs;
  const remaining = campaign.impressionGoal - Number(campaign.delivered);
  const goalAt = impressionsPerMs > 0 ? now + Math.max(0, remaining) / impressionsPerMs : Infinity;
  const endsAt = campaign.endsAt.getTime();

  if (runsOutAt >= endsAt || runsOutAt >= goalAt) return { state: 'clear' };

  const daysEarly = Math.max(1, Math.round((endsAt - runsOutAt) / DAY_MS));
  return {
    state: 'open',
    message: `At the last day's spend rate the budget runs out on ${formatDay(runsOutAt)}, about ${daysEarly} day${daysEarly === 1 ? '' : 's'} before the campaign ends.`,
    details: {
      runsOutAt: new Date(runsOutAt).toISOString(),
      daysEarly,
      spentCents: Math.round(spent / 1000),
    },
  };
};

const suddenDrop = async (
  campaign: CampaignState,
  now: number,
  windowEnd: number,
  baselineDays: number,
  isOpen: boolean,
): Promise<Finding> => {
  if (baselineDays === 0) return { state: 'unknown' };

  // Hours outside the schedule, or after a daily limit, are expected to be quiet.
  const windowHours = Array.from(
    { length: ALERT_RULES.dropWindowHours },
    (_, index) => windowEnd - (index + 1) * HOUR_MS,
  );
  if (!windowHours.every((hour) => inSchedule(campaign, hour))) return { state: 'unknown' };
  if (campaign.dailyImpressionTarget || campaign.dailyBudgetCents) {
    const keys = viewKeys(campaign.id, localTimeAt(now).day);
    const [served, spent] = await redis.mget(keys.dailyServed, keys.dailySpent);
    if (
      campaign.dailyImpressionTarget &&
      Number(served ?? 0) >= campaign.dailyImpressionTarget * 0.95
    )
      return { state: 'unknown' };
    if (campaign.dailyBudgetCents && Number(spent ?? 0) >= campaign.dailyBudgetCents * 1000 * 0.95)
      return { state: 'unknown' };
  }

  const baseline = Number(campaign.baselineImpressions) / baselineDays;
  if (baseline < ALERT_RULES.dropMinBaseline) return { state: 'unknown' };

  const current = Number(campaign.windowImpressions);
  const share = current / baseline;
  const threshold = isOpen ? ALERT_RULES.dropResolveAt : ALERT_RULES.dropOpenBelow;
  if (share >= threshold) return { state: 'clear' };

  return {
    state: 'open',
    message: `Impressions fell ${Math.round((1 - share) * 100)}% in the last ${ALERT_RULES.dropWindowHours} hours: ${formatNumber(current)} against about ${formatNumber(baseline)} at the same time on previous days.`,
    details: { current, baseline: Math.round(baseline), share },
  };
};

/** With the AI assistant on, a short explanation goes with the alert. Loaded lazily, since the
 * assistant's tools read alerts too. */
const explain = async (alert: Alert, title: string): Promise<string | null> => {
  const { aiService } = await import('@/modules/ai/ai.service');
  const explanation = await aiService.explainAlert(alert, title);
  if (explanation) {
    const details = (alert.details ?? {}) as Prisma.JsonObject;
    await prisma.alert.update({
      where: { id: alert.id },
      data: { details: { ...details, explanation } },
    });
  }
  return explanation;
};

const notify = async (alert: Alert, title: string): Promise<void> => {
  const members = await prisma.membership.findMany({
    where: { organisationId: alert.organisationId, alertEmails: true, user: { suspendedAt: null } },
    include: { user: { select: { email: true } } },
  });
  const explanation = await explain(alert, title).catch(() => null);
  for (const { user } of members) {
    await deliverEmail({
      to: user.email,
      subject: `Alert: ${title} – ${ALERT_LABELS[alert.type].toLowerCase()}`,
      body: `${ALERT_LABELS[alert.type]} on “${title}”.\n\n${alert.message}${explanation ? `\n\nWhy (written by the AI assistant from your data): ${explanation}` : ''}\n\nYou get these emails because campaign alerts are on in your account settings.`,
      link: `${env.APP_URL}/#/campaigns/${alert.campaignId}`,
    });
  }
};

export class AlertsService {
  /** Checks every running campaign once. Returns how many alerts it opened. */
  async check(now = new Date()): Promise<number> {
    const time = now.getTime();
    const windowEnd = Math.floor(time / HOUR_MS) * HOUR_MS;
    const windowStart = windowEnd - ALERT_RULES.dropWindowHours * HOUR_MS;
    const baselineWindows = Array.from({ length: ALERT_RULES.dropBaselineDays }, (_, index) => {
      const shift = (index + 1) * DAY_MS;
      return Prisma.sql`(m.bucket >= ${new Date(windowStart - shift)} AND m.bucket < ${new Date(windowEnd - shift)})`;
    });

    const campaigns = await prisma.$queryRaw<CampaignState[]>(Prisma.sql`
      SELECT
        c.id,
        c.organisation_id AS "organisationId",
        c.title,
        c.impression_goal AS "impressionGoal",
        c.budget_cents AS "budgetCents",
        c.starts_at AS "startsAt",
        c.ends_at AS "endsAt",
        c.daily_budget_cents AS "dailyBudgetCents",
        c.daily_impression_target AS "dailyImpressionTarget",
        c.active_hours AS "activeHours",
        c.active_days AS "activeDays",
        COALESCE(SUM(m.impressions), 0) AS delivered,
        COALESCE(SUM(m.cost_millicents), 0) AS "spentMillicents",
        COALESCE(SUM(m.impressions) FILTER (WHERE m.bucket >= ${new Date(time - ALERT_RULES.burnWindowMs)}), 0) AS "recentImpressions",
        COALESCE(SUM(m.cost_millicents) FILTER (WHERE m.bucket >= ${new Date(time - ALERT_RULES.burnWindowMs)}), 0) AS "recentMillicents",
        COALESCE(SUM(m.impressions) FILTER (WHERE m.bucket >= ${new Date(windowStart)} AND m.bucket < ${new Date(windowEnd)}), 0) AS "windowImpressions",
        COALESCE(SUM(m.impressions) FILTER (WHERE ${Prisma.join(baselineWindows, ' OR ')}), 0) AS "baselineImpressions"
      FROM campaigns c
      JOIN organisations o ON o.id = c.organisation_id AND o.suspended_at IS NULL
      LEFT JOIN metrics m ON m.campaign_id = c.id
      WHERE c.status = 'ACTIVE' AND c.starts_at <= ${now} AND c.ends_at > ${now}
      GROUP BY c.id
    `);

    const runningIds = campaigns.map(({ id }) => id);
    // Alerts on campaigns that stopped running no longer apply.
    await prisma.alert.updateMany({
      where: { resolvedAt: null, campaignId: { notIn: runningIds } },
      data: { resolvedAt: now },
    });

    const open = await prisma.alert.findMany({
      where: { resolvedAt: null, campaignId: { in: runningIds } },
      select: { campaignId: true, type: true },
    });
    const isOpen = (campaignId: string, type: AlertType): boolean =>
      open.some((alert) => alert.campaignId === campaignId && alert.type === type);

    let opened = 0;
    for (const campaign of campaigns) {
      const baselineDays = Array.from(
        { length: ALERT_RULES.dropBaselineDays },
        (_, index) => index + 1,
      ).filter((day) => windowStart - day * DAY_MS >= campaign.startsAt.getTime()).length;

      const findings: Array<[AlertType, Finding]> = [
        [
          AlertType.UNDER_DELIVERY,
          underDelivery(campaign, time, isOpen(campaign.id, AlertType.UNDER_DELIVERY)),
        ],
        [AlertType.BUDGET_BURN, budgetBurn(campaign, time)],
        [
          AlertType.SUDDEN_DROP,
          await suddenDrop(
            campaign,
            time,
            windowEnd,
            baselineDays,
            isOpen(campaign.id, AlertType.SUDDEN_DROP),
          ),
        ],
      ];

      for (const [type, finding] of findings) {
        if (finding.state === 'clear') {
          await prisma.alert.updateMany({
            where: { campaignId: campaign.id, type, resolvedAt: null },
            data: { resolvedAt: now },
          });
        } else if (finding.state === 'open') {
          if (await this.open(campaign, type, finding, now)) opened += 1;
        }
      }
    }
    return opened;
  }

  /** Opens an alert, or refreshes the message of the one already open. True if it's new. */
  private async open(
    campaign: CampaignState,
    type: AlertType,
    finding: Extract<Finding, { state: 'open' }>,
    now: Date,
  ): Promise<boolean> {
    const details = JSON.stringify(finding.details);
    const [created] = await prisma.$queryRaw<Alert[]>(Prisma.sql`
      INSERT INTO alerts (id, organisation_id, campaign_id, type, message, details, opened_at)
      VALUES (${crypto.randomUUID()}, ${campaign.organisationId}, ${campaign.id},
              ${type}::"AlertType", ${finding.message}, ${details}::jsonb, ${now})
      ON CONFLICT (campaign_id, type) WHERE resolved_at IS NULL DO NOTHING
      RETURNING id, organisation_id AS "organisationId", campaign_id AS "campaignId", type,
                message, details, opened_at AS "openedAt", resolved_at AS "resolvedAt"
    `);

    if (!created) {
      // Fresh numbers, keeping the AI explanation written when the alert opened.
      await prisma.$executeRaw`
        UPDATE alerts
        SET message = ${finding.message},
            details = ${details}::jsonb
              || jsonb_strip_nulls(jsonb_build_object('explanation', details -> 'explanation'))
        WHERE campaign_id = ${campaign.id} AND type = ${type}::"AlertType" AND resolved_at IS NULL
      `;
      return false;
    }

    await notify(created, campaign.title).catch((error: unknown) =>
      logger.error({ err: String(error) }, `Alert email for ${campaign.id} failed`),
    );
    return true;
  }

  /** Recent alerts the actor can see, newest first. */
  async list(
    actor: Actor,
    { open, campaignId }: { open?: boolean; campaignId?: string } = {},
  ): Promise<AlertWithCampaign[]> {
    return prisma.alert.findMany({
      where: {
        ...(seesAllOrganisations(actor) ? {} : { organisationId: actor.organisationId ?? '' }),
        ...(open ? { resolvedAt: null } : {}),
        ...(campaignId ? { campaignId } : {}),
      },
      include: { campaign: { select: { title: true, advertiser: true } } },
      orderBy: [{ resolvedAt: { sort: 'desc', nulls: 'first' } }, { openedAt: 'desc' }],
      take: 100,
    });
  }
}

export const alertsService = new AlertsService();
