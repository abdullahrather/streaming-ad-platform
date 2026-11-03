/**
 * src/modules/creatives/creatives.schema.ts
 *
 * Zod schemas for video ads.
 */
import { z } from 'zod';
import { CreativeStatus } from '@prisma/client';

export const uploadCreativeSchema = z.object({
  campaignId: z.string({ error: 'Choose a campaign.' }).min(1),
  name: z.string({ error: 'Name is required.' }).trim().min(2).max(120),
  // Only web addresses, because viewers are redirected here when they click.
  clickUrl: z.url({
    protocol: /^https?$/,
    error: 'Enter a full web address starting with http:// or https://.',
  }),
});

export const updateCreativeSchema = z.object({ weight: z.number().int().min(0).max(100) });

export const campaignQuerySchema = z.object({ campaignId: z.string().min(1) });

export const reviewQueueSchema = z.object({
  status: z.enum(CreativeStatus).default(CreativeStatus.PENDING_REVIEW),
});

export const reviewSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('APPROVE') }),
  z.object({
    decision: z.literal('REJECT'),
    reason: z.string({ error: 'Explain why.' }).trim().min(5).max(500),
  }),
]);

export type UploadCreativeDto = z.infer<typeof uploadCreativeSchema>;
export type ReviewDto = z.infer<typeof reviewSchema>;
