/**
 * tests/helpers/db.ts
 *
 * Shared test database utilities.
 * Provides a dedicated Prisma client instance for test setup/teardown,
 * and helper functions to create test fixtures.
 */
import {
  PrismaClient,
  Role,
  OrganisationRole,
  CampaignStatus,
  CreativeStatus,
  AdSlot,
  Device,
} from '@prisma/client';
import type { Campaign, Plan, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { redis } from '@/lib/redis';

// Create a separate client for tests — avoids interfering with the app's singleton
export const testPrisma = new PrismaClient({
  datasources: { db: { url: process.env['TEST_DATABASE_URL'] as string } },
});

const CampaignCreativeApproved = CreativeStatus.APPROVED;

/** Wipes all data in dependency order */
export async function clearDatabase(): Promise<void> {
  await redis.flushdb();
  await testPrisma.processedBatch.deleteMany();
  await testPrisma.inventoryHour.deleteMany();
  await testPrisma.audienceDay.deleteMany();
  await testPrisma.filteredEvent.deleteMany();
  await testPrisma.metric.deleteMany();
  await testPrisma.campaign.deleteMany();
  await testPrisma.show.deleteMany();
  await testPrisma.organisation.deleteMany();
  await testPrisma.user.deleteMany();
  await testPrisma.auditLog.deleteMany();
  await testPrisma.capturedEmail.deleteMany();
  await testPrisma.aiSetting.deleteMany();
  await testPrisma.invoiceSequence.deleteMany();
  await testPrisma.exchangeRate.deleteMany();
}

/** Creates a test user with a known password and returns the record + plaintext password */
export async function createTestUser(
  overrides: Partial<{
    email: string;
    password: string;
    role: Role;
    organisationRole: OrganisationRole;
    /** Prepaid credit for the new organisation. Plenty by default, so billing stays out of the way. */
    creditCents: number;
    /** No plan limits by default, so they stay out of the way. */
    plan: Plan;
  }> = {},
): Promise<{
  id: string;
  email: string;
  password: string;
  role: Role;
  organisationId: string;
}> {
  const password = overrides.password ?? 'Test1234!';
  const passwordHash = await bcrypt.hash(password, 4); // Lower cost for test speed

  const user = await testPrisma.user.create({
    data: {
      email: overrides.email ?? `test-${Date.now()}@example.com`,
      passwordHash,
      role: overrides.role ?? Role.ADVERTISER,
      emailVerifiedAt: new Date(),
      memberships: {
        create: {
          role: overrides.organisationRole ?? OrganisationRole.OWNER,
          organisation: {
            create: {
              name: 'Test Organisation',
              plan: overrides.plan ?? 'ENTERPRISE',
              ...(overrides.creditCents === 0
                ? {}
                : {
                    balanceEntries: {
                      create: {
                        kind: 'CREDIT',
                        amountCents: overrides.creditCents ?? 1_000_000_000,
                        description: 'Test credit',
                      },
                    },
                  }),
            },
          },
        },
      },
    },
    include: { memberships: true },
  });

  return {
    id: user.id,
    email: user.email,
    password,
    role: user.role,
    organisationId: user.memberships[0]?.organisationId as string,
  };
}

export const createTestShow = (title = 'Test Show', genre = 'Drama') =>
  testPrisma.show.create({ data: { title, genre } });

/** A running campaign in the user's organisation, with sensible defaults. */
export async function createTestCampaign(
  userId: string,
  overrides: Partial<Prisma.CampaignUncheckedCreateInput> = {},
): Promise<Campaign> {
  const membership = await testPrisma.membership.findFirstOrThrow({ where: { userId } });

  return testPrisma.campaign.create({
    data: {
      userId,
      organisationId: membership.organisationId,
      title: 'Test Campaign',
      advertiser: 'Test Advertiser',
      status: CampaignStatus.ACTIVE,
      budgetCents: 1_000_000,
      cpmCents: 2000,
      impressionGoal: 1_000_000,
      startsAt: new Date(Date.now() - 86_400_000),
      endsAt: new Date(Date.now() + 86_400_000),
      ...overrides,
    },
  });
}

/** An approved ad, without running a conversion. */
export const createApprovedCreative = (
  campaignId: string,
  createdById: string,
  overrides: Partial<Prisma.CreativeUncheckedCreateInput> = {},
) =>
  testPrisma.creative.create({
    data: {
      campaignId,
      createdById,
      name: 'Film',
      clickUrl: 'https://example.com',
      status: CampaignCreativeApproved,
      videoKey: 'x.mp4',
      durationSeconds: 6,
      ...overrides,
    },
  });

/** Adds metric rows, one hour apart, ending in the most recent full hour. */
export async function addMetrics(
  campaignId: string,
  showId: string,
  metrics: Array<{ impressions: number; clicks: number; completions?: number; country?: string }>,
): Promise<void> {
  const currentHour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const { cpmCents } = await testPrisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });

  await testPrisma.metric.createMany({
    data: metrics.map((metric, index) => ({
      campaignId,
      showId,
      slot: AdSlot.MID_ROLL,
      country: metric.country ?? 'DE',
      device: Device.CTV,
      bucket: new Date(currentHour - (index + 1) * 3_600_000),
      impressions: metric.impressions,
      costMillicents: metric.impressions * cpmCents,
      clicks: metric.clicks,
      completions: metric.completions ?? 0,
    })),
  });
}
