/**
 * tests/billing.test.ts
 *
 * Prepaid balances, what running campaigns hold, invoices for finished campaigns,
 * and the publisher's revenue.
 */
import request from 'supertest';
import { AdSlot, Device, OrganisationRole, Role } from '@prisma/client';
import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';
import { billingService, SETTLE_MS } from '@/modules/billing/billing.service';
import {
  clearDatabase,
  createTestCampaign,
  createTestShow,
  createTestUser,
  testPrisma,
} from './helpers/db';

const app = createApp();
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const login = async (user: { email: string; password: string }): Promise<string> => {
  const res = await request(app).post('/auth/login').send(user);
  if (res.status !== 200) throw new Error(`Login failed: ${JSON.stringify(res.body)}`);
  return `Bearer ${(res.body as { data: { token: string } }).data.token}`;
};

/** Delivery for a campaign: impressions at a price, in one hourly row. */
const delivered = async (
  campaignId: string,
  impressions: number,
  costMillicents: number,
  at = new Date(Date.now() - 3 * HOUR_MS),
  slot: AdSlot = AdSlot.MID_ROLL,
): Promise<void> => {
  const show = (await testPrisma.show.findFirst()) ?? (await createTestShow());
  await testPrisma.metric.create({
    data: {
      campaignId,
      showId: show.id,
      slot,
      country: 'DE',
      device: Device.CTV,
      bucket: new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS),
      impressions,
      clicks: Math.round(impressions / 100),
      costMillicents: BigInt(costMillicents),
    },
  });
};

/** A campaign whose flight ended long enough ago for its delivery to be final. */
const finished = (hoursAgo = 3) => ({
  startsAt: new Date(Date.now() - 10 * DAY_MS),
  endsAt: new Date(Date.now() - hoursAgo * HOUR_MS),
});

const newCampaign = (budgetCents: number, status: 'ACTIVE' | 'PAUSED' = 'ACTIVE') => ({
  title: `Campaign ${budgetCents}`,
  advertiser: 'Acme',
  status,
  budgetCents,
  cpmCents: 2000,
  impressionGoal: 1000,
  startsAt: new Date(Date.now() + DAY_MS).toISOString(),
  endsAt: new Date(Date.now() + 8 * DAY_MS).toISOString(),
});

beforeEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

describe('Prepaid balance', () => {
  it('only starts campaigns the balance can cover', async () => {
    const auth = await login(await createTestUser({ creditCents: 100_000 }));

    const first = await request(app)
      .post('/campaigns')
      .set('Authorization', auth)
      .send(newCampaign(60_000));
    const second = await request(app)
      .post('/campaigns')
      .set('Authorization', auth)
      .send(newCampaign(50_000));
    const paused = await request(app)
      .post('/campaigns')
      .set('Authorization', auth)
      .send(newCampaign(50_000, 'PAUSED'));
    const billing = await request(app).get('/billing').set('Authorization', auth);

    expect(first.status).toBe(201);
    expect(second.status).toBe(402);
    expect(second.body.message).toBe(
      'Not enough balance. This campaign needs €595.00, its unspent budget plus 19% VAT, and €286.00 is available. Add credit on the Billing page, or lower the budget.',
    );
    // A paused campaign holds nothing, so it can be created.
    expect(paused.status).toBe(201);
    expect(billing.body.data).toMatchObject({
      balanceCents: 100_000,
      heldCents: 71_400,
      availableCents: 28_600,
    });
  });

  it('frees the money when a campaign is paused, and needs it again to resume', async () => {
    const auth = await login(await createTestUser({ creditCents: 100_000 }));
    const a = await request(app)
      .post('/campaigns')
      .set('Authorization', auth)
      .send(newCampaign(60_000));
    const b = await request(app)
      .post('/campaigns')
      .set('Authorization', auth)
      .send(newCampaign(60_000, 'PAUSED'));

    const blocked = await request(app)
      .patch(`/campaigns/${b.body.data.id}`)
      .set('Authorization', auth)
      .send({ status: 'ACTIVE' });
    await request(app)
      .patch(`/campaigns/${a.body.data.id}`)
      .set('Authorization', auth)
      .send({ status: 'PAUSED' });
    const resumed = await request(app)
      .patch(`/campaigns/${b.body.data.id}`)
      .set('Authorization', auth)
      .send({ status: 'ACTIVE' });

    expect(blocked.status).toBe(402);
    expect(resumed.status).toBe(200);
  });

  it('counts what a campaign already spent, and checks budget increases', async () => {
    const user = await createTestUser({ creditCents: 85_000 });
    const auth = await login(user);
    // €1,000 budget with €400 spent holds €600 plus 19% VAT: €714. €850 covers that.
    const campaign = await createTestCampaign(user.id, { status: 'PAUSED', budgetCents: 100_000 });
    await delivered(campaign.id, 20_000, 40_000_000);

    const resumed = await request(app)
      .patch(`/campaigns/${campaign.id}`)
      .set('Authorization', auth)
      .send({ status: 'ACTIVE' });
    const tooMuch = await request(app)
      .patch(`/campaigns/${campaign.id}`)
      .set('Authorization', auth)
      .send({ budgetCents: 120_000 });
    const enough = await request(app)
      .patch(`/campaigns/${campaign.id}`)
      .set('Authorization', auth)
      .send({ budgetCents: 110_000 });

    expect(resumed.status).toBe(200);
    expect(tooMuch.status).toBe(402);
    expect(enough.status).toBe(200);
  });

  it('never lets two campaigns spend the same money at once', async () => {
    const user = await createTestUser({ creditCents: 100_000 });
    const auth = await login(user);
    const a = await createTestCampaign(user.id, { status: 'PAUSED', budgetCents: 60_000 });
    const b = await createTestCampaign(user.id, { status: 'PAUSED', budgetCents: 60_000 });

    const results = await Promise.all(
      [a, b].map(({ id }) =>
        request(app)
          .patch(`/campaigns/${id}`)
          .set('Authorization', auth)
          .send({ status: 'ACTIVE' }),
      ),
    );

    expect(results.map(({ status }) => status).sort()).toEqual([200, 402]);
  });

  it('makes a second change wait while the first one is still checking the balance', async () => {
    const user = await createTestUser({ creditCents: 100_000 });
    const a = await createTestCampaign(user.id, { status: 'PAUSED', budgetCents: 60_000 });
    const b = await createTestCampaign(user.id, { status: 'PAUSED', budgetCents: 60_000 });
    // Each change checks, pauses as a slow request would, then starts its campaign.
    const start = (id: string) =>
      prisma.$transaction(async (tx) => {
        await billingService.assertAffordable(tx, user.organisationId, id, 60_000);
        await new Promise((resolve) => setTimeout(resolve, 150));
        await tx.campaign.update({ where: { id }, data: { status: 'ACTIVE' } });
      });

    const results = await Promise.allSettled([start(a.id), start(b.id)]);

    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await testPrisma.campaign.count({ where: { status: 'ACTIVE' } })).toBe(1);
  });
});

describe('Invoices', () => {
  it('invoices a finished campaign once its delivery is final, and pays it from the balance', async () => {
    const owner = await createTestUser({ email: 'owner@example.com', creditCents: 500_000 });
    const campaign = await createTestCampaign(owner.id, {
      title: 'Spring Coats',
      advertiser: 'Nordkap Outdoor',
      ...finished(),
    });
    // 123,456.789 cents rounds to 123,457.
    await delivered(campaign.id, 40_000, 80_000_000, new Date(Date.now() - 5 * DAY_MS));
    await delivered(
      campaign.id,
      21_728,
      43_456_789,
      new Date(Date.now() - 4 * DAY_MS),
      AdSlot.PRE_ROLL,
    );

    const issued = await billingService.run();
    const again = await billingService.run();

    expect([issued, again]).toEqual([1, 0]);
    const invoice = await testPrisma.invoice.findFirstOrThrow();
    const year = new Date().getFullYear();
    expect(invoice).toMatchObject({
      number: `INV-${year}-00001`,
      campaignTitle: 'Spring Coats',
      advertiser: 'Nordkap Outdoor',
      impressions: 61_728,
      subtotalCents: 123_457,
      taxCents: 23_457,
      eurTotalCents: 146_914,
      totalCents: 146_914,
      currency: 'EUR',
    });
    const charge = await testPrisma.balanceEntry.findFirstOrThrow({ where: { kind: 'CHARGE' } });
    expect(charge).toMatchObject({ amountCents: -146_914, invoiceId: invoice.id });
    const closed = await testPrisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(closed.status).toBe('COMPLETED');
    expect(closed.billedAt).not.toBeNull();
    const account = await billingService.account(campaign.organisationId);
    expect(account).toMatchObject({ balanceCents: 500_000 - 146_914, heldCents: 0 });

    const email = await testPrisma.capturedEmail.findFirstOrThrow({
      where: { recipient: 'owner@example.com' },
    });
    expect(email.subject).toBe(`Invoice INV-${year}-00001: Spring Coats`);
    expect(email.body).toContain('€1,469.14 for 61,728 impressions');
    expect(JSON.stringify(email.attachments)).toContain(`INV-${year}-00001.pdf`);
  });

  it('bills a campaign once when two processes try at the same moment', async () => {
    const user = await createTestUser();
    const campaign = await createTestCampaign(user.id, finished());
    await delivered(campaign.id, 1000, 2_000_000);

    const results = await Promise.all([
      billingService.issueInvoice(campaign.id),
      billingService.issueInvoice(campaign.id),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await testPrisma.invoice.count()).toBe(1);
    expect(await testPrisma.balanceEntry.count({ where: { kind: 'CHARGE' } })).toBe(1);
  });

  it('waits until late events can no longer arrive', async () => {
    const user = await createTestUser();
    const campaign = await createTestCampaign(user.id, finished(0.25));
    await delivered(campaign.id, 1000, 2_000_000);

    expect(await billingService.run()).toBe(0);
    expect(await billingService.run(new Date(Date.now() + SETTLE_MS))).toBe(1);
  });

  it('invoices a campaign that completed early, and closes one with nothing to bill', async () => {
    const user = await createTestUser();
    const early = await createTestCampaign(user.id, {
      status: 'COMPLETED',
      completedAt: new Date(Date.now() - 2 * HOUR_MS),
    });
    await delivered(early.id, 1000, 2_000_000, new Date(Date.now() - 4 * HOUR_MS));
    const empty = await createTestCampaign(user.id, { title: 'Never ran', ...finished() });

    expect(await billingService.run()).toBe(1);
    const unbilled = await testPrisma.campaign.findUniqueOrThrow({ where: { id: empty.id } });
    expect(unbilled.billedAt).not.toBeNull();
    expect(await testPrisma.invoice.count()).toBe(1);
  });

  it('numbers invoices in order with no gaps', async () => {
    const user = await createTestUser();
    for (const title of ['One', 'Two', 'Three']) {
      const campaign = await createTestCampaign(user.id, { title, ...finished() });
      await delivered(campaign.id, 1000, 2_000_000);
    }

    await billingService.run();

    const numbers = (await testPrisma.invoice.findMany({ orderBy: { number: 'asc' } })).map(
      ({ number }) => number.slice(-5),
    );
    expect(numbers).toEqual(['00001', '00002', '00003']);
  });

  it('invoices what a campaign spent before it is deleted', async () => {
    const user = await createTestUser();
    const campaign = await createTestCampaign(user.id, { title: 'Gone soon' });
    await delivered(campaign.id, 5000, 10_000_000);

    const res = await request(app)
      .delete(`/campaigns/${campaign.id}`)
      .set('Authorization', await login(user));

    expect(res.status).toBe(204);
    const invoice = await testPrisma.invoice.findFirstOrThrow();
    expect(invoice).toMatchObject({
      campaignId: null,
      campaignTitle: 'Gone soon',
      totalCents: 11_900,
    });
  });

  it('downloads an invoice as a PDF, only for its own organisation', async () => {
    const owner = await createTestUser({ email: 'owner@example.com' });
    const campaign = await createTestCampaign(owner.id, finished());
    await delivered(campaign.id, 1000, 2_000_000);
    await billingService.run();
    const invoice = await testPrisma.invoice.findFirstOrThrow();
    const other = await createTestUser({ email: 'other@example.com' });

    const own = await request(app)
      .get(`/billing/invoices/${invoice.id}/pdf`)
      .set('Authorization', await login(owner))
      .buffer(true);
    const theirs = await request(app)
      .get(`/billing/invoices/${invoice.id}/pdf`)
      .set('Authorization', await login(other));

    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toContain('application/pdf');
    expect(own.headers['content-disposition']).toContain(`${invoice.number}.pdf`);
    expect(theirs.status).toBe(404);
  });
});

describe('Billing access', () => {
  it('is for owners and managers, and credit is added by platform admins', async () => {
    const owner = await createTestUser({ creditCents: 0 });
    const analyst = await createTestUser({
      email: 'analyst@example.com',
      organisationRole: OrganisationRole.ANALYST,
    });
    const admin = await createTestUser({ email: 'admin@example.com', role: Role.ADMIN });
    const ownerAuth = await login(owner);

    const analystView = await request(app)
      .get('/billing')
      .set('Authorization', await login(analyst));
    const ownerCredit = await request(app)
      .post(`/billing/organisations/${owner.organisationId}/credits`)
      .set('Authorization', ownerAuth)
      .send({ amountCents: 100_000 });
    const adminCredit = await request(app)
      .post(`/billing/organisations/${owner.organisationId}/credits`)
      .set('Authorization', await login(admin))
      .send({ amountCents: 250_000, description: 'Bank transfer received' });
    const ownerView = await request(app).get('/billing').set('Authorization', ownerAuth);

    expect(analystView.status).toBe(403);
    expect(ownerCredit.status).toBe(403);
    expect(adminCredit.status).toBe(201);
    expect(ownerView.body.data).toMatchObject({ balanceCents: 250_000, availableCents: 250_000 });
    expect(ownerView.body.data.entries[0]).toMatchObject({
      kind: 'CREDIT',
      amountCents: 250_000,
      description: 'Bank transfer received',
    });
    expect(await testPrisma.auditLog.count({ where: { action: 'billing.credit.added' } })).toBe(1);
  });
});

describe('Publisher revenue', () => {
  it('splits delivered revenue by show, advertiser and ad slot', async () => {
    const owner = await createTestUser();
    await testPrisma.organisation.update({
      where: { id: owner.organisationId },
      data: { name: 'Brightline Media' },
    });
    await createTestShow('Harbour Lights', 'Drama');
    const campaign = await createTestCampaign(owner.id, finished());
    await delivered(campaign.id, 3000, 6_000_000, new Date(Date.now() - 5 * HOUR_MS));
    await delivered(
      campaign.id,
      1000,
      3_000_000,
      new Date(Date.now() - 6 * HOUR_MS),
      AdSlot.PRE_ROLL,
    );
    await billingService.run();
    const admin = await createTestUser({ email: 'admin@example.com', role: Role.ADMIN });

    const res = await request(app)
      .get('/billing/revenue')
      .set('Authorization', await login(admin));
    const denied = await request(app)
      .get('/billing/revenue')
      .set('Authorization', await login(owner));

    expect(denied.status).toBe(403);
    expect(res.body.data).toMatchObject({
      impressions: 4000,
      revenueCents: 9000,
      invoicedCents: 9000,
      invoiceCount: 1,
      unbilledCents: 0,
      byShow: [
        {
          label: 'Harbour Lights',
          genre: 'Drama',
          impressions: 4000,
          revenueCents: 9000,
          ecpmCents: 2250,
        },
      ],
      byOrganisation: [{ label: 'Brightline Media', revenueCents: 9000 }],
      bySlot: [
        { label: 'MID_ROLL', revenueCents: 6000, ecpmCents: 2000 },
        { label: 'PRE_ROLL', revenueCents: 3000, ecpmCents: 3000 },
      ],
    });
  });
});
