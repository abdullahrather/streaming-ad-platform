/**
 * tests/campaign-rules.test.ts
 *
 * Frequency caps, schedules, pacing, audiences, competitive separation, auctions,
 * A/B tests and forecasts.
 */
import crypto from 'crypto';
import request from 'supertest';
import { AdSlot, Device } from '@prisma/client';
import { createApp } from '@/app';
import { localTimeAt } from '@/lib/platform-time';
import { redis } from '@/lib/redis';
import { forecastCampaign } from '@/modules/campaigns/forecast.service';
import { createCampaignSchema } from '@/modules/campaigns/campaigns.schema';
import { isSignificantDifference } from '@/modules/creatives/creatives.service';
import { deliveryService } from '@/modules/delivery/delivery.service';
import { drainEvents } from '@/modules/delivery/event-queue';
import { flushInventory, noteViewedGenre } from '@/modules/delivery/viewer-activity';
import {
  clearDatabase,
  createApprovedCreative,
  createTestCampaign,
  createTestShow,
  createTestUser,
  testPrisma,
} from './helpers/db';

const app = createApp();
const INGEST_KEY = process.env['INGEST_API_KEY'] as string;
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const placement = { slot: 'MID_ROLL', country: 'DE', device: 'CTV' } as const;

const setup = async (overrides = {}) => {
  const user = await createTestUser();
  const show = await createTestShow();
  const campaign = await createTestCampaign(user.id, overrides);
  return { user, show, campaign };
};

const decide = (showId: string, options = {}) =>
  deliveryService.decide({ ...placement, showId }, options);

const login = async (user: { email: string; password: string }): Promise<string> => {
  const res = await request(app).post('/auth/login').send(user);
  return `Bearer ${(res.body as { data: { token: string } }).data.token}`;
};

const flight = (days: number) => ({
  startsAt: new Date(Date.now() + DAY_MS),
  endsAt: new Date(Date.now() + DAY_MS * (1 + days)),
});

const forecastInput = (overrides = {}) =>
  createCampaignSchema.parse({
    title: 'Forecast',
    advertiser: 'Acme',
    budgetCents: 100_000_000,
    cpmCents: 2000,
    impressionGoal: 1_000_000,
    ...flight(7),
    ...overrides,
  });

/** Four weeks of steady traffic: 100 requests an hour for each listed placement. */
const seedInventory = async (requests = 100): Promise<void> => {
  const end = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  const rows = Array.from({ length: 28 * 24 }, (_, hour) => ({
    bucket: new Date(end - (hour + 1) * HOUR_MS),
    genre: 'Drama',
    slot: AdSlot.MID_ROLL,
    country: 'DE',
    device: Device.CTV,
    requests,
  }));
  await testPrisma.inventoryHour.createMany({ data: rows });
  await testPrisma.inventoryHour.createMany({
    data: rows.map((row) => ({ ...row, country: 'FR' })),
  });
};

beforeEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

describe('Frequency caps', () => {
  it('stops showing a campaign to one viewer, but not to others', async () => {
    const { show } = await setup({ frequencyCapPerDay: 2 });

    const seen = [];
    for (let view = 0; view < 3; view += 1) {
      seen.push(await decide(show.id, { viewerId: 'viewer-1' }));
    }

    expect(seen.map(Boolean)).toEqual([true, true, false]);
    expect(await decide(show.id, { viewerId: 'viewer-2' })).not.toBeNull();
  });

  it('holds when one viewer sends requests at the same moment', async () => {
    const { show } = await setup({ frequencyCapPerDay: 3 });

    const results = await Promise.all(
      Array.from({ length: 40 }, () => decide(show.id, { viewerId: 'viewer-1' })),
    );

    expect(results.filter(Boolean)).toHaveLength(3);
  });
});

describe('Schedules', () => {
  const { hour, weekday } = localTimeAt(Date.now());

  it('runs inside its hours and days', async () => {
    const { show } = await setup({ activeHours: [hour], activeDays: [weekday] });

    expect(await decide(show.id)).not.toBeNull();
  });

  it('waits outside its hours', async () => {
    const { show } = await setup({ activeHours: [(hour + 1) % 24] });

    expect(await decide(show.id)).toBeNull();
  });

  it('waits on other days', async () => {
    const { show } = await setup({ activeDays: [(weekday + 1) % 7] });

    expect(await decide(show.id)).toBeNull();
  });
});

describe('Pacing and daily limits', () => {
  const patch = async (
    user: { email: string; password: string },
    id: string,
    body: Record<string, unknown>,
  ) =>
    request(app)
      .patch(`/campaigns/${id}`)
      .set('Authorization', await login(user))
      .send(body);

  it('refuses custom pacing without a daily target when updating', async () => {
    const { user, campaign } = await setup();

    const res = await patch(user, campaign.id, { pacingMode: 'CUSTOM' });

    expect(res.status).toBe(422);
    expect(await testPrisma.campaign.findUnique({ where: { id: campaign.id } })).toMatchObject({
      pacingMode: 'ASAP',
    });
  });

  it('refuses to clear the daily target of a custom campaign', async () => {
    const { user, campaign } = await setup({ pacingMode: 'CUSTOM', dailyImpressionTarget: 100 });

    const res = await patch(user, campaign.id, { dailyImpressionTarget: null });

    expect(res.status).toBe(422);
  });

  it('accepts custom pacing with a target set now or stored already', async () => {
    const { user, campaign } = await setup({ dailyImpressionTarget: 100 });

    expect((await patch(user, campaign.id, { pacingMode: 'CUSTOM' })).status).toBe(200);
    expect((await patch(user, campaign.id, { dailyImpressionTarget: 200 })).status).toBe(200);
    expect(
      (await patch(user, campaign.id, { pacingMode: 'ASAP', dailyImpressionTarget: null })).status,
    ).toBe(200);
  });

  it('holds an even campaign back when it gets ahead of schedule', async () => {
    const { show } = await setup({
      pacingMode: 'EVEN',
      impressionGoal: 1000,
      startsAt: new Date(Date.now() - DAY_MS),
      endsAt: new Date(Date.now() + 99 * DAY_MS),
    });

    const results = await Promise.all(Array.from({ length: 200 }, () => decide(show.id)));
    await Promise.all(Array.from({ length: 200 }, () => decide(show.id)));

    // Decisions don't change delivery until impressions arrive, so feed some in.
    expect(results.filter(Boolean).length).toBeGreaterThan(0);
    const { campaigns } = await (
      await import('@/modules/delivery/decision-cache')
    ).decisionCache.get();
    const id = campaigns[0]?.id as string;
    await redis.set(`delivered:${id}`, 100);

    expect(await decide(show.id)).toBeNull();
  });

  it('lets an ASAP campaign run ahead of schedule', async () => {
    const { show, campaign } = await setup({
      pacingMode: 'ASAP',
      impressionGoal: 1000,
      startsAt: new Date(Date.now() - DAY_MS),
      endsAt: new Date(Date.now() + 99 * DAY_MS),
    });
    await decide(show.id);
    await redis.set(`delivered:${campaign.id}`, 100);

    expect(await decide(show.id)).not.toBeNull();
  });

  it('stops at a custom daily target', async () => {
    const { show } = await setup({ pacingMode: 'CUSTOM', dailyImpressionTarget: 25 });

    const results = await Promise.all(Array.from({ length: 100 }, () => decide(show.id)));

    expect(results.filter(Boolean)).toHaveLength(25);
  });

  it('stops at a daily budget', async () => {
    const { show } = await setup({ cpmCents: 2000, dailyBudgetCents: 100 });

    const results = await Promise.all(Array.from({ length: 200 }, () => decide(show.id)));

    expect(results.filter(Boolean)).toHaveLength(50);
  });

  it('requires a target for custom pacing', async () => {
    const owner = await createTestUser();

    const res = await request(app)
      .post('/campaigns')
      .set('Authorization', await login(owner))
      .send({
        title: 'Needs a target',
        advertiser: 'Acme',
        budgetCents: 1000,
        cpmCents: 1000,
        impressionGoal: 100,
        startsAt: '2030-01-01',
        endsAt: '2030-02-01',
        pacingMode: 'CUSTOM',
      });

    expect(res.status).toBe(422);
  });
});

describe('Competitive separation', () => {
  it('keeps rival brands out of the same break', async () => {
    const { user, show, campaign } = await setup({ competitiveCategory: 'Automotive' });
    const rival = await createTestCampaign(user.id, { competitiveCategory: 'Automotive' });
    const breakId = 'break-1';

    const first = await decide(show.id, { breakId });
    const second = await decide(show.id, { breakId });

    expect([campaign.id, rival.id]).toContain(first?.campaignId);
    expect(second).toBeNull();
  });

  it('allows a different category in the same break', async () => {
    const { user, show } = await setup({ competitiveCategory: 'Automotive' });
    await createTestCampaign(user.id, { competitiveCategory: 'Telecoms' });
    const breakId = 'break-1';

    const first = await decide(show.id, { breakId });
    const second = await decide(show.id, { breakId });

    expect(second).not.toBeNull();
    expect(second?.campaignId).not.toBe(first?.campaignId);
  });

  it('allows rivals in different breaks', async () => {
    const { user, show } = await setup({ competitiveCategory: 'Automotive' });
    await createTestCampaign(user.id, { competitiveCategory: 'Automotive' });

    await decide(show.id, { breakId: 'break-1' });

    expect(await decide(show.id, { breakId: 'break-2' })).not.toBeNull();
  });
});

describe('Audiences', () => {
  const segmentFor = async (organisationId: string) =>
    testPrisma.audienceSegment.create({
      data: { organisationId, name: 'Fans', genres: ['Sports'], minViews: 2 },
    });

  it('serves viewers who consented and watch enough of the genre', async () => {
    const { user, show } = await setup();
    const segment = await segmentFor(user.organisationId);
    await testPrisma.campaign.updateMany({ data: { targetSegmentIds: [segment.id] } });

    await noteViewedGenre('fan', 'Sports', true);
    expect(await decide(show.id, { viewerId: 'fan', consent: true })).toBeNull();

    await noteViewedGenre('fan', 'Sports', true);
    expect(await decide(show.id, { viewerId: 'fan', consent: true })).not.toBeNull();
  });

  it('stores nothing about a viewer who did not consent', async () => {
    await noteViewedGenre('private', 'Sports', false);

    expect(await redis.exists('profile:private')).toBe(0);
  });

  it('ignores a profile when consent has been withdrawn', async () => {
    const { user, show } = await setup();
    const segment = await segmentFor(user.organisationId);
    await testPrisma.campaign.updateMany({ data: { targetSegmentIds: [segment.id] } });
    await noteViewedGenre('fan', 'Sports', true);
    await noteViewedGenre('fan', 'Sports', true);

    expect(await decide(show.id, { viewerId: 'fan', consent: false })).toBeNull();
  });

  it('deletes a profile when the viewer asks', async () => {
    await noteViewedGenre('fan', 'Sports', true);
    const session = await request(app)
      .post('/player/session')
      .send({ viewerId: 'fan', consent: true });

    const res = await request(app)
      .delete('/player/profile')
      .query({ token: session.body.data.token as string });

    expect(res.status).toBe(204);
    expect(await redis.exists('profile:fan')).toBe(0);
  });

  it('stops a campaign whose audiences have all gone', async () => {
    const { user, show } = await setup();
    const segment = await segmentFor(user.organisationId);
    await testPrisma.campaign.updateMany({ data: { targetSegmentIds: [segment.id] } });
    await testPrisma.audienceSegment.delete({ where: { id: segment.id } });

    expect(await decide(show.id, { viewerId: 'stranger', consent: false })).toBeNull();
  });

  it('keeps a campaign running on the audiences it has left', async () => {
    const { user, show } = await setup();
    const kept = await segmentFor(user.organisationId);
    const gone = await segmentFor(user.organisationId);
    await testPrisma.campaign.updateMany({ data: { targetSegmentIds: [kept.id, gone.id] } });
    await testPrisma.audienceSegment.delete({ where: { id: gone.id } });
    await noteViewedGenre('fan', 'Sports', true);
    await noteViewedGenre('fan', 'Sports', true);

    expect(await decide(show.id, { viewerId: 'fan', consent: true })).not.toBeNull();
    expect(await decide(show.id, { viewerId: 'stranger', consent: false })).toBeNull();
  });

  it('refuses to delete an audience a campaign still uses', async () => {
    const { user, campaign } = await setup({ status: 'PAUSED' });
    const segment = await segmentFor(user.organisationId);
    await testPrisma.campaign.updateMany({ data: { targetSegmentIds: [segment.id] } });
    const token = await login(user);

    const refused = await request(app)
      .delete(`/segments/${segment.id}`)
      .set('Authorization', token);
    expect(refused.status).toBe(409);
    expect(await testPrisma.audienceSegment.count()).toBe(1);

    await testPrisma.campaign.update({
      where: { id: campaign.id },
      data: { status: 'COMPLETED' },
    });
    const allowed = await request(app)
      .delete(`/segments/${segment.id}`)
      .set('Authorization', token);
    expect(allowed.status).toBe(204);
  });

  it('keeps segments private to their organisation', async () => {
    const owner = await createTestUser({ email: 'owner@test.com' });
    const rival = await createTestUser({ email: 'rival@test.com' });
    const segment = await segmentFor(owner.organisationId);
    const token = await login(rival);

    const list = await request(app).get('/segments').set('Authorization', token);
    const remove = await request(app).delete(`/segments/${segment.id}`).set('Authorization', token);
    const borrow = await request(app)
      .post('/campaigns')
      .set('Authorization', token)
      .send({
        title: 'Borrowed audience',
        advertiser: 'Acme',
        budgetCents: 1000,
        cpmCents: 1000,
        impressionGoal: 100,
        startsAt: '2030-01-01',
        endsAt: '2030-02-01',
        targetSegmentIds: [segment.id],
      });

    expect(list.body.data).toEqual([]);
    expect(remove.status).toBe(404);
    expect(borrow.status).toBe(422);
  });

  it('builds a profile from real playback only with consent', async () => {
    const { user, show, campaign } = await setup();
    await createApprovedCreative(campaign.id, user.id);

    const watch = async (viewerId: string, consent: boolean) => {
      const session = await request(app).post('/player/session').send({ viewerId, consent });
      const { text } = await request(app)
        .get('/vast')
        .set('User-Agent', BROWSER)
        .query({ ...placement, showId: show.id, token: session.body.data.token as string });
      const link = new URL(/<Impression[^>]*><!\[CDATA\[(.*?)\]\]>/.exec(text)?.[1] as string);
      await request(app)
        .get(link.pathname + link.search)
        .set('User-Agent', BROWSER);
    };

    await watch('agreed', true);
    await watch('declined', false);

    expect(await redis.hget('profile:agreed', 'Drama')).toBe('1');
    expect(await redis.exists('profile:declined')).toBe(0);
  });
});

describe('Auctions', () => {
  const bid = (userId: string, cpmCents: number) =>
    createTestCampaign(userId, { deliveryType: 'AUCTION', cpmCents });

  it('gives the win to the top bid at just above the next one', async () => {
    const { user, show } = await setup({ status: 'PAUSED' });
    await bid(user.id, 900);
    const top = await bid(user.id, 2000);

    const decision = await decide(show.id);

    expect(decision?.campaignId).toBe(top.id);
    expect(decision?.priceCpmCents).toBe(901);
  });

  it('charges the floor price when there is no competition', async () => {
    const { user, show } = await setup({ status: 'PAUSED' });
    await bid(user.id, 2000);

    expect((await decide(show.id))?.priceCpmCents).toBe(100);
  });

  it('never charges more than the bid', async () => {
    const { user, show } = await setup({ status: 'PAUSED' });
    await bid(user.id, 2000);
    await bid(user.id, 2000);

    expect((await decide(show.id))?.priceCpmCents).toBe(2000);
  });

  it('turns away bids under the floor', async () => {
    const { user, show } = await setup({ status: 'PAUSED' });
    await bid(user.id, 50);

    expect(await decide(show.id)).toBeNull();
  });

  it('ignores bids under the floor when setting the price', async () => {
    const { user, show } = await setup({ status: 'PAUSED' });
    await bid(user.id, 99);
    await bid(user.id, 2000);

    expect((await decide(show.id))?.priceCpmCents).toBe(100);
  });

  it('puts guaranteed campaigns behind schedule first', async () => {
    const { show, user, campaign } = await setup();
    await bid(user.id, 99_999);

    expect((await decide(show.id))?.campaignId).toBe(campaign.id);
  });

  it('runs ahead of guaranteed campaigns that have delivered enough', async () => {
    const { user, show, campaign } = await setup({
      impressionGoal: 1000,
      startsAt: new Date(Date.now() - DAY_MS),
      endsAt: new Date(Date.now() + 99 * DAY_MS),
    });
    await decide(show.id);
    await redis.set(`delivered:${campaign.id}`, 100);
    const auction = await bid(user.id, 2000);

    expect((await decide(show.id))?.campaignId).toBe(auction.id);
  });

  it('records what the auction really charged', async () => {
    const { user, show } = await setup({ status: 'PAUSED' });
    await bid(user.id, 900);
    const top = await bid(user.id, 2000);
    const decision = await decide(show.id);

    await request(app)
      .post('/events')
      .set('x-ingest-key', INGEST_KEY)
      .send({
        events: [
          {
            ...placement,
            eventId: crypto.randomUUID(),
            type: 'IMPRESSION',
            campaignId: top.id,
            showId: show.id,
            occurredAt: new Date().toISOString(),
            priceCpmCents: decision?.priceCpmCents,
          },
        ],
      });
    await drainEvents();

    const [metric] = await testPrisma.metric.findMany({ where: { campaignId: top.id } });
    expect(Number(metric?.costMillicents)).toBe(901);
  });

  it('stops at its budget using real prices, however fast requests arrive', async () => {
    const { user, show } = await setup({ status: 'PAUSED' });
    await createTestCampaign(user.id, {
      deliveryType: 'AUCTION',
      cpmCents: 2000,
      budgetCents: 1,
      impressionGoal: 1_000_000,
    });

    const results = await Promise.all(Array.from({ length: 100 }, () => decide(show.id)));

    // One cent is 1,000 millicents, and the floor price is 100 per impression.
    expect(results.filter(Boolean)).toHaveLength(10);
  });
});

describe('Creative rotation and A/B tests', () => {
  it('splits delivery by weight', async () => {
    const { user, show, campaign } = await setup();
    const heavy = await createApprovedCreative(campaign.id, user.id, { weight: 9 });
    const light = await createApprovedCreative(campaign.id, user.id, { weight: 1 });

    const results = await Promise.all(
      Array.from({ length: 2000 }, () => decide(show.id, { requireCreative: true })),
    );
    const count = (id: string) => results.filter((r) => r?.creative?.id === id).length;

    expect(count(heavy.id) / count(light.id)).toBeGreaterThan(6);
    expect(count(heavy.id) / count(light.id)).toBeLessThan(13);
  });

  it('never serves an ad with no share', async () => {
    const { user, show, campaign } = await setup();
    const paused = await createApprovedCreative(campaign.id, user.id, { weight: 0 });
    await createApprovedCreative(campaign.id, user.id, { weight: 1 });

    const results = await Promise.all(
      Array.from({ length: 100 }, () => decide(show.id, { requireCreative: true })),
    );

    expect(results.some((result) => result?.creative?.id === paused.id)).toBe(false);
  });

  it('calls a real difference significant, and a small one not', () => {
    const results = (impressions: number, clicks: number) => ({
      impressions,
      clicks,
      completions: 0,
      ctr: clicks / impressions,
      completionRate: 0,
    });

    expect(isSignificantDifference(results(10_000, 100), results(10_000, 160))).toBe(true);
    expect(isSignificantDifference(results(10_000, 100), results(10_000, 110))).toBe(false);
  });

  it('names a leader only when the data supports it', async () => {
    const { user, campaign } = await setup();
    const token = await login(user);
    const winner = await createApprovedCreative(campaign.id, user.id);
    const loser = await createApprovedCreative(campaign.id, user.id);
    const results = (creativeId: string, impressions: number, clicks: number) =>
      testPrisma.creativeMetric.create({
        data: { creativeId, bucket: new Date(), impressions, clicks },
      });

    await results(winner.id, 500, 50);
    await results(loser.id, 500, 5);
    const early = await request(app)
      .get('/creatives')
      .query({ campaignId: campaign.id })
      .set('Authorization', token);
    expect(
      early.body.data.every((c: { comparison: string }) => c.comparison === 'NOT_ENOUGH_DATA'),
    ).toBe(true);

    await testPrisma.creativeMetric.updateMany({ data: { impressions: { increment: 5000 } } });
    const later = await request(app)
      .get('/creatives')
      .query({ campaignId: campaign.id })
      .set('Authorization', token);
    const verdict = (id: string) =>
      (later.body.data as Array<{ id: string; comparison: string }>).find((c) => c.id === id)
        ?.comparison;

    expect(verdict(winner.id)).toBe('LEADING');
    expect(verdict(loser.id)).toBe('BEHIND');
  });

  it('counts results per ad through the queue', async () => {
    const { user, show, campaign } = await setup();
    const creative = await createApprovedCreative(campaign.id, user.id);
    const event = (type: string) => ({
      ...placement,
      type,
      eventId: crypto.randomUUID(),
      campaignId: campaign.id,
      creativeId: creative.id,
      showId: show.id,
      occurredAt: new Date().toISOString(),
    });

    await request(app)
      .post('/events')
      .set('x-ingest-key', INGEST_KEY)
      .send({ events: [event('IMPRESSION'), event('IMPRESSION'), event('CLICK')] });
    await drainEvents();

    expect(await testPrisma.creativeMetric.findFirst()).toMatchObject({
      impressions: 2,
      clicks: 1,
    });
  });

  it('lets a manager change an ad’s share, but not a stranger', async () => {
    const { user, campaign } = await setup();
    const stranger = await createTestUser({ email: 'stranger@test.com' });
    const creative = await createApprovedCreative(campaign.id, user.id);

    const allowed = await request(app)
      .patch(`/creatives/${creative.id}`)
      .set('Authorization', await login(user))
      .send({ weight: 5 });
    const refused = await request(app)
      .patch(`/creatives/${creative.id}`)
      .set('Authorization', await login(stranger))
      .send({ weight: 9 });

    expect(allowed.status).toBe(204);
    expect(refused.status).toBe(404);
  });
});

describe('Inventory and reach', () => {
  it('counts ad requests, even when no ad is served, and can save them repeatedly', async () => {
    const show = await createTestShow();
    await testPrisma.show.update({ where: { id: show.id }, data: { genre: 'Sports' } });

    await decide(show.id, { viewerId: 'a' });
    await decide(show.id, { viewerId: 'b' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    await flushInventory();
    await flushInventory();

    const rows = await testPrisma.inventoryHour.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ genre: 'Sports', requests: 2 });
    expect((await testPrisma.audienceDay.findFirst())?.viewers).toBe(2);
  });

  it('measures how many different viewers saw a campaign', async () => {
    const { user, show, campaign } = await setup();
    const token = await login(user);
    const impression = (viewerId: string) => ({
      ...placement,
      type: 'IMPRESSION',
      eventId: crypto.randomUUID(),
      campaignId: campaign.id,
      showId: show.id,
      viewerId,
      occurredAt: new Date().toISOString(),
    });

    await request(app)
      .post('/events')
      .set('x-ingest-key', INGEST_KEY)
      .send({ events: [impression('a'), impression('a'), impression('b')] });

    const res = await request(app)
      .get(`/campaigns/${campaign.id}/analytics`)
      .set('Authorization', token);

    expect(res.body.data.reach).toBe(2);
  });
});

describe('Forecasts', () => {
  const audience = (viewers = 1000) =>
    testPrisma.audienceDay.create({
      data: { day: '2026-01-01', viewers, consented: viewers / 2, allTime: viewers * 5 },
    });

  it('adds up matching inventory across the flight', async () => {
    await seedInventory();

    const forecast = await forecastCampaign(forecastInput());

    // 200 requests an hour across two countries, for 168 hours.
    expect(forecast.availableImpressions).toBeGreaterThanOrEqual(200 * 167);
    expect(forecast.availableImpressions).toBeLessThanOrEqual(200 * 169);
  });

  it('narrows to the targeting', async () => {
    await seedInventory();

    const all = await forecastCampaign(forecastInput());
    const german = await forecastCampaign(forecastInput({ targetCountries: ['DE'] }));

    expect(german.availableImpressions).toBeCloseTo(all.availableImpressions / 2, -2);
  });

  it('narrows to the schedule', async () => {
    await seedInventory();

    const all = await forecastCampaign(forecastInput());
    const evenings = await forecastCampaign(
      forecastInput({ activeHours: [18, 19, 20, 21, 22, 23] }),
    );

    expect(evenings.availableImpressions / all.availableImpressions).toBeCloseTo(0.25, 1);
  });

  it('expects the goal when there is plenty of room', async () => {
    await seedInventory();

    const forecast = await forecastCampaign(forecastInput({ impressionGoal: 1000 }));

    expect(forecast.expectedImpressions).toBe(1000);
    expect(forecast.warnings).toEqual([]);
  });

  it('warns when the inventory can’t reach the goal', async () => {
    await seedInventory();

    const forecast = await forecastCampaign(forecastInput({ impressionGoal: 10_000_000 }));

    expect(forecast.expectedImpressions).toBeLessThan(40_000);
    expect(forecast.warnings).toContain('NOT_ENOUGH_INVENTORY');
  });

  it('expects nothing from a bid under the auction floor', async () => {
    await seedInventory();

    const forecast = await forecastCampaign(
      forecastInput({ deliveryType: 'AUCTION', cpmCents: 50, impressionGoal: 1000 }),
    );

    expect(forecast.expectedImpressions).toBe(0);
    expect(forecast.warnings).toContain('BID_BELOW_FLOOR');
    expect(forecast.warnings).not.toContain('NOT_ENOUGH_INVENTORY');
  });

  it('applies the budget and daily limits', async () => {
    await seedInventory();

    const small = await forecastCampaign(
      forecastInput({ budgetCents: 2000, impressionGoal: 5000 }),
    );
    const daily = await forecastCampaign(
      forecastInput({ pacingMode: 'CUSTOM', dailyImpressionTarget: 100, impressionGoal: 5000 }),
    );

    expect(small.expectedImpressions).toBe(1000);
    expect(small.warnings).toContain('BUDGET_BELOW_GOAL');
    expect(daily.expectedImpressions).toBe(700);
    expect(daily.warnings).toContain('LIMITS_BELOW_GOAL');
  });

  it('subtracts inventory already booked by other campaigns', async () => {
    await seedInventory();
    const free = await forecastCampaign(forecastInput());
    const user = await createTestUser();
    const { startsAt, endsAt } = flight(7);
    await createTestCampaign(user.id, { impressionGoal: 20_000, startsAt, endsAt });

    const contested = await forecastCampaign(forecastInput());

    expect(contested.expectedImpressions).toBeCloseTo(free.expectedImpressions - 20_000, -2);
  });

  it('limits reach to the audience, and repeats views beyond it', async () => {
    await seedInventory();
    await audience(1000);

    const light = await forecastCampaign(forecastInput({ impressionGoal: 500 }));
    const heavy = await forecastCampaign(forecastInput({ impressionGoal: 30_000 }));

    expect(light.expectedReach).toBeGreaterThan(450);
    expect(light.averageFrequency).toBeLessThan(1.2);
    expect(heavy.expectedReach).toBeLessThanOrEqual(5000);
    expect(heavy.averageFrequency).toBeGreaterThan(5);
  });

  it('limits delivery by the frequency cap', async () => {
    await seedInventory();
    await audience(100);

    const forecast = await forecastCampaign(
      forecastInput({ frequencyCapPerDay: 1, impressionGoal: 30_000 }),
    );

    expect(forecast.expectedImpressions).toBe(700);
  });

  it('counts only consenting viewers for audience campaigns', async () => {
    await seedInventory();
    await audience(1000);
    const user = await createTestUser();
    const segment = await testPrisma.audienceSegment.create({
      data: {
        organisationId: user.organisationId,
        name: 'Fans',
        genres: ['Drama'],
      },
    });

    const open = await forecastCampaign(forecastInput());
    const targeted = await forecastCampaign(forecastInput({ targetSegmentIds: [segment.id] }));

    expect(targeted.availableImpressions).toBeCloseTo(open.availableImpressions / 2, -2);
    expect(targeted.warnings).toContain('AUDIENCE_NEEDS_CONSENT');
  });

  it('says so when there is no history', async () => {
    const forecast = await forecastCampaign(forecastInput());

    expect(forecast.expectedImpressions).toBe(0);
    expect(forecast.warnings).toContain('NO_HISTORY');
  });

  it('is available before launch, and saved at launch', async () => {
    await seedInventory();
    const user = await createTestUser();
    const token = await login(user);
    const body = {
      title: 'New launch',
      advertiser: 'Acme',
      budgetCents: 1_000_000,
      cpmCents: 2000,
      impressionGoal: 2000,
      startsAt: flight(7).startsAt.toISOString(),
      endsAt: flight(7).endsAt.toISOString(),
    };

    const forecast = await request(app)
      .post('/campaigns/forecast')
      .set('Authorization', token)
      .send(body);
    const created = await request(app).post('/campaigns').set('Authorization', token).send(body);

    expect(forecast.status).toBe(200);
    expect(forecast.body.data.expectedImpressions).toBe(2000);
    expect(created.body.data.forecastImpressions).toBe(2000);
  });
});
