/**
 * src/modules/reports/reports.schema.ts
 *
 * What a report contains, and when a saved one is emailed.
 */
import { z } from 'zod';
import { ReportGrouping, ReportSchedule } from '@prisma/client';

export const MAX_REPORT_DAYS = 90;

/** Every column a report can show, in the order they appear. */
export const REPORT_COLUMNS = [
  'impressions',
  'clicks',
  'ctr',
  'firstQuartileRate',
  'midpointRate',
  'thirdQuartileRate',
  'completions',
  'completionRate',
  'spend',
  'ecpm',
  'reach',
  'averageFrequency',
] as const;

export type ReportColumn = (typeof REPORT_COLUMNS)[number];

/** Unique viewers can't be added up across rows, so these only work one row per campaign. */
export const CAMPAIGN_ONLY_COLUMNS: ReportColumn[] = ['reach', 'averageFrequency'];

export const DEFAULT_COLUMNS: ReportColumn[] = [
  'impressions',
  'clicks',
  'ctr',
  'completionRate',
  'spend',
];

const definitionFields = {
  campaignIds: z.array(z.string().max(64)).max(200).default([]),
  groupBy: z.enum(ReportGrouping).default(ReportGrouping.DAY),
  columns: z
    .array(z.enum(REPORT_COLUMNS))
    .min(1, { error: 'Choose at least one column.' })
    .max(REPORT_COLUMNS.length)
    .default(DEFAULT_COLUMNS)
    .transform((columns) => REPORT_COLUMNS.filter((column) => columns.includes(column))),
  rangeDays: z.number().int().min(1).max(MAX_REPORT_DAYS).default(7),
};

const campaignOnlyCheck = {
  check: ({ groupBy, columns }: { groupBy: ReportGrouping; columns: ReportColumn[] }): boolean =>
    groupBy === ReportGrouping.CAMPAIGN ||
    !columns.some((column) => CAMPAIGN_ONLY_COLUMNS.includes(column)),
  error: 'Reach and average frequency need one row per campaign. Group by campaign to use them.',
};

export const reportDefinitionSchema = z
  .object(definitionFields)
  .refine(campaignOnlyCheck.check, { error: campaignOnlyCheck.error, path: ['columns'] });

export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;

const scheduleFields = {
  name: z.string({ error: 'Name is required.' }).trim().min(2).max(100),
  schedule: z.enum(ReportSchedule).default(ReportSchedule.NONE),
  sendWeekday: z.number().int().min(0).max(6).default(1),
  sendHour: z.number().int().min(0).max(23).default(8),
  recipientIds: z.array(z.string().max(64)).max(50).default([]),
};

export const saveReportSchema = z
  .object({ ...definitionFields, ...scheduleFields })
  .refine(campaignOnlyCheck.check, { error: campaignOnlyCheck.error, path: ['columns'] })
  .refine(({ schedule, recipientIds }) => schedule === 'NONE' || recipientIds.length > 0, {
    error: 'Choose who receives a scheduled report.',
    path: ['recipientIds'],
  });

export type SaveReportDto = z.infer<typeof saveReportSchema>;

export const exportFormatSchema = z.object({ format: z.enum(['csv', 'pdf']).default('csv') });
