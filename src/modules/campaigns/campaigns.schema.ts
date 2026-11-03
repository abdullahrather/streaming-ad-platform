/**
 * src/modules/campaigns/campaigns.schema.ts
 *
 * Zod schemas for campaign-related requests.
 */
import { z } from 'zod';
import { AdSlot, CampaignStatus, DeliveryType, Device, PacingMode } from '@prisma/client';

const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;

const countryList = z.array(z.string().length(2).toUpperCase()).max(50);

const campaignFields = {
  title: z
    .string({ error: 'Title is required.' })
    .trim()
    .min(3, { error: 'Title must be at least 3 characters.' })
    .max(255, { error: 'Title must be at most 255 characters.' }),
  advertiser: z.string({ error: 'Advertiser is required.' }).trim().min(2).max(255),
  budgetCents: z.number({ error: 'Budget is required.' }).int().positive(),
  cpmCents: z.number({ error: 'CPM is required.' }).int().positive(),
  impressionGoal: z.number({ error: 'Impression goal is required.' }).int().positive(),
  startsAt: z.coerce.date({ error: 'Start date is required.' }),
  endsAt: z.coerce.date({ error: 'End date is required.' }),
};

const targeting = {
  targetCountries: countryList,
  targetGenres: z.array(z.string().trim().min(1)).max(50),
  targetDevices: z.array(z.enum(Device)),
  targetSlots: z.array(z.enum(AdSlot)),
};

/** Delivery rules. Nullable fields turn a limit off. */
const delivery = {
  targetSegmentIds: z.array(z.string().min(1)).max(20),
  deliveryType: z.enum(DeliveryType),
  pacingMode: z.enum(PacingMode),
  dailyBudgetCents: z.number().int().positive().nullable(),
  dailyImpressionTarget: z.number().int().positive().nullable(),
  frequencyCapPerDay: z.number().int().positive().max(100).nullable(),
  activeHours: z.array(z.number().int().min(0).max(23)).max(24),
  activeDays: z.array(z.number().int().min(0).max(6)).max(7),
  competitiveCategory: z.string().trim().max(60),
};

const deliveryDefaults = {
  targetSegmentIds: delivery.targetSegmentIds.default([]),
  deliveryType: delivery.deliveryType.default(DeliveryType.GUARANTEED),
  pacingMode: delivery.pacingMode.default(PacingMode.ASAP),
  dailyBudgetCents: delivery.dailyBudgetCents.default(null),
  dailyImpressionTarget: delivery.dailyImpressionTarget.default(null),
  frequencyCapPerDay: delivery.frequencyCapPerDay.default(null),
  activeHours: delivery.activeHours.default([]),
  activeDays: delivery.activeDays.default([]),
  competitiveCategory: delivery.competitiveCategory.default(''),
};

export const hasDailyTarget = (value: {
  pacingMode?: PacingMode | undefined;
  dailyImpressionTarget?: number | null | undefined;
}): boolean => value.pacingMode !== PacingMode.CUSTOM || Boolean(value.dailyImpressionTarget);

export const DAILY_TARGET_ERROR = {
  error: 'Custom pacing needs a daily impression target.',
  path: ['dailyImpressionTarget'],
};

const datesInOrder = (value: { startsAt?: Date | undefined; endsAt?: Date | undefined }): boolean =>
  !value.startsAt || !value.endsAt || value.endsAt > value.startsAt;

const DATE_ORDER_ERROR = { error: 'End date must be after the start date.', path: ['endsAt'] };

export const createCampaignSchema = z
  .object({
    ...campaignFields,
    status: z.enum([CampaignStatus.ACTIVE, CampaignStatus.PAUSED]).default(CampaignStatus.ACTIVE),
    targetCountries: targeting.targetCountries.default([]),
    targetGenres: targeting.targetGenres.default([]),
    targetDevices: targeting.targetDevices.default([]),
    targetSlots: targeting.targetSlots.default([]),
    ...deliveryDefaults,
  })
  .refine(datesInOrder, DATE_ORDER_ERROR)
  .refine(hasDailyTarget, DAILY_TARGET_ERROR);

export type CreateCampaignDto = z.infer<typeof createCampaignSchema>;

/** The same details, before a campaign exists. */
export const forecastSchema = createCampaignSchema;

export type ForecastDto = z.infer<typeof forecastSchema>;

export const updateCampaignSchema = z
  .object({
    ...campaignFields,
    ...targeting,
    ...delivery,
    status: z.enum([CampaignStatus.ACTIVE, CampaignStatus.PAUSED]),
  })
  .partial()
  .refine(datesInOrder, DATE_ORDER_ERROR);

export type UpdateCampaignDto = z.infer<typeof updateCampaignSchema>;

// ── Query parameter schemas ───────────────────────────────────────────────────

export const listCampaignsQuerySchema = z.object({
  status: z.enum(CampaignStatus).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export type ListCampaignsQuery = z.infer<typeof listCampaignsQuerySchema>;

/** Date window for analytics. Defaults to the last 7 days. */
export const dateRangeSchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .transform(({ from, to }) => {
    const end = to ?? new Date();
    return { from: from ?? new Date(end.getTime() - 7 * DAY_MS), to: end };
  })
  .refine(({ from, to }) => from < to, { error: '"from" must be before "to".', path: ['from'] })
  .refine(({ from, to }) => to.getTime() - from.getTime() <= MAX_RANGE_DAYS * DAY_MS, {
    error: `The date range can be at most ${MAX_RANGE_DAYS} days.`,
    path: ['from'],
  });

export type DateRange = z.infer<typeof dateRangeSchema>;
