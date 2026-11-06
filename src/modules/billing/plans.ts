/**
 * src/modules/billing/plans.ts
 *
 * Plans set how much an organisation may use. A platform admin assigns them; new
 * organisations start on Starter. Plans carry no fee of their own: advertisers pay for
 * the ads they run.
 */
import type { Plan, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AppError } from '@/middleware/errorHandler';

type Db = Prisma.TransactionClient | typeof prisma;

export type Limit = 'runningCampaigns' | 'members' | 'scheduledReports';

/** null means no limit. */
export const PLAN_LIMITS: Record<Plan, Record<Limit, number | null>> = {
  STARTER: { runningCampaigns: 2, members: 3, scheduledReports: 1 },
  GROWTH: { runningCampaigns: 10, members: 10, scheduledReports: 10 },
  ENTERPRISE: { runningCampaigns: null, members: null, scheduledReports: null },
};

export const PLAN_NAMES: Record<Plan, string> = {
  STARTER: 'Starter',
  GROWTH: 'Growth',
  ENTERPRISE: 'Enterprise',
};

const LIMIT_WORDS: Record<Limit, (count: number) => string> = {
  runningCampaigns: (n) => `${n} running campaign${n === 1 ? '' : 's'}`,
  members: (n) => `${n} team member${n === 1 ? '' : 's'}, counting open invitations`,
  scheduledReports: (n) => `${n} scheduled report${n === 1 ? '' : 's'}`,
};

export type Usage = Record<Limit, number>;

/** What an organisation uses now. Members count open invitations, which become members. */
export const usageOf = async (organisationId: string, db: Db = prisma): Promise<Usage> => {
  const [runningCampaigns, members, invitations, scheduledReports] = await Promise.all([
    db.campaign.count({ where: { organisationId, status: 'ACTIVE', billedAt: null } }),
    db.membership.count({ where: { organisationId } }),
    db.invitation.count({
      where: { organisationId, acceptedAt: null, expiresAt: { gt: new Date() } },
    }),
    db.report.count({ where: { organisationId, schedule: { not: 'NONE' } } }),
  ]);
  return { runningCampaigns, members: members + invitations, scheduledReports };
};

/**
 * Refuses one more of something when the plan's limit is reached. `excludeOne` leaves
 * out a thing that is already counted, such as a report keeping its schedule.
 */
export const assertWithinPlan = async (
  organisationId: string,
  limit: Limit,
  db: Db = prisma,
  excludeOne = false,
): Promise<void> => {
  const organisation = await db.organisation.findUnique({
    where: { id: organisationId },
    select: { plan: true },
  });
  if (!organisation) return;
  const max = PLAN_LIMITS[organisation.plan][limit];
  if (max === null) return;
  const used = (await usageOf(organisationId, db))[limit] - (excludeOne ? 1 : 0);
  if (used >= max) {
    throw new AppError(
      402,
      `The ${PLAN_NAMES[organisation.plan]} plan allows ${LIMIT_WORDS[limit](max)}. Ask a platform admin to change the plan.`,
    );
  }
};
