/**
 * src/modules/account/account-data.ts
 *
 * GDPR requests from people who use the dashboard: a copy of what's held about
 * them, and deleting their account.
 *
 * Deleting anonymises the person rather than removing the row. Campaigns they
 * created belong to their organisation and stay, and so do invoices, which German
 * law requires keeping for ten years.
 */
import bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AppError } from '@/middleware/errorHandler';
import { auditService } from '@/modules/audit/audit.service';

/** Everything held about one person, for a GDPR access request. */
export const exportAccount = async (userId: string): Promise<Record<string, unknown>> => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: {
      memberships: { include: { organisation: { select: { name: true } } } },
      sessions: { orderBy: { createdAt: 'desc' } },
      invitations: { orderBy: { createdAt: 'desc' } },
      campaigns: {
        select: {
          id: true,
          title: true,
          createdAt: true,
          organisation: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  const activity = await prisma.auditLog.findMany({
    where: { actorId: userId },
    orderBy: { createdAt: 'desc' },
  });

  return {
    exportedAt: new Date().toISOString(),
    profile: {
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt,
      emailVerifiedAt: user.emailVerifiedAt,
      twoFactorLogin: Boolean(user.twoFactorEnabledAt),
    },
    organisations: user.memberships.map((membership) => ({
      organisation: membership.organisation.name,
      role: membership.role,
      alertEmails: membership.alertEmails,
      joinedAt: membership.createdAt,
    })),
    devices: user.sessions.map((session) => ({
      device: session.userAgent,
      ipAddress: session.ipAddress,
      signedInAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
      signedOutAt: session.revokedAt,
    })),
    invitationsSent: user.invitations.map((invitation) => ({
      email: invitation.email,
      role: invitation.role,
      sentAt: invitation.createdAt,
      acceptedAt: invitation.acceptedAt,
    })),
    campaignsCreated: user.campaigns.map((campaign) => ({
      id: campaign.id,
      title: campaign.title,
      organisation: campaign.organisation.name,
      createdAt: campaign.createdAt,
    })),
    activity: activity.map((entry) => ({
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      details: entry.details,
      ipAddress: entry.ipAddress,
      at: entry.createdAt,
    })),
  };
};

/** Why the account can't be deleted yet, or null when it can. */
const blocker = async (userId: string, role: Role): Promise<string | null> => {
  if (role === Role.ADMIN) {
    const admins = await prisma.user.count({ where: { role: Role.ADMIN, suspendedAt: null } });
    if (admins <= 1) return 'You are the only platform admin. Make someone else an admin first.';
  }

  const memberships = await prisma.membership.findMany({
    where: { userId },
    include: {
      organisation: {
        select: {
          name: true,
          memberships: { select: { userId: true, role: true } },
          campaigns: {
            where: { status: 'ACTIVE', endsAt: { gt: new Date() } },
            select: { id: true },
            take: 1,
          },
        },
      },
    },
  });

  for (const { role: memberRole, organisation } of memberships) {
    const others = organisation.memberships.filter((member) => member.userId !== userId);
    if (others.length === 0 && organisation.campaigns.length > 0) {
      return `${organisation.name} has campaigns running and nobody else to manage them. Pause or end them first.`;
    }
    if (memberRole === 'OWNER' && others.length > 0 && !others.some((m) => m.role === 'OWNER')) {
      return `You are the only owner of ${organisation.name}. Make another member an owner first.`;
    }
  }
  return null;
};

/** Deletes the person's account, keeping their organisations' records. */
export const deleteAccount = async (userId: string, password: string): Promise<void> => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await bcrypt.compare(password, user.passwordHash))) {
    throw new AppError(422, 'That password is not correct.');
  }
  const reason = await blocker(userId, user.role);
  if (reason) throw new AppError(409, reason);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        email: `deleted-${userId}@deleted.invalid`,
        name: '',
        passwordHash: '',
        emailVerifiedAt: null,
        suspendedAt: new Date(),
        twoFactorSecret: null,
        twoFactorEnabledAt: null,
        twoFactorLastStep: null,
        recoveryCodes: [],
      },
    }),
    prisma.session.deleteMany({ where: { userId } }),
    prisma.oneTimeToken.deleteMany({ where: { userId } }),
    prisma.invitation.deleteMany({ where: { invitedById: userId } }),
    prisma.membership.deleteMany({ where: { userId } }),
    // The history of what was done stays, without saying who or from where.
    prisma.auditLog.updateMany({
      where: { actorId: userId },
      data: { actorEmail: '', ipAddress: '' },
    }),
  ]);
  await auditService.record({ action: 'account.deleted', actorId: userId, actorEmail: '' });
};
