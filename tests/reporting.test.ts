/**
 * tests/reporting.test.ts
 *
 * Phase 6: reach over any range, period-over-period change, campaign comparison,
 * the report builder with CSV and PDF export, scheduled reports by email, and
 * alerts. Runs against the real test database and Redis.
 */
import request from 'supertest';
import { AdSlot, Device, OrganisationRole, ReportSchedule, Role } from '@prisma/client';
import { createApp } from '@/app';
import { reachBetween } from '@/lib/redis';
import { alertsService, ALERT_RULES } from '@/modules/alerts/alerts.service';
import { enqueueEvents } from '@/modules/delivery/event-queue';
import { claimAndSend, runDueReports } from '@/modules/reports/report-delivery';
import { nextRunAfter } from '@/modules/reports/reports.service';
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

/** Another member of an existing organisation. */
const addMember = async (organisationId: string, role: OrganisationRole, email: string) => {
  const user = await createTestUser({ email, organisationRole: role });
  await testPrisma.membership.deleteMany({ where: { userId: user.id } });
  await testPrisma.membership.create({ data: { userId: user.id, organisationId, role } });
  return user;
};

/** One metric row at an exact hour. */
const metricAt = (
  campaignId: string,
  showId: string,
  bucket: Date,
  impressions: number,
  extra: Partial<{
    clicks: number;
    completions: number;
    slot: AdSlot;
    costMillicents: number;
  }> = {},
) =>
  testPrisma.metric.create({
    data: {
      campaignId,
      showId,
      slot: extra.slot ?? AdSlot.MID_ROLL,
      country: 'DE',
      device: Device.CTV,
      bucket,
      impressions,
      clicks: extra.clicks ?? 0,
      completions: extra.completions ?? 0,
      costMillicents: extra.costMillicents ?? impressions * 2000,
    },
  });

const impression = (campaignId: string, showId: string, viewerId: string, occurredAt: Date) => ({
  eventId: `${campaignId}-${viewerId}-${occurredAt.getTime()}`,
  type: 'IMPRESSION' as const,
  campaignId,
  showId,
  slot: 'MID_ROLL',
  country: 'DE',
  device: 'CTV',
  occurredAt,
  viewerId,
});

const currentHour = (): number => Math.floor(Date.now() / HOUR_MS) * HOUR_MS;

beforeEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

describe('Reach over a range', () => {
  it('counts each viewer once across the days they watched', async () => {
    const { id: userId } = await createTestUser();
    const show = await createTestShow();
    const campaign = await createTestCampaign(userId);
    const today = new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS + HOUR_MS);
    const yesterday = new Date(today.getTime() - DAY_MS);

    await enqueueEvents([
      impression(campaign.id, show.id, 'viewer-a', yesterday),
      impression(campaign.id, show.id, 'viewer-a', today),
      impression(campaign.id, show.id, 'viewer-b', today),
    ]);

    const dayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    expect(await reachBetween(campaign.id, new Date(dayStart - DAY_MS), new Date(dayStart))).toBe(
      1,
    );
    expect(await reachBetween(campaign.id, new Date(dayStart), new Date(dayStart + DAY_MS))).toBe(
      2,
    );
    expect(
      await reachBetween(campaign.id, new Date(dayStart - DAY_MS), new Date(dayStart + DAY_MS)),
    ).toBe(2);
  });

  it('reports range reach, average frequency and the previous period', async () => {
    const user = await createTestUser();
    const show = await createTestShow();
    const campaign = await createTestCampaign(user.id);
    const hour = currentHour();
    await metricAt(campaign.id, show.id, new Date(hour - 2 * HOUR_MS), 600, { clicks: 6 });
    await metricAt(campaign.id, show.id, new Date(hour - 30 * HOUR_MS), 200, { clicks: 1 });
    await enqueueEvents(
      ['a', 'b', 'c'].map((viewer, index) =>
        impression(campaign.id, show.id, viewer, new Date(hour - (index + 1) * 60_000)),
      ),
    );

    const from = new Date(hour - DAY_MS).toISOString();
    const to = new Date(hour + HOUR_MS).toISOString();
    const res = await request(app)
      .get(`/campaigns/${campaign.id}/analytics`)
      .query({ from, to })
      .set('Authorization', await login(user));

    expect(res.status).toBe(200);
    const data = res.body.data as {
      reach: number;
      averageFrequency: number;
      lifetimeReach: number;
      previous: { impressions: number; clicks: number; reach: number };
    };
    expect(data.reach).toBe(3);
    expect(data.lifetimeReach).toBe(3);
    expect(data.averageFrequency).toBe(200);
    expect(data.previous.impressions).toBe(200);
    expect(data.previous.clicks).toBe(1);
  });
});

describe('Period-over-period summary', () => {
  it('returns the current and previous period for visible campaigns only', async () => {
    const user = await createTestUser();
    const other = await createTestUser({ email: 'other@example.com' });
    const show = await createTestShow();
    const mine = await createTestCampaign(user.id);
    const theirs = await createTestCampaign(other.id);
    const hour = currentHour();
    await metricAt(mine.id, show.id, new Date(hour - HOUR_MS), 300);
    await metricAt(mine.id, show.id, new Date(hour - 3 * HOUR_MS), 100);
    await metricAt(theirs.id, show.id, new Date(hour - HOUR_MS), 9999);

    const res = await request(app)
      .get('/campaigns/analytics/summary')
      .query({
        from: new Date(hour - 2 * HOUR_MS).toISOString(),
        to: new Date(hour).toISOString(),
      })
      .set('Authorization', await login(user));

    expect(res.status).toBe(200);
    expect(res.body.data.current.impressions).toBe(300);
    expect(res.body.data.current.spendCents).toBe(600);
    expect(res.body.data.previous.impressions).toBe(100);
  });
});

describe('Campaign comparison', () => {
  it('compares campaigns side by side', async () => {
    const user = await createTestUser();
    const show = await createTestShow();
    const first = await createTestCampaign(user.id, { title: 'First' });
    const second = await createTestCampaign(user.id, { title: 'Second' });
    await metricAt(first.id, show.id, new Date(currentHour() - HOUR_MS), 500, { clicks: 5 });
    await metricAt(second.id, show.id, new Date(currentHour() - HOUR_MS), 100, { clicks: 4 });

    const res = await request(app)
      .get('/campaigns/compare')
      .query({ ids: `${first.id},${second.id}` })
      .set('Authorization', await login(user));

    expect(res.status).toBe(200);
    const rows = res.body.data as Array<{
      campaign: { title: string; impressions: number; ctr: number };
    }>;
    expect(rows.map((row) => row.campaign.title)).toEqual(['First', 'Second']);
    expect(rows[1]?.campaign.ctr).toBeCloseTo(0.04);
  });

  it('needs at least two campaigns and refuses ones the person can’t see', async () => {
    const user = await createTestUser();
    const other = await createTestUser({ email: 'other@example.com' });
    const mine = await createTestCampaign(user.id);
    const theirs = await createTestCampaign(other.id);
    const auth = await login(user);

    const one = await request(app)
      .get('/campaigns/compare')
      .query({ ids: mine.id })
      .set('Authorization', auth);
    const foreign = await request(app)
      .get('/campaigns/compare')
      .query({ ids: `${mine.id},${theirs.id}` })
      .set('Authorization', auth);

    expect(one.status).toBe(422);
    expect(foreign.status).toBe(404);
  });
});

describe('Report builder', () => {
  const setup = async () => {
    const user = await createTestUser();
    const show = await createTestShow('Harbour Lights', 'Drama');
    const first = await createTestCampaign(user.id, { title: 'Morning Roast' });
    const second = await createTestCampaign(user.id, { title: '=HYPERLINK("http://evil")' });
    const hour = currentHour();
    await metricAt(first.id, show.id, new Date(hour - HOUR_MS), 1000, {
      clicks: 20,
      completions: 700,
    });
    await metricAt(first.id, show.id, new Date(hour - 2 * HOUR_MS), 500, {
      clicks: 5,
      completions: 400,
      slot: AdSlot.PRE_ROLL,
    });
    await metricAt(second.id, show.id, new Date(hour - HOUR_MS), 250, {
      clicks: 1,
      completions: 100,
    });
    return { user, show, first, second, auth: await login(user) };
  };

  it('groups by campaign with totals and derived rates', async () => {
    const { auth } = await setup();

    const res = await request(app)
      .post('/reports/run')
      .set('Authorization', auth)
      .send({
        groupBy: 'CAMPAIGN',
        columns: ['impressions', 'clicks', 'ctr', 'completionRate', 'spend'],
      });

    expect(res.status).toBe(200);
    const { rows, totals } = res.body.data as {
      rows: Array<{ label: string; values: Record<string, number> }>;
      totals: Record<string, number>;
    };
    expect(rows[0]?.label).toBe('Morning Roast');
    expect(rows[0]?.values['impressions']).toBe(1500);
    expect(rows[0]?.values['ctr']).toBeCloseTo((25 / 1500) * 100);
    expect(totals['impressions']).toBe(1750);
    expect(totals['spend']).toBeCloseTo(35);
    expect(totals['completionRate']).toBeCloseTo((1200 / 1750) * 100);
  });

  it('groups by slot with readable names and filters to chosen campaigns', async () => {
    const { auth, first } = await setup();

    const res = await request(app)
      .post('/reports/run')
      .set('Authorization', auth)
      .send({ groupBy: 'SLOT', campaignIds: [first.id], columns: ['impressions'] });

    const labels = (res.body.data.rows as Array<{ label: string }>).map((row) => row.label);
    expect(labels).toEqual(['Mid-roll', 'Pre-roll']);
    expect(res.body.data.totals.impressions).toBe(1500);
  });

  it('only allows reach when grouping by campaign', async () => {
    const { auth } = await setup();

    const res = await request(app)
      .post('/reports/run')
      .set('Authorization', auth)
      .send({ groupBy: 'DAY', columns: ['impressions', 'reach'] });

    expect(res.status).toBe(422);
  });

  it('never includes another organisation’s campaigns', async () => {
    const { auth } = await setup();
    const other = await createTestUser({ email: 'other@example.com' });
    const theirs = await createTestCampaign(other.id, { title: 'Not Mine' });
    const show = await createTestShow('Other Show');
    await metricAt(theirs.id, show.id, new Date(currentHour() - HOUR_MS), 9999);

    const res = await request(app)
      .post('/reports/run')
      .set('Authorization', auth)
      .send({ groupBy: 'CAMPAIGN', campaignIds: [theirs.id], columns: ['impressions'] });

    expect(res.status).toBe(200);
    expect(res.body.data.rows).toEqual([]);
  });

  it('exports CSV with formulas made safe, and a PDF', async () => {
    const { auth } = await setup();
    const body = { groupBy: 'CAMPAIGN', columns: ['impressions', 'spend'] };

    const csv = await request(app)
      .post('/reports/export?format=csv')
      .set('Authorization', auth)
      .send(body);
    const pdf = await request(app)
      .post('/reports/export?format=pdf')
      .set('Authorization', auth)
      .send(body)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });

    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe('Campaign,Impressions,Spend (€)');
    expect(lines).toContain('Morning Roast,1500,30.00');
    expect(lines).toContain(`"'=HYPERLINK(""http://evil"")",250,5.00`);
    expect(lines.at(-1)).toBe('Total,1750,35.00');

    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('Saved and scheduled reports', () => {
  it('lets owners save reports and stops analysts and guests', async () => {
    const owner = await createTestUser();
    const analyst = await addMember(
      owner.organisationId,
      OrganisationRole.ANALYST,
      'analyst@example.com',
    );
    const guest = await createTestUser({ email: 'guest@example.com', role: Role.GUEST });
    const body = { name: 'Weekly summary', groupBy: 'DAY', columns: ['impressions'] };

    const created = await request(app)
      .post('/reports')
      .set('Authorization', await login(owner))
      .send(body);
    const byAnalyst = await request(app)
      .post('/reports')
      .set('Authorization', await login(analyst))
      .send(body);
    const byGuest = await request(app)
      .post('/reports')
      .set('Authorization', await login(guest))
      .send(body);
    const listed = await request(app)
      .get('/reports')
      .set('Authorization', await login(analyst));

    expect(created.status).toBe(201);
    expect(byAnalyst.status).toBe(403);
    expect(byGuest.status).toBe(403);
    expect(listed.body.data).toHaveLength(1);
  });

  it('only sends to members, and only covers the organisation’s campaigns', async () => {
    const owner = await createTestUser();
    const outsider = await createTestUser({ email: 'outsider@example.com' });
    const theirs = await createTestCampaign(outsider.id);
    const auth = await login(owner);
    const base = { name: 'Weekly', groupBy: 'DAY', columns: ['impressions'], schedule: 'WEEKLY' };

    const toOutsider = await request(app)
      .post('/reports')
      .set('Authorization', auth)
      .send({ ...base, recipientIds: [outsider.id] });
    const foreignCampaign = await request(app)
      .post('/reports')
      .set('Authorization', auth)
      .send({ ...base, recipientIds: [owner.id], campaignIds: [theirs.id] });
    const noRecipients = await request(app).post('/reports').set('Authorization', auth).send(base);

    expect(toOutsider.status).toBe(422);
    expect(foreignCampaign.status).toBe(422);
    expect(noRecipients.status).toBe(422);
  });

  it('schedules the next run on the hour in the platform time zone, across daylight saving', () => {
    // Monday 30 March 2026, the day after Berlin moved to summer time (UTC+2).
    const weekly = { schedule: ReportSchedule.WEEKLY, sendWeekday: 1, sendHour: 8 };
    expect(nextRunAfter(weekly, new Date('2026-03-27T12:00:00Z'))?.toISOString()).toBe(
      '2026-03-30T06:00:00.000Z',
    );
    // Winter time (UTC+1): 8:00 in Berlin is 7:00 UTC.
    expect(nextRunAfter(weekly, new Date('2026-11-04T12:00:00Z'))?.toISOString()).toBe(
      '2026-11-09T07:00:00.000Z',
    );
    const daily = { schedule: ReportSchedule.DAILY, sendWeekday: 1, sendHour: 8 };
    expect(nextRunAfter(daily, new Date('2026-11-04T07:00:00Z'))?.toISOString()).toBe(
      '2026-11-05T07:00:00.000Z',
    );
    expect(nextRunAfter({ ...daily, schedule: ReportSchedule.NONE }, new Date())).toBeNull();
  });

  it('emails a due report once with CSV and PDF attached, even when two processes check', async () => {
    const owner = await createTestUser({ email: 'owner@example.com' });
    const analyst = await addMember(
      owner.organisationId,
      OrganisationRole.ANALYST,
      'analyst@example.com',
    );
    const show = await createTestShow();
    const campaign = await createTestCampaign(owner.id, { title: 'Morning Roast' });
    await metricAt(campaign.id, show.id, new Date(currentHour() - HOUR_MS), 800, { clicks: 8 });
    await metricAt(campaign.id, show.id, new Date(currentHour() - 8 * DAY_MS), 400, { clicks: 2 });

    const report = await testPrisma.report.create({
      data: {
        organisationId: owner.organisationId,
        createdById: owner.id,
        name: 'Weekly summary',
        groupBy: 'CAMPAIGN',
        columns: ['impressions', 'clicks', 'reach'],
        schedule: ReportSchedule.WEEKLY,
        recipientIds: [owner.id, analyst.id],
        nextRunAt: new Date(Date.now() - 60_000),
      },
    });

    // Two processes that both loaded the report before either claimed it.
    const [first, second] = await Promise.all([claimAndSend(report), claimAndSend(report)]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await runDueReports()).toBe(0);
    const emails = await testPrisma.capturedEmail.findMany({ orderBy: { recipient: 'asc' } });
    expect(emails.map((email) => email.recipient)).toEqual([
      'analyst@example.com',
      'owner@example.com',
    ]);
    const [email] = emails;
    expect(email?.subject).toBe('Weekly report: Weekly summary');
    expect(email?.body).toContain('Impressions: 800 (+100% on the previous 7 days)');
    expect(email?.link).toContain(`/#/reports/${report.id}`);
    const files = email?.attachments as Array<{
      filename: string;
      contentType: string;
      content: string;
    }>;
    expect(files.map((file) => file.contentType)).toEqual(['text/csv', 'application/pdf']);
    expect(Buffer.from(files[0]?.content ?? '', 'base64').toString()).toContain(
      'Morning Roast,800,8,0',
    );
    expect(
      Buffer.from(files[1]?.content ?? '', 'base64')
        .subarray(0, 4)
        .toString(),
    ).toBe('%PDF');

    const updated = await testPrisma.report.findUniqueOrThrow({ where: { id: report.id } });
    expect(updated.lastSentAt).not.toBeNull();
    expect(updated.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it('sends now from the dashboard, and skips people who left', async () => {
    const owner = await createTestUser({ email: 'owner@example.com' });
    const leaver = await addMember(
      owner.organisationId,
      OrganisationRole.MANAGER,
      'leaver@example.com',
    );
    const auth = await login(owner);
    const created = await request(app)
      .post('/reports')
      .set('Authorization', auth)
      .send({
        name: 'Ad hoc',
        groupBy: 'DAY',
        columns: ['impressions'],
        recipientIds: [owner.id, leaver.id],
      });
    await testPrisma.membership.deleteMany({ where: { userId: leaver.id } });

    const res = await request(app)
      .post(`/reports/${created.body.data.id}/send`)
      .set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body.data.sentTo).toBe(1);
    expect(
      await testPrisma.capturedEmail.count({ where: { recipient: 'leaver@example.com' } }),
    ).toBe(0);
  });
});

describe('Alerts', () => {
  const runningFor = (days: number, total = 10) => ({
    startsAt: new Date(Date.now() - days * DAY_MS),
    endsAt: new Date(Date.now() + (total - days) * DAY_MS),
  });

  it('opens an under-delivery alert once, emails it once, and resolves it', async () => {
    const owner = await createTestUser({ email: 'owner@example.com' });
    const show = await createTestShow();
    const campaign = await createTestCampaign(owner.id, {
      impressionGoal: 10_000,
      ...runningFor(5),
    });
    await metricAt(campaign.id, show.id, new Date(currentHour() - HOUR_MS), 2000);

    const [a, b] = await Promise.all([alertsService.check(), alertsService.check()]);
    expect(a + b).toBe(1);
    const open = await testPrisma.alert.findMany({ where: { resolvedAt: null } });
    expect(open).toHaveLength(1);
    expect(open[0]?.type).toBe('UNDER_DELIVERY');
    expect(open[0]?.message).toContain('2,000 of the 5,000 impressions expected');

    expect(await alertsService.check()).toBe(0);
    expect(
      await testPrisma.capturedEmail.count({ where: { recipient: 'owner@example.com' } }),
    ).toBe(1);

    // 4,400 of 5,000 is 88%: above the opening line but below where it resolves.
    await metricAt(campaign.id, show.id, new Date(currentHour() - 2 * HOUR_MS), 2400);
    await alertsService.check();
    expect(await testPrisma.alert.count({ where: { resolvedAt: null } })).toBe(1);

    await metricAt(campaign.id, show.id, new Date(currentHour() - 3 * HOUR_MS), 600);
    await alertsService.check();
    expect(await testPrisma.alert.count({ where: { resolvedAt: null } })).toBe(0);
  });

  it('warns when the budget will run out before the end', async () => {
    const owner = await createTestUser();
    const show = await createTestShow();
    // €100 budget, €40 spent in the last day, 7 days to go: runs out in about 1.5 days.
    const campaign = await createTestCampaign(owner.id, {
      budgetCents: 10_000,
      impressionGoal: 1_000_000,
      ...runningFor(1, 8),
    });
    await metricAt(campaign.id, show.id, new Date(currentHour() - HOUR_MS), 2000, {
      costMillicents: 4_000_000,
    });

    await alertsService.check();

    const alert = await testPrisma.alert.findFirst({ where: { type: 'BUDGET_BURN' } });
    expect(alert?.message).toMatch(
      /budget runs out on .+, about [56] days before the campaign ends/,
    );
  });

  it('spots a sudden drop against the same hours on previous days', async () => {
    const owner = await createTestUser();
    const show = await createTestShow();
    const campaign = await createTestCampaign(owner.id, {
      impressionGoal: 50_000,
      ...runningFor(4),
    });
    const hour = currentHour();
    for (let day = 1; day <= ALERT_RULES.dropBaselineDays; day += 1) {
      await metricAt(campaign.id, show.id, new Date(hour - day * DAY_MS - HOUR_MS), 300);
      await metricAt(campaign.id, show.id, new Date(hour - day * DAY_MS - 2 * HOUR_MS), 300);
    }
    await metricAt(campaign.id, show.id, new Date(hour - HOUR_MS), 50);
    await metricAt(campaign.id, show.id, new Date(hour - 2 * HOUR_MS), 50);
    // Enough earlier delivery that under-delivery isn't what fires.
    await metricAt(campaign.id, show.id, new Date(hour - 3 * DAY_MS - 5 * HOUR_MS), 30_000);

    await alertsService.check();

    const types = (await testPrisma.alert.findMany()).map((alert) => alert.type);
    expect(types).toEqual(['SUDDEN_DROP']);
  });

  it('ignores a quiet period outside the campaign’s schedule', async () => {
    const owner = await createTestUser();
    const show = await createTestShow();
    const hour = currentHour();
    const local = (time: number): number =>
      Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/Berlin',
          hour: 'numeric',
          hourCycle: 'h23',
        }).format(time),
      );
    const offHours = [local(hour - HOUR_MS), local(hour - 2 * HOUR_MS)];
    const activeHours = Array.from({ length: 24 }, (_, h) => h).filter(
      (h) => !offHours.includes(h),
    );
    const campaign = await createTestCampaign(owner.id, {
      impressionGoal: 50_000,
      activeHours,
      ...runningFor(4),
    });
    for (let day = 1; day <= ALERT_RULES.dropBaselineDays; day += 1) {
      await metricAt(campaign.id, show.id, new Date(hour - day * DAY_MS - HOUR_MS), 300);
    }
    await metricAt(campaign.id, show.id, new Date(hour - 3 * DAY_MS - 5 * HOUR_MS), 30_000);

    await alertsService.check();

    expect(await testPrisma.alert.count({ where: { type: 'SUDDEN_DROP' } })).toBe(0);
  });

  it('respects the alert email setting and resolves alerts on paused campaigns', async () => {
    const owner = await createTestUser({ email: 'owner@example.com' });
    const show = await createTestShow();
    const campaign = await createTestCampaign(owner.id, {
      impressionGoal: 10_000,
      ...runningFor(5),
    });
    await metricAt(campaign.id, show.id, new Date(currentHour() - HOUR_MS), 100);
    const auth = await login(owner);

    const off = await request(app)
      .patch('/account/alerts')
      .set('Authorization', auth)
      .send({ alertEmails: false });
    const me = await request(app).get('/auth/me').set('Authorization', auth);
    await alertsService.check();

    expect(off.status).toBe(204);
    expect(me.body.data.alertEmails).toBe(false);
    expect(await testPrisma.alert.count()).toBe(1);
    expect(await testPrisma.capturedEmail.count()).toBe(0);

    const listed = await request(app).get('/alerts?status=open').set('Authorization', auth);
    expect(listed.body.data[0].campaign.title).toBe('Test Campaign');

    await testPrisma.campaign.update({ where: { id: campaign.id }, data: { status: 'PAUSED' } });
    await alertsService.check();
    expect(await testPrisma.alert.count({ where: { resolvedAt: null } })).toBe(0);
  });

  it('only shows an organisation its own alerts', async () => {
    const owner = await createTestUser();
    const other = await createTestUser({ email: 'other@example.com' });
    const show = await createTestShow();
    await createTestCampaign(other.id, { impressionGoal: 10_000, ...runningFor(5) });
    const theirs = await testPrisma.campaign.findFirstOrThrow();
    await metricAt(theirs.id, show.id, new Date(currentHour() - HOUR_MS), 10);
    await alertsService.check();

    const res = await request(app)
      .get('/alerts')
      .set('Authorization', await login(owner));

    expect(await testPrisma.alert.count()).toBe(1);
    expect(res.body.data).toEqual([]);
  });
});
