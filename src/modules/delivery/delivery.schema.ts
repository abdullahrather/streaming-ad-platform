/**
 * src/modules/delivery/delivery.schema.ts
 *
 * Zod schemas for the ad server endpoints.
 */
import { z } from 'zod';
import { AdSlot, Device } from '@prisma/client';
import { env } from '@/config/env';

const MAX_CLOCK_SKEW_MS = 5 * 60_000;

const placement = {
  showId: z.string().min(1),
  slot: z.enum(AdSlot),
  country: z.string().length(2).toUpperCase(),
  device: z.enum(Device),
};

export const adDecisionQuerySchema = z.object(placement);

/** Who's watching and which break this is, for limits that depend on them. */
export const adContextSchema = z.object({
  viewerId: z.string().min(1).max(64).optional(),
  breakId: z.string().min(1).max(64).optional(),
  consent: z.stringbool().optional(),
});

export type AdDecisionQuery = z.infer<typeof adDecisionQuerySchema>;

export const EVENT_TYPES = [
  'IMPRESSION',
  'FIRST_QUARTILE',
  'MIDPOINT',
  'THIRD_QUARTILE',
  'COMPLETION',
  'CLICK',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const eventSchema = z.object({
  ...placement,
  // The ID makes a retry safe: an event that was already counted is dropped.
  eventId: z.string({ error: 'Each event needs an eventId.' }).min(8).max(64),
  type: z.enum(EVENT_TYPES),
  campaignId: z.string().min(1),
  creativeId: z.string().min(1).max(64).optional(),
  viewerId: z.string().min(1).max(64).optional(),
  // Auctions can clear below the campaign's CPM. Without this, the CPM applies.
  priceCpmCents: z.number().int().positive().optional(),
  // Replays are only detectable inside the duplicate window, so older events are refused.
  occurredAt: z.coerce.date({ error: 'Each event needs occurredAt.' }).refine(
    (date) => {
      const age = Date.now() - date.getTime();
      return age < env.EVENT_DEDUPE_SECONDS * 1000 && age > -MAX_CLOCK_SKEW_MS;
    },
    { error: 'This event is too old, or dated in the future.' },
  ),
});

export const eventBatchSchema = z.object({
  events: z.array(eventSchema).min(1).max(1000),
});

export const playerTokenSchema = z.object({
  viewerId: z.string().min(1).max(64).optional(),
  // Interest profiles only exist for viewers who said yes.
  consent: z.boolean().default(false),
});

export type AdEvent = z.infer<typeof eventSchema>;
