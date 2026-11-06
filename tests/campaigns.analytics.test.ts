/**
 * tests/campaigns.analytics.test.ts
 *
 * Integration tests against a real PostgreSQL test database (not mocks).
 * Each test starts from an empty database; Supertest binds an ephemeral port.
 */
import { execFileSync } from 'child_process';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { CampaignStatus, Role } from '@prisma/client';
import { createApp } from '@/app';
import { accountRouter } from '@/modules/account/account.routes';
import { adminRouter } from '@/modules/admin/admin.routes';
import { aiRouter } from '@/modules/ai/ai.routes';
import { billingRouter } from '@/modules/billing/billing.routes';
import { opsRouter } from '@/modules/ops/ops.routes';
import { alertsRouter } from '@/modules/alerts/alerts.routes';
import { authRouter } from '@/modules/auth/auth.routes';
import { campaignsRouter } from '@/modules/campaigns/campaigns.routes';
import { creativesRouter, mediaRouter } from '@/modules/creatives/creatives.routes';
import { deliveryRouter } from '@/modules/delivery/delivery.routes';
import { playbackRouter } from '@/modules/playback/playback.routes';
import { reportsRouter } from '@/modules/reports/reports.routes';
import { isActive } from '@/modules/demo/activity';
import { drainEvents } from '@/modules/delivery/event-queue';
import { runTrafficTick } from '@/modules/demo/traffic';
import { showsRouter } from '@/modules/shows/shows.routes';
import { invitationsRouter, teamRouter } from '@/modules/team/team.routes';
import {
  addMetrics,
  clearDatabase,
  createApprovedCreative,
  createTestCampaign,
  createTestShow,
  createTestUser,
  testPrisma,
} from './helpers/db';

type Layer = { route?: { path: string; methods: Record<string, boolean> } };

const app = createApp();
const INGEST_KEY = process.env['INGEST_API_KEY'] as string;

async function login(user: { email: string; password: string }): Promise<string> {
  const res = await request(app).post('/auth/login').send(user);
  if (res.status !== 200) throw new Error(`Login failed: ${JSON.stringify(res.body)}`);
  return `Bearer ${(res.body as { data: { token: string } }).data.token}`;
}

const validCampaign = {
  title: 'My New Campaign',
  advertiser: 'Acme',
  budgetCents: 500_000,
  cpmCents: 2500,
  impressionGoal: 200_000,
  startsAt: '2030-01-01T00:00:00.000Z',
  endsAt: '2030-02-01T00:00:00.000Z',
};

beforeEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

describe('GET /campaigns/analytics', () => {
  it('aggregates metrics and derives CTR, spend and delivery', async () => {
    const user = await createTestUser();
    const show = await createTestShow();
    const campaign = await createTestCampaign(user.id, {
      cpmCents: 2000,
      impressionGoal: 10_000,
      budgetCents: 100_000,
    });
    await addMetrics(campaign.id, show.id, [
      { impressions: 1500, clicks: 75, completions: 1200 },
      { impressions: 2000, clicks: 120, completions: 1800 },
      { impressions: 1500, clicks: 55, completions: 1000 },
    ]);

    const res = await request(app)
      .get('/campaigns/analytics')
      .set('Authorization', await login(user));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      impressions: 5000,
      clicks: 250,
      completions: 4000,
      ctr: 0.05,
      completionRate: 0.8,
      spendCents: 10_000,
      lifetimeSpendCents: 10_000,
      deliveryRate: 0.5,
      budgetUsedRate: 0.1,
    });
  });

  it('includes campaigns with no metrics as zeros', async () => {
    const user = await createTestUser();
    await createTestCampaign(user.id);

    const res = await request(app)
      .get('/campaigns/analytics')
      .set('Authorization', await login(user));

    expect(res.body.data[0]).toMatchObject({ impressions: 0, clicks: 0, ctr: 0 });
  });

  it('limits totals to the date range but keeps lifetime delivery', async () => {
    const user = await createTestUser();
    const show = await createTestShow();
    const campaign = await createTestCampaign(user.id);
    await addMetrics(campaign.id, show.id, [
      { impressions: 100, clicks: 1 },
      { impressions: 900, clicks: 9 },
    ]);

    const from = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const res = await request(app)
      .get('/campaigns/analytics')
      .query({ from })
      .set('Authorization', await login(user));

    expect(res.body.data[0]).toMatchObject({ impressions: 100, lifetimeImpressions: 1000 });
  });

  it('rejects a reversed date range', async () => {
    const user = await createTestUser();
    const res = await request(app)
      .get('/campaigns/analytics')
      .query({ from: '2030-02-01', to: '2030-01-01' })
      .set('Authorization', await login(user));

    expect(res.status).toBe(422);
  });

  it('never returns another advertiser’s campaigns', async () => {
    const owner = await createTestUser({ email: 'owner@test.com' });
    const other = await createTestUser({ email: 'other@test.com' });
    await createTestCampaign(owner.id, { title: 'Mine' });
    await createTestCampaign(other.id, { title: 'Theirs' });

    const res = await request(app)
      .get('/campaigns/analytics')
      .set('Authorization', await login(owner));

    expect(res.body.data.map((c: { title: string }) => c.title)).toEqual(['Mine']);
  });

  it('shows admins every campaign', async () => {
    const admin = await createTestUser({ email: 'admin@test.com', role: Role.ADMIN });
    const advertiser = await createTestUser({ email: 'advertiser@test.com' });
    await createTestCampaign(advertiser.id);

    const res = await request(app)
      .get('/campaigns/analytics')
      .set('Authorization', await login(admin));

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].ownerEmail).toBe('advertiser@test.com');
  });

  it.each([
    ['no header', undefined],
    ['a malformed token', 'Bearer this.is.not.a.valid.jwt'],
    ['no Bearer prefix', 'just-a-token'],
  ])('returns 401 with %s', async (_name, header) => {
    const req = request(app).get('/campaigns/analytics');
    const res = await (header ? req.set('Authorization', header) : req);

    expect(res.status).toBe(401);
  });
});

describe('GET /campaigns/:id/analytics', () => {
  it('returns the campaign, its timeseries and breakdowns', async () => {
    const user = await createTestUser();
    const show = await createTestShow('Harbour Lights');
    const campaign = await createTestCampaign(user.id);
    await addMetrics(campaign.id, show.id, [
      { impressions: 300, clicks: 3, country: 'DE' },
      { impressions: 100, clicks: 1, country: 'FR' },
    ]);

    const res = await request(app)
      .get(`/campaigns/${campaign.id}/analytics`)
      .query({ from: new Date(Date.now() - 86_400_000).toISOString() })
      .set('Authorization', await login(user));

    expect(res.status).toBe(200);
    expect(res.body.data.campaign.impressions).toBe(400);
    expect(res.body.data.timeseries).toHaveLength(2);
    expect(res.body.data.breakdown.country).toMatchObject([
      { key: 'DE', impressions: 300 },
      { key: 'FR', impressions: 100 },
    ]);
    expect(res.body.data.breakdown.slot).toMatchObject([{ key: 'MID_ROLL', impressions: 400 }]);
    expect(res.body.data.breakdown.show).toMatchObject([{ key: 'Harbour Lights' }]);
  });

  it('returns 404 for another advertiser’s campaign', async () => {
    const owner = await createTestUser({ email: 'owner@test.com' });
    const other = await createTestUser({ email: 'other@test.com' });
    const campaign = await createTestCampaign(owner.id);

    const res = await request(app)
      .get(`/campaigns/${campaign.id}/analytics`)
      .set('Authorization', await login(other));

    expect(res.status).toBe(404);
  });
});

describe('POST /auth/login', () => {
  it('returns a JWT', async () => {
    const user = await createTestUser({ email: 'login@test.com', password: 'MyPass1234!' });

    const res = await request(app).post('/auth/login').send(user);

    expect(res.status).toBe(200);
    expect(res.body.data.token.split('.')).toHaveLength(3);
  });

  it('accepts an email with different casing', async () => {
    const user = await createTestUser({ email: 'mixed@test.com' });

    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'MIXED@test.com', password: user.password });

    expect(res.status).toBe(200);
  });

  it('returns 401 with a wrong password', async () => {
    const user = await createTestUser();

    const res = await request(app)
      .post('/auth/login')
      .send({ email: user.email, password: 'WrongPassword!' });

    expect(res.status).toBe(401);
  });

  it('does real hashing work for an unknown email', async () => {
    const compare = jest.spyOn(bcrypt, 'compare');

    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'SomePass1234' });

    expect(res.status).toBe(401);
    const hash = compare.mock.calls[0]?.[1] as string;
    expect(hash).toHaveLength(60);
    expect(bcrypt.getRounds(hash)).toBe(12);
    compare.mockRestore();
  });

  it('returns 422 when the body fails validation', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'not-an-email', password: 'short' });

    expect(res.status).toBe(422);
    expect(res.body.errors).toBeDefined();
  });
});

describe('Campaign management', () => {
  it('lists with pagination and a status filter', async () => {
    const user = await createTestUser();
    await createTestCampaign(user.id, { title: 'Running' });
    await createTestCampaign(user.id, { title: 'Stopped', status: CampaignStatus.PAUSED });
    const token = await login(user);

    const all = await request(app).get('/campaigns').set('Authorization', token);
    expect(all.body.meta).toMatchObject({ total: 2, page: 1, limit: 20, totalPages: 1 });

    const active = await request(app).get('/campaigns?status=ACTIVE').set('Authorization', token);
    expect(active.body.data.map((c: { title: string }) => c.title)).toEqual(['Running']);
  });

  it('creates a campaign with targeting', async () => {
    const user = await createTestUser();

    const res = await request(app)
      .post('/campaigns')
      .set('Authorization', await login(user))
      .send({ ...validCampaign, targetCountries: ['de'], targetSlots: ['PRE_ROLL'] });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      title: 'My New Campaign',
      status: 'ACTIVE',
      userId: user.id,
      targetCountries: ['DE'],
      targetSlots: ['PRE_ROLL'],
    });
  });

  it.each([
    ['a missing title', { title: undefined }],
    ['a short title', { title: 'AB' }],
    ['a negative budget', { budgetCents: -1 }],
    ['an end before the start', { endsAt: '2029-01-01T00:00:00.000Z' }],
    ['an unknown slot', { targetSlots: ['HALF_TIME'] }],
  ])('rejects %s', async (_name, change) => {
    const user = await createTestUser();

    const res = await request(app)
      .post('/campaigns')
      .set('Authorization', await login(user))
      .send({ ...validCampaign, ...change });

    expect(res.status).toBe(422);
  });

  it('pauses a campaign', async () => {
    const user = await createTestUser();
    const campaign = await createTestCampaign(user.id);

    const res = await request(app)
      .patch(`/campaigns/${campaign.id}`)
      .set('Authorization', await login(user))
      .send({ status: 'PAUSED' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PAUSED');
    expect(res.body.data.title).toBe(campaign.title);
  });

  it('checks a partial date change against the stored dates', async () => {
    const user = await createTestUser();
    const campaign = await createTestCampaign(user.id);

    const res = await request(app)
      .patch(`/campaigns/${campaign.id}`)
      .set('Authorization', await login(user))
      .send({ endsAt: '2000-01-01T00:00:00.000Z' });

    expect(res.status).toBe(422);
  });

  it('refuses to restart a completed campaign', async () => {
    const user = await createTestUser();
    const campaign = await createTestCampaign(user.id, { status: CampaignStatus.COMPLETED });

    const res = await request(app)
      .patch(`/campaigns/${campaign.id}`)
      .set('Authorization', await login(user))
      .send({ status: 'ACTIVE' });

    expect(res.status).toBe(409);
  });

  it('deletes a campaign and its metrics', async () => {
    const user = await createTestUser();
    const show = await createTestShow();
    const campaign = await createTestCampaign(user.id);
    await addMetrics(campaign.id, show.id, [{ impressions: 10, clicks: 1 }]);

    const res = await request(app)
      .delete(`/campaigns/${campaign.id}`)
      .set('Authorization', await login(user));

    expect(res.status).toBe(204);
    expect(await testPrisma.metric.count()).toBe(0);
  });

  it('does not let one advertiser change another’s campaign', async () => {
    const owner = await createTestUser({ email: 'owner@test.com' });
    const other = await createTestUser({ email: 'other@test.com' });
    const campaign = await createTestCampaign(owner.id);
    const token = await login(other);

    const patched = await request(app)
      .patch(`/campaigns/${campaign.id}`)
      .set('Authorization', token)
      .send({ status: 'PAUSED' });
    const deleted = await request(app)
      .delete(`/campaigns/${campaign.id}`)
      .set('Authorization', token);

    expect(patched.status).toBe(404);
    expect(deleted.status).toBe(404);
  });
});

describe('GET /ad-decision', () => {
  const decide = (query: Record<string, string>, key = INGEST_KEY) =>
    request(app).get('/ad-decision').set('x-ingest-key', key).query(query);

  const placement = { slot: 'MID_ROLL', country: 'DE', device: 'CTV' };

  it('requires the ingest key', async () => {
    const show = await createTestShow();

    const res = await decide({ ...placement, showId: show.id }, 'wrong-key');

    expect(res.status).toBe(401);
  });

  it('serves an eligible campaign with no targeting', async () => {
    const user = await createTestUser();
    const show = await createTestShow();
    await createTestCampaign(user.id, { title: 'Everywhere' });

    const res = await decide({ ...placement, showId: show.id });

    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Everywhere');
  });

  it('picks the campaign furthest behind schedule', async () => {
    const user = await createTestUser();
    const show = await createTestShow();
    const ahead = await createTestCampaign(user.id, { title: 'Ahead' });
    await createTestCampaign(user.id, { title: 'Behind' });
    await addMetrics(ahead.id, show.id, [{ impressions: 400_000, clicks: 0 }]);

    const res = await decide({ ...placement, showId: show.id });

    expect(res.body.data.title).toBe('Behind');
  });

  it.each([
    ['country', { targetCountries: ['FR'] }, { country: 'FR' }],
    ['device', { targetDevices: ['MOBILE' as const] }, { device: 'MOBILE' }],
    ['slot', { targetSlots: ['PRE_ROLL' as const] }, { slot: 'PRE_ROLL' }],
  ])('respects %s targeting', async (_name, targeting, matching) => {
    const user = await createTestUser();
    const show = await createTestShow();
    await createTestCampaign(user.id, targeting);

    const miss = await decide({ ...placement, showId: show.id });
    expect(miss.body.data).toBeNull();

    const hit = await decide({ ...placement, showId: show.id, ...matching });
    expect(hit.body.data).not.toBeNull();
  });

  it('matches genre targeting', async () => {
    const user = await createTestUser();
    const show = await createTestShow('Little Explorers', 'Kids');
    await createTestCampaign(user.id, { targetGenres: ['Kids'] });

    const res = await decide({ ...placement, showId: show.id });

    expect(res.body.data).not.toBeNull();
  });

  it.each([
    ['paused', { status: CampaignStatus.PAUSED }],
    ['not started', { startsAt: new Date(Date.now() + 3_600_000) }],
    ['ended', { endsAt: new Date(Date.now() - 3_600_000) }],
  ])('skips %s campaigns', async (_name, state) => {
    const user = await createTestUser();
    const show = await createTestShow();
    await createTestCampaign(user.id, state);

    const res = await decide({ ...placement, showId: show.id });

    expect(res.body.data).toBeNull();
  });

  it('skips a campaign that reached its impression goal', async () => {
    const user = await createTestUser();
    const show = await createTestShow();
    const campaign = await createTestCampaign(user.id, { impressionGoal: 100 });
    await addMetrics(campaign.id, show.id, [{ impressions: 100, clicks: 0 }]);

    const res = await decide({ ...placement, showId: show.id });

    expect(res.body.data).toBeNull();
  });

  it('skips a campaign with no budget left', async () => {
    const user = await createTestUser();
    const show = await createTestShow();
    const campaign = await createTestCampaign(user.id, { budgetCents: 1000, cpmCents: 1000 });
    await addMetrics(campaign.id, show.id, [{ impressions: 1000, clicks: 0 }]);

    const res = await decide({ ...placement, showId: show.id });

    expect(res.body.data).toBeNull();
  });
});

describe('POST /events', () => {
  it('requires the ingest key', async () => {
    const res = await request(app)
      .post('/events')
      .set('x-ingest-key', 'wrong')
      .send({ events: [] });

    expect(res.status).toBe(401);
  });

  it('rejects an empty batch and unknown event types', async () => {
    const send = (events: unknown[]) =>
      request(app).post('/events').set('x-ingest-key', INGEST_KEY).send({ events });

    expect((await send([])).status).toBe(422);
    expect((await send([{ type: 'HOVER' }])).status).toBe(422);
  });
});

describe('Guest account', () => {
  const guest = () => createTestUser({ email: 'guest@test.com', role: Role.GUEST });

  it('can read every campaign', async () => {
    const advertiser = await createTestUser({ email: 'advertiser@test.com' });
    await createTestCampaign(advertiser.id, { title: 'Visible' });

    const res = await request(app)
      .get('/campaigns/analytics')
      .set('Authorization', await login(await guest()));

    expect(res.body.data.map((c: { title: string }) => c.title)).toEqual(['Visible']);
  });

  it('cannot create, change or delete campaigns', async () => {
    const advertiser = await createTestUser({ email: 'advertiser@test.com' });
    const campaign = await createTestCampaign(advertiser.id);
    const token = await login(await guest());

    const created = await request(app)
      .post('/campaigns')
      .set('Authorization', token)
      .send(validCampaign);
    const changed = await request(app)
      .patch(`/campaigns/${campaign.id}`)
      .set('Authorization', token)
      .send({ status: 'PAUSED' });
    const deleted = await request(app)
      .delete(`/campaigns/${campaign.id}`)
      .set('Authorization', token);

    expect([created.status, changed.status, deleted.status]).toEqual([403, 403, 403]);
    expect(await testPrisma.campaign.count()).toBe(1);
  });
});

describe('Demo traffic', () => {
  it('serves ads to running campaigns and stores the results', async () => {
    const user = await createTestUser();
    await createTestShow();
    const campaign = await createTestCampaign(user.id);
    await createApprovedCreative(campaign.id, user.id);

    const stored = await runTrafficTick();
    await drainEvents();

    expect(stored).toBeGreaterThan(0);
    const totals = await testPrisma.metric.aggregate({ _sum: { impressions: true } });
    expect(totals._sum.impressions).toBe(30);
  });

  it('does nothing without shows', async () => {
    await expect(runTrafficTick()).resolves.toBe(0);
  });

  it('treats a request as activity', async () => {
    const user = await createTestUser();
    const token = await login(user);

    await request(app).get('/shows').set('Authorization', token);

    expect(isActive()).toBe(true);
  });
});

describe('API docs', () => {
  const routesOf = (router: { stack: Layer[] }, prefix: string): string[] =>
    router.stack.flatMap(({ route }) =>
      route
        ? Object.keys(route.methods).map(
            (method) => `${method} ${(prefix + route.path).replace(/\/$/, '')}`,
          )
        : [],
    );

  it('serves a valid OpenAPI document', async () => {
    const res = await request(app).get('/openapi.json');

    expect(res.status).toBe(200);
    expect(() =>
      execFileSync(process.execPath, ['scripts/validate-openapi.mjs'], {
        input: JSON.stringify(res.body),
        stdio: ['pipe', 'ignore', 'pipe'],
      }),
    ).not.toThrow();
  });

  it('documents every route', async () => {
    const { body } = await request(app).get('/openapi.json');
    const documented = Object.entries(body.paths as Record<string, object>).flatMap(
      ([path, methods]) =>
        Object.keys(methods).map((method) => `${method} ${path.replace(/{(\w+)}/g, ':$1')}`),
    );

    const actual = [
      ...routesOf(authRouter as never, '/auth'),
      ...routesOf(accountRouter as never, '/account'),
      ...routesOf(teamRouter as never, '/team'),
      ...routesOf(invitationsRouter as never, '/invitations'),
      ...routesOf(adminRouter as never, '/admin'),
      ...routesOf(campaignsRouter as never, '/campaigns'),
      ...routesOf(showsRouter as never, '/shows'),
      ...routesOf(deliveryRouter as never, ''),
      ...routesOf(creativesRouter as never, '/creatives'),
      ...routesOf(mediaRouter as never, ''),
      ...routesOf(playbackRouter as never, ''),
      ...routesOf(reportsRouter as never, '/reports'),
      ...routesOf(alertsRouter as never, '/alerts'),
      ...routesOf(aiRouter as never, '/ai'),
      ...routesOf(billingRouter as never, '/billing'),
      ...routesOf(opsRouter as never, ''),
    ];

    expect(documented).toEqual(expect.arrayContaining(actual));
  });

  it('uses the validation rules in request bodies', async () => {
    const { body } = await request(app).get('/openapi.json');
    const schema = body.paths['/campaigns'].post.requestBody.content['application/json'].schema;

    expect(schema.required).toContain('budgetCents');
    expect(schema.properties.startsAt.format).toBe('date-time');
    expect(schema.properties.targetSlots.items.enum).toContain('MID_ROLL');
  });

  it('serves Swagger UI under the strict content security policy', async () => {
    const page = await request(app).get('/docs');
    const script = await request(app).get('/docs/assets/swagger-ui-bundle.js');

    expect(page.status).toBe(200);
    expect(page.text).toContain('swagger-ui');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(script.status).toBe(200);
  });
});

describe('Service basics', () => {
  it('reports that it is running without using the database', async () => {
    const res = await request(app).get('/live');

    expect(res.status).toBe(200);
  });

  it('tells the sign-in page it is not the public demo', async () => {
    const res = await request(app).get('/auth/options');

    expect(res.body.data).toEqual({ demo: false, signUp: true, localMailbox: true });
  });

  it('does not apply the ad server key to other paths', async () => {
    const res = await request(app).get('/no-such-page');

    expect(res.status).toBe(404);
  });

  it('reports health including the database', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('returns the show catalogue to logged-in users', async () => {
    const user = await createTestUser();
    await createTestShow('Harbour Lights', 'Drama');

    const res = await request(app)
      .get('/shows')
      .set('Authorization', await login(user));

    expect(res.body.data).toMatchObject([{ title: 'Harbour Lights', genre: 'Drama' }]);
  });
});
