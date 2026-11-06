/**
 * src/modules/admin/admin.routes.ts
 *
 * The platform admin console. Suspending someone also ends their sessions.
 */
import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { actorOf, contextOf, handle } from '@/lib/http';
import { prisma } from '@/lib/prisma';
import { authenticate, requirePlatformAdmin } from '@/middleware/authenticate';
import { AppError } from '@/middleware/errorHandler';
import { auditService } from '@/modules/audit/audit.service';
import { reviewQueueSchema, reviewSchema } from '@/modules/creatives/creatives.schema';
import { creativesService } from '@/modules/creatives/creatives.service';
import { decisionCache } from '@/modules/delivery/decision-cache';
import { queueDepth } from '@/modules/delivery/event-queue';
import { sessionService } from '@/modules/auth/session.service';
import { auditQuerySchema } from '@/modules/team/team.schema';

export const adminListSchema = z.object({
  q: z.string().trim().max(100).default(''),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

export const suspendSchema = z.object({ suspended: z.boolean() });

const pageMeta = (
  total: number,
  query: { page: number; limit: number },
): { total: number; page: number; limit: number; totalPages: number } => ({
  total,
  page: query.page,
  limit: query.limit,
  totalPages: Math.ceil(total / query.limit),
});

const adminRouter = Router();

adminRouter.use(authenticate, requirePlatformAdmin);

adminRouter.get(
  '/stats',
  handle(async (_req, res) => {
    const [users, organisations, campaigns, activeSessions, suspendedUsers] =
      await prisma.$transaction([
        prisma.user.count(),
        prisma.organisation.count(),
        prisma.campaign.count(),
        prisma.session.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
        prisma.user.count({ where: { suspendedAt: { not: null } } }),
      ]);

    const [eventBacklog, filtered] = await Promise.all([
      queueDepth(),
      prisma.filteredEvent.aggregate({
        where: { bucket: { gte: new Date(Date.now() - 86_400_000) } },
        _sum: { count: true },
      }),
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        users,
        organisations,
        campaigns,
        activeSessions,
        suspendedUsers,
        eventBacklog,
        filteredLastDay: filtered._sum.count ?? 0,
      },
    });
  }),
);

adminRouter.get(
  '/users',
  handle(async (req, res) => {
    const query = adminListSchema.parse(req.query);
    const where: Prisma.UserWhereInput = query.q
      ? {
          OR: [
            { email: { contains: query.q, mode: 'insensitive' } },
            { name: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {};

    const [total, users] = await prisma.$transaction([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          emailVerifiedAt: true,
          suspendedAt: true,
          twoFactorEnabledAt: true,
          createdAt: true,
          _count: { select: { memberships: true } },
        },
      }),
    ]);

    res.status(200).json({ status: 'success', data: users, meta: pageMeta(total, query) });
  }),
);

adminRouter.patch(
  '/users/:id',
  handle(async (req, res) => {
    const actor = actorOf(req);
    const id = req.params['id'] as string;
    const { suspended } = suspendSchema.parse(req.body);

    if (id === actor.sub) throw new AppError(409, "You can't suspend your own account.");

    const { count } = await prisma.user.updateMany({
      where: { id },
      data: { suspendedAt: suspended ? new Date() : null },
    });
    if (count === 0) throw new AppError(404, 'User not found.');
    if (suspended) await sessionService.endAll(id);

    await auditService.record({
      action: suspended ? 'admin.user_suspended' : 'admin.user_restored',
      actorId: actor.sub,
      targetType: 'user',
      targetId: id,
      ipAddress: contextOf(req).ipAddress,
    });
    res.status(204).end();
  }),
);

adminRouter.get(
  '/organisations',
  handle(async (req, res) => {
    const query = adminListSchema.parse(req.query);
    const where: Prisma.OrganisationWhereInput = query.q
      ? { name: { contains: query.q, mode: 'insensitive' } }
      : {};

    const [total, organisations] = await prisma.$transaction([
      prisma.organisation.count({ where }),
      prisma.organisation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { _count: { select: { memberships: true, campaigns: true } } },
      }),
    ]);

    res.status(200).json({ status: 'success', data: organisations, meta: pageMeta(total, query) });
  }),
);

adminRouter.patch(
  '/organisations/:id',
  handle(async (req, res) => {
    const actor = actorOf(req);
    const id = req.params['id'] as string;
    const { suspended } = suspendSchema.parse(req.body);

    const { count } = await prisma.organisation.updateMany({
      where: { id },
      data: { suspendedAt: suspended ? new Date() : null },
    });
    if (count === 0) throw new AppError(404, 'Organisation not found.');
    decisionCache.invalidate();

    await auditService.record({
      action: suspended ? 'admin.organisation_suspended' : 'admin.organisation_restored',
      actorId: actor.sub,
      organisationId: id,
      targetType: 'organisation',
      targetId: id,
      ipAddress: contextOf(req).ipAddress,
    });
    res.status(204).end();
  }),
);

adminRouter.get(
  '/creatives',
  handle(async (req, res) => {
    const { status } = reviewQueueSchema.parse(req.query);
    res.status(200).json({ status: 'success', data: await creativesService.queue(status) });
  }),
);

adminRouter.post(
  '/creatives/:id/review',
  handle(async (req, res) => {
    const actor = actorOf(req);
    const dto = reviewSchema.parse(req.body);
    const creative = await creativesService.review(actor, req.params['id'] as string, dto);

    await auditService.record({
      action: dto.decision === 'APPROVE' ? 'creative.approved' : 'creative.rejected',
      actorId: actor.sub,
      targetType: 'creative',
      targetId: creative.id,
      details: { name: creative.name },
      ipAddress: contextOf(req).ipAddress,
    });
    res.status(204).end();
  }),
);

adminRouter.get(
  '/audit',
  handle(async (req, res) => {
    const result = await auditService.list(null, auditQuerySchema.parse(req.query));
    res.status(200).json({ status: 'success', ...result });
  }),
);

export { adminRouter };
