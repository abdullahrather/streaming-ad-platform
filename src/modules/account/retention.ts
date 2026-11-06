/**
 * src/modules/account/retention.ts
 *
 * Deletes personal data once it's no longer needed. Run hourly by the scheduler;
 * running it twice, or from two processes, changes nothing more.
 *
 * Viewer data in Redis expires on its own: interest profiles 90 days after the
 * last view, frequency counts after two days.
 */
import { prisma } from '@/lib/prisma';

const DAY_MS = 86_400_000;

/** How long each kind of record is kept, in days. */
export const RETENTION_DAYS = {
  /** After a sign-in expires or is signed out. */
  sessions: 30,
  /** After an email or password link expires. */
  links: 30,
  /** After an invitation expires, accepted or not. */
  invitations: 30,
  /** Emails kept for the local mailbox. */
  capturedEmails: 30,
  /** IP addresses in the activity history. */
  auditIpAddresses: 90,
  /** The activity history itself. */
  auditEntries: 730,
} as const;

export interface RetentionResult {
  sessions: number;
  links: number;
  invitations: number;
  capturedEmails: number;
  auditIpAddresses: number;
  auditEntries: number;
}

export const applyRetention = async (now = Date.now()): Promise<RetentionResult> => {
  const before = (days: number): Date => new Date(now - days * DAY_MS);

  const [sessions, links, invitations, capturedEmails, auditIpAddresses, auditEntries] =
    await prisma.$transaction([
      prisma.session.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: before(RETENTION_DAYS.sessions) } },
            { revokedAt: { lt: before(RETENTION_DAYS.sessions) } },
          ],
        },
      }),
      prisma.oneTimeToken.deleteMany({
        where: { expiresAt: { lt: before(RETENTION_DAYS.links) } },
      }),
      prisma.invitation.deleteMany({
        where: { expiresAt: { lt: before(RETENTION_DAYS.invitations) } },
      }),
      prisma.capturedEmail.deleteMany({
        where: { createdAt: { lt: before(RETENTION_DAYS.capturedEmails) } },
      }),
      prisma.auditLog.updateMany({
        where: {
          createdAt: { lt: before(RETENTION_DAYS.auditIpAddresses) },
          ipAddress: { not: '' },
        },
        data: { ipAddress: '' },
      }),
      prisma.auditLog.deleteMany({
        where: { createdAt: { lt: before(RETENTION_DAYS.auditEntries) } },
      }),
    ]);

  return {
    sessions: sessions.count,
    links: links.count,
    invitations: invitations.count,
    capturedEmails: capturedEmails.count,
    auditIpAddresses: auditIpAddresses.count,
    auditEntries: auditEntries.count,
  };
};
