/**
 * src/modules/audit/audit.service.ts
 *
 * Records who changed what. A failed write is reported but never undoes or
 * blocks the action it describes.
 */
import { Prisma, type AuditLog } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

export interface AuditEvent {
  action: string;
  actorId?: string | null;
  actorEmail?: string;
  organisationId?: string | null;
  targetType?: string;
  targetId?: string;
  details?: Prisma.InputJsonObject;
  ipAddress?: string;
}

export interface AuditPage {
  data: AuditLog[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export interface AuditQuery {
  page: number;
  limit: number;
  action?: string | undefined;
}

class AuditService {
  async record(event: AuditEvent): Promise<void> {
    let { actorEmail } = event;
    try {
      if (actorEmail === undefined && event.actorId) {
        const actor = await prisma.user.findUnique({
          where: { id: event.actorId },
          select: { email: true },
        });
        actorEmail = actor?.email ?? '';
      }

      await prisma.auditLog.create({
        data: {
          action: event.action,
          actorId: event.actorId ?? null,
          actorEmail: actorEmail ?? '',
          organisationId: event.organisationId ?? null,
          targetType: event.targetType ?? '',
          targetId: event.targetId ?? '',
          details: event.details ?? {},
          ipAddress: event.ipAddress ?? '',
        },
      });
    } catch (error) {
      logger.error({ err: String(error) }, `Audit "${event.action}" failed`);
    }
  }

  /** Newest first. Without an organisation it lists the whole platform. */
  async list(organisationId: string | null, query: AuditQuery): Promise<AuditPage> {
    const where: Prisma.AuditLogWhereInput = {
      ...(organisationId ? { organisationId } : {}),
      ...(query.action ? { action: { startsWith: query.action } } : {}),
    };

    const [total, data] = await prisma.$transaction([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    return {
      data,
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }
}

export const auditService = new AuditService();
