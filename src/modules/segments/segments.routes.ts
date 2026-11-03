/**
 * src/modules/segments/segments.routes.ts
 *
 * Audience segments, which belong to an organisation. A segment describes
 * interests, never individuals, and only ever matches viewers who consented.
 */
import { Router } from 'express';
import { z } from 'zod';
import { actorOf, contextOf, handle } from '@/lib/http';
import { prisma } from '@/lib/prisma';
import { authenticate, requireWriteAccess } from '@/middleware/authenticate';
import { AppError } from '@/middleware/errorHandler';
import { auditService } from '@/modules/audit/audit.service';
import { decisionCache } from '@/modules/delivery/decision-cache';

export const createSegmentSchema = z.object({
  name: z.string({ error: 'Name is required.' }).trim().min(2).max(100),
  genres: z.array(z.string().trim().min(1)).min(1, { error: 'Choose at least one genre.' }).max(50),
  minViews: z.number().int().min(1).max(100).default(3),
});

const segmentsRouter = Router();

segmentsRouter.use(authenticate);

segmentsRouter.get(
  '/',
  handle(async (req, res) => {
    const { organisationId } = actorOf(req);
    const data = await prisma.audienceSegment.findMany({
      where: { organisationId: organisationId ?? '' },
      orderBy: { createdAt: 'desc' },
    });
    res.status(200).json({ status: 'success', data });
  }),
);

segmentsRouter.post(
  '/',
  requireWriteAccess,
  handle(async (req, res) => {
    const actor = actorOf(req);
    if (!actor.organisationId) throw new AppError(409, 'Choose an organisation first.');

    const dto = createSegmentSchema.parse(req.body);
    const segment = await prisma.audienceSegment.create({
      data: { ...dto, organisationId: actor.organisationId },
    });

    await auditService.record({
      action: 'segment.created',
      actorId: actor.sub,
      organisationId: actor.organisationId,
      targetType: 'segment',
      targetId: segment.id,
      details: { name: segment.name },
      ipAddress: contextOf(req).ipAddress,
    });
    res.status(201).json({ status: 'success', data: segment });
  }),
);

segmentsRouter.delete(
  '/:id',
  requireWriteAccess,
  handle(async (req, res) => {
    const actor = actorOf(req);
    const { count } = await prisma.audienceSegment.deleteMany({
      where: { id: req.params['id'] as string, organisationId: actor.organisationId ?? '' },
    });
    if (count === 0) throw new AppError(404, 'Segment not found.');

    decisionCache.invalidate();
    res.status(204).end();
  }),
);

export { segmentsRouter };
