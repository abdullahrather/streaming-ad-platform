/**
 * tests/billing-payments.test.ts
 *
 * Card payments through Stripe, currencies, EU VAT and plans. Stripe, the ECB's rates
 * and the EU's VIES service are local stand-ins, so the tests need no account and no
 * network.
 */
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import Stripe from 'stripe';
import { AdSlot, Device, OrganisationRole, Role } from '@prisma/client';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { billingService } from '@/modules/billing/billing.service';
import { parseEcbRates, rateFor, refreshRates } from '@/modules/billing/currency';
import { setStripeClient } from '@/modules/billing/stripe';
import { vatFor } from '@/modules/billing/vat';
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
const WEBHOOK_SECRET = 'whsec_test_secret';

const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope><Cube><Cube time='2026-11-05'>
<Cube currency='USD' rate='1.0812'/><Cube currency='GBP' rate='0.8500'/>
<Cube currency='CHF' rate='0.9400'/><Cube currency='SEK' rate='11.4520'/>
</Cube></Cube></gesmes:Envelope>`;

const login = async (user: { email: string; password: string }): Promise<string> => {
  const res = await request(app).post('/auth/login').send(user);
  if (res.status !== 200) throw new Error(`Login failed: ${JSON.stringify(res.body)}`);
  return `Bearer ${(res.body as { data: { token: string } }).data.token}`;
};

interface Stand {
  url: string;
  server: Server;
}
const listen = async (handler: express.Express): Promise<Stand> => {
  const server: Server = await new Promise((resolve) => {
    const s = handler.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
};

// What VIES answers next, and the Checkout Sessions the Stripe stand-in holds.
let vies: { status: number; body: Record<string, unknown> } = {
  status: 200,
  body: { isValid: true },
};
const sessions = new Map<string, Record<string, unknown>>();
const created: Array<Record<string, unknown>> = [];
let ecb: Stand;
let viesStand: Stand;
let stripeStand: Stand;

beforeAll(async () => {
  const ecbApp = express();
  ecbApp.get('/rates.xml', (_req, res) => {
    res.type('application/xml').send(ECB_XML);
  });
  ecb = await listen(ecbApp);

  const viesApp = express();
  viesApp.get('/ms/:country/vat/:number', (_req, res) => {
    res.status(vies.status).json(vies.body);
  });
  viesStand = await listen(viesApp);

  const stripeApp = express();
  stripeApp.use(express.urlencoded({ extended: true }));
  stripeApp.post('/v1/checkout/sessions', (req, res) => {
    created.push(req.body as Record<string, unknown>);
    const body = req.body as {
      metadata: Record<string, string>;
      line_items: Array<{ price_data: { currency: string; unit_amount: string } }>;
    };
    const id = `cs_test_${sessions.size + 1}`;
    const session = {
      id,
      object: 'checkout.session',
      url: `https://checkout.stripe.test/${id}`,
      payment_status: 'unpaid',
      currency: body.line_items[0]?.price_data.currency,
      amount_total: Number(body.line_items[0]?.price_data.unit_amount),
      metadata: body.metadata,
    };
    sessions.set(id, session);
    res.json(session);
  });
  stripeApp.get('/v1/checkout/sessions/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      res
        .status(404)
        .json({ error: { type: 'invalid_request_error', message: 'No such session' } });
      return;
    }
    res.json(session);
  });
  stripeStand = await listen(stripeApp);

  const settings = env as unknown as Record<string, unknown>;
  settings['ECB_RATES_URL'] = `${ecb.url}/rates.xml`;
  settings['VIES_URL'] = viesStand.url;
  settings['STRIPE_WEBHOOK_SECRET'] = WEBHOOK_SECRET;
});

afterAll(async () => {
  setStripeClient(undefined);
  for (const stand of [ecb, viesStand, stripeStand]) stand.server.close();
  await testPrisma.$disconnect();
});

const stripeClient = (): Stripe =>
  new Stripe('sk_test_local', {
    host: '127.0.0.1',
    port: Number(new URL(stripeStand.url).port),
    protocol: 'http',
    maxNetworkRetries: 0,
  });

beforeEach(async () => {
  await clearDatabase();
  sessions.clear();
  created.length = 0;
  vies = { status: 200, body: { isValid: true } };
  setStripeClient(stripeClient());
});

const delivered = async (campaignId: string, costMillicents: number): Promise<void> => {
  const show = (await testPrisma.show.findFirst()) ?? (await createTestShow());
  await testPrisma.metric.create({
    data: {
      campaignId,
      showId: show.id,
      slot: AdSlot.MID_ROLL,
      country: 'DE',
      device: Device.CTV,
      bucket: new Date(Math.floor((Date.now() - 4 * HOUR_MS) / HOUR_MS) * HOUR_MS),
      impressions: 5000,
      costMillicents: BigInt(costMillicents),
    },
  });
};

const finished = {
  startsAt: new Date(Date.now() - 10 * DAY_MS),
  endsAt: new Date(Date.now() - 3 * HOUR_MS),
};

describe('Exchange rates', () => {
  it('reads and stores the ECB reference rates', async () => {
    expect(parseEcbRates(ECB_XML).rates.get('GBP')).toBe(0.85);

    const stored = await refreshRates();

    expect(stored).toBe(4);
    expect(await rateFor('GBP')).toMatchObject({ currency: 'GBP', rate: 0.85, date: '2026-11-05' });
    expect(await rateFor('EUR')).toMatchObject({ rate: 1 });
  });
});

describe('VAT', () => {
  const verified = new Date();
  it('follows the rules for a seller in Germany', () => {
    expect(vatFor({ country: 'DE', vatId: '', vatIdVerifiedAt: null }).rateBp).toBe(1900);
    expect(vatFor({ country: '', vatId: '', vatIdVerifiedAt: null }).rateBp).toBe(1900);
    expect(
      vatFor({ country: 'FR', vatId: 'FR12345678901', vatIdVerifiedAt: verified }),
    ).toMatchObject({
      rateBp: 0,
      note: expect.stringContaining('Reverse charge'),
    });
    expect(vatFor({ country: 'FR', vatId: 'FR12345678901', vatIdVerifiedAt: null })).toMatchObject({
      rateBp: 1900,
      note: 'German VAT charged: the EU VAT ID could not be confirmed.',
    });
    expect(vatFor({ country: 'CH', vatId: '', vatIdVerifiedAt: null })).toMatchObject({
      rateBp: 0,
      note: expect.stringContaining('outside the EU'),
    });
  });

  it('checks an EU VAT ID with VIES, and only a confirmed one gets the reverse charge', async () => {
    const auth = await login(await createTestUser());
    const details = {
      billingName: 'Maison Lumière SARL',
      country: 'FR',
      vatId: 'FR 1234 5678 901',
    };

    const valid = await request(app)
      .put('/billing/details')
      .set('Authorization', auth)
      .send(details);
    vies = { status: 200, body: { isValid: false, userError: 'INVALID' } };
    const invalid = await request(app)
      .put('/billing/details')
      .set('Authorization', auth)
      .send(details);
    vies = { status: 200, body: { isValid: false, userError: 'MS_UNAVAILABLE' } };
    const down = await request(app)
      .put('/billing/details')
      .set('Authorization', auth)
      .send(details);

    expect(valid.body.data).toMatchObject({
      vatId: 'FR12345678901',
      vatIdVerified: true,
      vatCheck: 'valid',
    });
    expect(valid.body.data.vat.rateBp).toBe(0);
    expect(invalid.body.data).toMatchObject({ vatIdVerified: false, vatCheck: 'invalid' });
    expect(invalid.body.data.vat.rateBp).toBe(1900);
    expect(down.body.data).toMatchObject({ vatIdVerified: false, vatCheck: 'unavailable' });
  });

  it('keeps a confirmed VAT ID when VIES is down and only the address changes', async () => {
    const auth = await login(await createTestUser());
    const details = { country: 'FR', vatId: 'FR12345678901', city: 'Paris' };
    await request(app).put('/billing/details').set('Authorization', auth).send(details);
    vies = { status: 200, body: { isValid: false, userError: 'MS_UNAVAILABLE' } };

    const sameId = await request(app)
      .put('/billing/details')
      .set('Authorization', auth)
      .send({ ...details, city: 'Lyon' });
    const newId = await request(app)
      .put('/billing/details')
      .set('Authorization', auth)
      .send({ ...details, vatId: 'FR98765432109' });

    expect(sameId.body.data).toMatchObject({
      city: 'Lyon',
      vatIdVerified: true,
      vatCheck: 'unavailable',
    });
    expect(sameId.body.data.vat.rateBp).toBe(0);
    // A different VAT ID can't inherit the old one's confirmation.
    expect(newId.body.data).toMatchObject({ vatIdVerified: false });
  });

  it('only accepts countries it knows, so no one can pick their way out of VAT', async () => {
    const auth = await login(await createTestUser());

    const madeUp = await request(app)
      .put('/billing/details')
      .set('Authorization', auth)
      .send({ country: 'ZZ' });

    expect(madeUp.status).toBe(422);
    expect(await testPrisma.organisation.count({ where: { country: 'ZZ' } })).toBe(0);
  });

  it('refuses a VAT ID for another country, and lets only owners change details', async () => {
    const owner = await createTestUser();
    const manager = await createTestUser({
      email: 'manager@example.com',
      organisationRole: OrganisationRole.MANAGER,
    });

    const wrongPrefix = await request(app)
      .put('/billing/details')
      .set('Authorization', await login(owner))
      .send({ country: 'NL', vatId: 'FR12345678901' });
    const byManager = await request(app)
      .put('/billing/details')
      .set('Authorization', await login(manager))
      .send({ country: 'DE' });

    expect(wrongPrefix.status).toBe(422);
    expect(wrongPrefix.body.message).toBe('A VAT ID for this country starts with NL.');
    expect(byManager.status).toBe(403);
  });

  it('holds a reverse-charge customer’s budget without VAT', async () => {
    const user = await createTestUser({ creditCents: 100_000 });
    await testPrisma.organisation.update({
      where: { id: user.organisationId },
      data: { country: 'FR', vatId: 'FR12345678901', vatIdVerifiedAt: new Date() },
    });
    await createTestCampaign(user.id, { budgetCents: 60_000 });

    expect(await billingService.account(user.organisationId)).toMatchObject({
      heldCents: 60_000,
      vatRateBp: 0,
    });
  });
});

describe('Invoices in another currency', () => {
  it('invoices in the customer’s currency at the ECB rate, and charges the balance in euros', async () => {
    await refreshRates();
    const user = await createTestUser({ creditCents: 500_000 });
    await testPrisma.organisation.update({
      where: { id: user.organisationId },
      data: {
        billingName: 'Maison Lumière SARL',
        addressLine1: '12 rue des Lilas',
        postalCode: '75011',
        city: 'Paris',
        country: 'FR',
        vatId: 'FR12345678901',
        vatIdVerifiedAt: new Date(),
        currency: 'GBP',
      },
    });
    const campaign = await createTestCampaign(user.id, finished);
    await delivered(campaign.id, 10_000_000);

    await billingService.run();

    const invoice = await testPrisma.invoice.findFirstOrThrow();
    expect(invoice).toMatchObject({
      organisationName: 'Maison Lumière SARL',
      currency: 'GBP',
      subtotalCents: 8500,
      taxCents: 0,
      totalCents: 8500,
      eurSubtotalCents: 10_000,
      eurTotalCents: 10_000,
      vatRateBp: 0,
      buyerAddress: '12 rue des Lilas\n75011 Paris\nFR',
      buyerVatId: 'FR12345678901',
      sellerName: env.SELLER_NAME,
      sellerVatId: env.SELLER_VAT_ID,
    });
    expect(Number(invoice.exchangeRate)).toBe(0.85);
    expect(invoice.vatNote).toContain('Reverse charge');
    expect(
      await testPrisma.balanceEntry.findFirstOrThrow({ where: { kind: 'CHARGE' } }),
    ).toMatchObject({
      amountCents: -10_000,
    });
    const pdf = await request(app)
      .get(`/billing/invoices/${invoice.id}/pdf`)
      .set('Authorization', await login(user));
    expect(pdf.status).toBe(200);
  });

  it('waits for a rate rather than issuing an invoice without one', async () => {
    const user = await createTestUser();
    await testPrisma.organisation.update({
      where: { id: user.organisationId },
      data: { currency: 'CHF' },
    });
    const campaign = await createTestCampaign(user.id, finished);
    await delivered(campaign.id, 2_000_000);

    expect(await billingService.run()).toBe(0);
    expect(
      (await testPrisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).billedAt,
    ).toBeNull();

    await refreshRates();
    expect(await billingService.run()).toBe(1);
  });
});

describe('Card payments', () => {
  const ownerInGbp = async () => {
    await refreshRates();
    const owner = await createTestUser({ creditCents: 0 });
    await testPrisma.organisation.update({
      where: { id: owner.organisationId },
      data: { currency: 'GBP' },
    });
    return { owner, auth: await login(owner) };
  };

  it('starts a Stripe Checkout payment in the organisation’s currency', async () => {
    const { owner, auth } = await ownerInGbp();

    const res = await request(app)
      .post('/billing/checkout')
      .set('Authorization', auth)
      .send({ amountCents: 5000 });

    expect(res.status).toBe(201);
    expect(res.body.data.url).toBe('https://checkout.stripe.test/cs_test_1');
    expect(created[0]).toMatchObject({
      mode: 'payment',
      line_items: [{ price_data: { currency: 'gbp', unit_amount: '5000' } }],
      metadata: { organisationId: owner.organisationId },
    });
  });

  it('credits a paid payment once, converted to euros, when the payer comes back', async () => {
    const { owner, auth } = await ownerInGbp();
    await request(app)
      .post('/billing/checkout')
      .set('Authorization', auth)
      .send({ amountCents: 5000 });

    const unpaid = await request(app)
      .post('/billing/checkout/cs_test_1/confirm')
      .set('Authorization', auth);
    (sessions.get('cs_test_1') as Record<string, unknown>)['payment_status'] = 'paid';
    const paid = await request(app)
      .post('/billing/checkout/cs_test_1/confirm')
      .set('Authorization', auth);
    const again = await request(app)
      .post('/billing/checkout/cs_test_1/confirm')
      .set('Authorization', auth);

    expect(unpaid.body.data).toMatchObject({ paid: false, entry: null });
    // £50.00 at 0.85 is €58.82.
    expect(paid.body.data.entry).toMatchObject({
      amountCents: 5882,
      paidCents: 5000,
      paidCurrency: 'GBP',
      description: 'Card payment: 50.00 GBP',
    });
    expect(again.body.data.entry.id).toBe(paid.body.data.entry.id);
    expect((await billingService.account(owner.organisationId)).balanceCents).toBe(5882);
  });

  it('credits through the webhook once, and refuses a bad signature', async () => {
    const { owner } = await ownerInGbp();
    const event = JSON.stringify({
      id: 'evt_1',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_hook',
          object: 'checkout.session',
          payment_status: 'paid',
          currency: 'gbp',
          amount_total: 10_000,
          metadata: { organisationId: owner.organisationId },
        },
      },
    });
    const signature = stripeClient().webhooks.generateTestHeaderString({
      payload: event,
      secret: WEBHOOK_SECRET,
    });
    const send = (sig: string) =>
      request(app)
        .post('/billing/stripe/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', sig)
        .send(event);

    const first = await send(signature);
    const replay = await send(signature);
    const forged = await send('t=1,v1=forged');

    expect([first.status, replay.status, forged.status]).toEqual([200, 200, 400]);
    expect(
      await testPrisma.balanceEntry.count({ where: { stripeSessionId: 'cs_test_hook' } }),
    ).toBe(1);
    expect((await billingService.account(owner.organisationId)).balanceCents).toBe(11_765);
  });

  it('only lets owners pay, only for their own payments, and is off without a key', async () => {
    const { auth } = await ownerInGbp();
    const manager = await createTestUser({
      email: 'manager@example.com',
      organisationRole: OrganisationRole.MANAGER,
    });
    const other = await createTestUser({ email: 'other@example.com' });
    await request(app)
      .post('/billing/checkout')
      .set('Authorization', auth)
      .send({ amountCents: 5000 });

    const byManager = await request(app)
      .post('/billing/checkout')
      .set('Authorization', await login(manager))
      .send({ amountCents: 5000 });
    const someoneElses = await request(app)
      .post('/billing/checkout/cs_test_1/confirm')
      .set('Authorization', await login(other));
    setStripeClient(null);
    const off = await request(app)
      .post('/billing/checkout')
      .set('Authorization', auth)
      .send({ amountCents: 5000 });
    const overview = await request(app).get('/billing').set('Authorization', auth);

    expect(byManager.status).toBe(403);
    expect(someoneElses.status).toBe(404);
    expect(off.status).toBe(503);
    expect(overview.body.data.cardPayments).toBe(false);
  });
});

describe('Plans', () => {
  it('limits running campaigns, members and scheduled reports on Starter', async () => {
    const owner = await createTestUser({ plan: 'STARTER' });
    const auth = await login(owner);
    const campaign = (title: string) => ({
      title,
      advertiser: 'Acme',
      budgetCents: 10_000,
      cpmCents: 2000,
      impressionGoal: 500,
      startsAt: new Date(Date.now() + DAY_MS).toISOString(),
      endsAt: new Date(Date.now() + 8 * DAY_MS).toISOString(),
    });
    const report = {
      name: 'Weekly',
      groupBy: 'DAY',
      columns: ['impressions'],
      schedule: 'WEEKLY',
      recipientIds: [owner.id],
    };

    const runs = [];
    for (const title of ['One', 'Two', 'Three']) {
      runs.push(
        await request(app).post('/campaigns').set('Authorization', auth).send(campaign(title)),
      );
    }
    const invites = [];
    for (const email of ['a@example.com', 'b@example.com', 'c@example.com']) {
      invites.push(
        await request(app)
          .post('/team/invitations')
          .set('Authorization', auth)
          .send({ email, role: 'ANALYST' }),
      );
    }
    const reinvite = await request(app)
      .post('/team/invitations')
      .set('Authorization', auth)
      .send({ email: 'a@example.com', role: 'ANALYST' });
    const reports = [
      await request(app).post('/reports').set('Authorization', auth).send(report),
      await request(app).post('/reports').set('Authorization', auth).send(report),
    ];
    const overview = await request(app).get('/billing').set('Authorization', auth);

    expect(runs.map(({ status }) => status)).toEqual([201, 201, 402]);
    expect(runs[2]?.body.message).toBe(
      'The Starter plan allows 2 running campaigns. Ask a platform admin to change the plan.',
    );
    expect(invites.map(({ status }) => status)).toEqual([201, 201, 402]);
    expect(reinvite.status).toBe(201);
    expect(reports.map(({ status }) => status)).toEqual([201, 402]);
    expect(overview.body.data).toMatchObject({
      plan: 'STARTER',
      limits: { runningCampaigns: 2, members: 3, scheduledReports: 1 },
      usage: { runningCampaigns: 2, members: 3, scheduledReports: 1 },
    });
  });

  it('is changed by platform admins only', async () => {
    const owner = await createTestUser({ plan: 'STARTER' });
    const admin = await createTestUser({ email: 'admin@example.com', role: Role.ADMIN });

    const byOwner = await request(app)
      .patch(`/billing/organisations/${owner.organisationId}`)
      .set('Authorization', await login(owner))
      .send({ plan: 'ENTERPRISE' });
    const byAdmin = await request(app)
      .patch(`/billing/organisations/${owner.organisationId}`)
      .set('Authorization', await login(admin))
      .send({ plan: 'GROWTH' });

    expect(byOwner.status).toBe(403);
    expect(byAdmin.status).toBe(200);
    expect(
      (await testPrisma.organisation.findUniqueOrThrow({ where: { id: owner.organisationId } }))
        .plan,
    ).toBe('GROWTH');
    expect(await testPrisma.auditLog.count({ where: { action: 'billing.plan.changed' } })).toBe(1);
  });
});
