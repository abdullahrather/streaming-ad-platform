/**
 * src/modules/reports/report-delivery.ts
 *
 * Emails saved reports on their schedule, with the CSV and PDF attached. Each
 * due report is claimed by moving its next run time forward in one conditional
 * update, so when several API processes check at once only one of them sends it.
 */
import { ReportSchedule, type Report } from '@prisma/client';
import { env } from '@/config/env';
import { deliverEmail } from '@/lib/mailer';
import { prisma } from '@/lib/prisma';
import { toCsv, toPdf, periodLabel } from './reports.export';
import { nextRunAfter, reportWindow, reportsService } from './reports.service';

const DUE_BATCH = 20;

const formatNumber = (value: number): string => Math.round(value).toLocaleString('en-GB');
const formatEuros = (value: number): string =>
  `€${value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "+12% on the previous 7 days", or nothing when there's no earlier figure to compare. */
const change = (current: number, previous: number, days: number): string => {
  if (previous <= 0) return '';
  const percent = Math.round(((current - previous) / previous) * 100);
  const sign = percent > 0 ? '+' : '';
  return ` (${sign}${percent}% on the previous ${days} day${days === 1 ? '' : 's'})`;
};

const fileStem = (report: Report, to: Date): string =>
  `${
    report.name
      .replace(/[^\w-]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'report'
  }-${to.toISOString().slice(0, 10)}`;

/** Sends one report to its recipients who are still members. Returns how many got it. */
export const sendReport = async (report: Report, now = new Date()): Promise<number> => {
  const scope = { organisationId: report.organisationId };
  const definition = {
    campaignIds: report.campaignIds,
    groupBy: report.groupBy,
    columns: report.columns as Parameters<typeof reportsService.run>[1]['columns'],
    rangeDays: report.rangeDays,
  };
  const summaryColumns = ['impressions', 'clicks', 'ctr', 'completionRate', 'spend'] as const;

  const { from } = reportWindow(report.rangeDays, now);
  const earlier = new Date(from.getTime() - 1);
  const [result, current, previous, organisation, members, alerts] = await Promise.all([
    reportsService.run(scope, definition, now),
    reportsService.run(scope, { ...definition, columns: [...summaryColumns] }, now),
    reportsService.run(scope, { ...definition, columns: [...summaryColumns] }, earlier),
    prisma.organisation.findUnique({ where: { id: report.organisationId } }),
    prisma.membership.findMany({
      where: { organisationId: report.organisationId, userId: { in: report.recipientIds } },
      include: { user: { select: { email: true, suspendedAt: true } } },
    }),
    prisma.alert.findMany({
      where: {
        organisationId: report.organisationId,
        resolvedAt: null,
        ...(report.campaignIds.length > 0 ? { campaignId: { in: report.campaignIds } } : {}),
      },
      include: { campaign: { select: { title: true } } },
      orderBy: { openedAt: 'desc' },
      take: 10,
    }),
  ]);

  const recipients = members.filter(({ user }) => !user.suspendedAt).map(({ user }) => user.email);
  if (recipients.length === 0 || !organisation) return 0;

  const totals = current.totals;
  const before = previous.totals;
  const days = report.rangeDays;
  const kind =
    report.schedule === ReportSchedule.WEEKLY
      ? 'Weekly report'
      : report.schedule === ReportSchedule.DAILY
        ? 'Daily report'
        : 'Report';
  const lines = [
    `${kind}: ${report.name}`,
    `${organisation.name} · ${periodLabel(result)}`,
    '',
    `Impressions: ${formatNumber(totals.impressions ?? 0)}${change(totals.impressions ?? 0, before.impressions ?? 0, days)}`,
    `Clicks: ${formatNumber(totals.clicks ?? 0)}${change(totals.clicks ?? 0, before.clicks ?? 0, days)}`,
    `Click-through rate: ${(totals.ctr ?? 0).toFixed(2)}%`,
    `Completion rate: ${(totals.completionRate ?? 0).toFixed(1)}%`,
    `Spend: ${formatEuros(totals.spend ?? 0)}${change(totals.spend ?? 0, before.spend ?? 0, days)}`,
    '',
    alerts.length === 0
      ? 'No open alerts.'
      : `Open alerts (${alerts.length}):\n${alerts.map((alert) => `- ${alert.campaign.title}: ${alert.message}`).join('\n')}`,
    '',
    'The full report is attached as CSV and PDF.',
  ];

  const stem = fileStem(report, result.to);
  const pdf = await toPdf(result, {
    title: report.name,
    organisation: organisation.name,
    generatedAt: now,
  });
  const attachments = [
    {
      filename: `${stem}.csv`,
      contentType: 'text/csv',
      content: Buffer.from(toCsv(result), 'utf8'),
    },
    { filename: `${stem}.pdf`, contentType: 'application/pdf', content: pdf },
  ];

  for (const to of recipients) {
    await deliverEmail({
      to,
      subject: `${kind}: ${report.name}`,
      body: lines.join('\n'),
      link: `${env.APP_URL}/#/reports/${report.id}`,
      attachments,
    });
  }
  await prisma.report.update({ where: { id: report.id }, data: { lastSentAt: now } });
  return recipients.length;
};

/**
 * Claims a due report by moving its next run forward, then sends it. The claim only
 * succeeds while the next run is still the one this process read, so when two
 * processes load the same due report only one of them sends it.
 */
export const claimAndSend = async (report: Report, now = new Date()): Promise<boolean> => {
  const claimed = await prisma.report.updateMany({
    where: { id: report.id, nextRunAt: report.nextRunAt },
    data: { nextRunAt: nextRunAfter(report, now) },
  });
  if (claimed.count === 0) return false;

  try {
    return (await sendReport(report, now)) > 0;
  } catch (error) {
    console.error(`Report ${report.id} failed:`, String(error));
    return false;
  }
};

/** Sends every report that's due. Safe to call from several processes at once. */
export const runDueReports = async (now = new Date()): Promise<number> => {
  const due = await prisma.report.findMany({
    where: { schedule: { not: ReportSchedule.NONE }, nextRunAt: { lte: now } },
    orderBy: { nextRunAt: 'asc' },
    take: DUE_BATCH,
  });

  let sent = 0;
  for (const report of due) {
    if (await claimAndSend(report, now)) sent += 1;
  }
  return sent;
};
