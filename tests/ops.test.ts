/**
 * tests/ops.test.ts
 *
 * Operations: request IDs, Prometheus metrics, the checks made at scrape time, the
 * newest backup's age, and alerts from Alertmanager emailed to platform admins.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { Role } from '@prisma/client';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { setLiveChecks } from '@/lib/metrics';
import {
  clearDatabase,
  createTestCampaign,
  createTestShow,
  createTestUser,
  testPrisma,
} from './helpers/db';

const app = createApp();
const INGEST_KEY = process.env['INGEST_API_KEY'] as string;
const settings = env as unknown as Record<string, unknown>;

/** Reads one sample from the metrics text, such as `ad_decisions_total{result="none"}`. */
const sample = (text: string, name: string, labels = ''): number | null => {
  const line = text
    .split('\n')
    .find((row) => row.startsWith(`${name}{`) && row.includes(labels) && !row.startsWith('#'));
  return line ? Number(line.split(' ').pop()) : null;
};
const metrics = async (): Promise<string> => (await request(app).get('/metrics')).text;

beforeEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

describe('Request IDs', () => {
  it('sends one back, keeping a sensible one from the caller', async () => {
    const own = await request(app).get('/live').set('X-Request-ID', 'trace-abc-12345');
    const made = await request(app).get('/live');
    const odd = await request(app).get('/live').set('X-Request-ID', 'bad id with spaces!');

    expect(own.headers['x-request-id']).toBe('trace-abc-12345');
    expect(made.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(odd.headers['x-request-id']).not.toBe('bad id with spaces!');
  });
});

describe('Metrics', () => {
  it('times requests by route pattern, not by ID', async () => {
    const user = await createTestUser();
    const campaign = await createTestCampaign(user.id);
    const login = await request(app)
      .post('/auth/login')
      .send({ email: user.email, password: user.password });
    await request(app)
      .get(`/campaigns/${campaign.id}`)
      .set('Authorization', `Bearer ${login.body.data.token as string}`);

    const text = await metrics();

    expect(
      sample(text, 'http_request_duration_seconds_count', 'route="/campaigns/:id"'),
    ).toBeGreaterThanOrEqual(1);
    expect(text).not.toContain(campaign.id);
  });

  it('counts ad decisions and events, duplicates included', async () => {
    const user = await createTestUser();
    const show = await createTestShow();
    const campaign = await createTestCampaign(user.id);
    const before = await metrics();
    const event = {
      slot: 'PRE_ROLL',
      country: 'DE',
      device: 'CTV',
      showId: show.id,
      campaignId: campaign.id,
      type: 'IMPRESSION',
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
    };

    await request(app)
      .get('/ad-decision')
      .query({ showId: show.id, slot: 'PRE_ROLL', country: 'DE', device: 'CTV' })
      .set('x-ingest-key', INGEST_KEY);
    await request(app)
      .post('/events')
      .set('x-ingest-key', INGEST_KEY)
      .send({ events: [event] });
    await request(app)
      .post('/events')
      .set('x-ingest-key', INGEST_KEY)
      .send({ events: [event] });
    const after = await metrics();

    const count = (text: string, name: string, labels: string): number =>
      sample(text, name, labels) ?? 0;
    const decisions = (text: string): number =>
      count(text, 'ad_decisions_total', 'result="served"') +
      count(text, 'ad_decisions_total', 'result="none"');
    expect(decisions(after) - decisions(before)).toBe(1);
    expect(
      count(after, 'events_ingested_total', 'result="accepted"') -
        count(before, 'events_ingested_total', 'result="accepted"'),
    ).toBe(1);
    expect(
      count(after, 'events_ingested_total', 'result="duplicate"') -
        count(before, 'events_ingested_total', 'result="duplicate"'),
    ).toBe(1);
  });

  it('checks Postgres, Redis and the queue each time it is read', async () => {
    setLiveChecks({
      queueDepth: () => Promise.resolve(42),
      postgres: () => Promise.resolve(1),
      redis: () => Promise.reject(new Error('connection refused')),
    });

    const text = await metrics();

    expect(sample(text, 'event_queue_pending')).toBe(42);
    expect(sample(text, 'dependency_up', 'dependency="postgres"')).toBe(1);
    expect(sample(text, 'dependency_up', 'dependency="redis"')).toBe(0);
  });

  it('reports when the newest backup finished, and whether its restore drill passed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backups-'));
    const finishedAt = '2026-11-06T03:00:00.000Z';
    fs.writeFileSync(
      path.join(dir, 'latest.json'),
      JSON.stringify({ finishedAt, lastDrill: { at: finishedAt, ok: false } }),
    );
    const before = settings['BACKUP_DIR'];
    settings['BACKUP_DIR'] = dir;

    try {
      const text = await metrics();
      expect(sample(text, 'backup_last_success_timestamp_seconds')).toBe(
        Date.parse(finishedAt) / 1000,
      );
      // A failed restore drill shows as 0, so an alert can fire on it.
      expect(sample(text, 'backup_restore_drill_ok')).toBe(0);
    } finally {
      settings['BACKUP_DIR'] = before;
    }
  });

  it('needs the token when one is set', async () => {
    settings['METRICS_TOKEN'] = 'scrape-token-1234';
    try {
      const none = await request(app).get('/metrics');
      const wrong = await request(app).get('/metrics').set('Authorization', 'Bearer nope');
      const right = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer scrape-token-1234');

      expect([none.status, wrong.status, right.status]).toEqual([401, 401, 200]);
    } finally {
      settings['METRICS_TOKEN'] = '';
    }
  });
});

describe('Alerts from Alertmanager', () => {
  const body = (status: 'firing' | 'resolved') => ({
    status,
    alerts: [
      {
        status,
        labels: { alertname: 'RedisDown', severity: 'critical' },
        annotations: {
          summary: 'Redis is not answering',
          description: 'Events queue up in memory and ad decisions slow down.',
        },
        startsAt: '2026-11-06T03:00:00Z',
      },
    ],
  });

  it('emails platform admins when an alert fires and when it resolves', async () => {
    await createTestUser({ email: 'admin@example.com', role: Role.ADMIN });
    await createTestUser({ email: 'owner@example.com' });
    settings['ALERT_WEBHOOK_TOKEN'] = 'alert-token-1234';

    try {
      const firing = await request(app)
        .post('/ops/alerts')
        .set('Authorization', 'Bearer alert-token-1234')
        .send(body('firing'));
      await request(app)
        .post('/ops/alerts')
        .set('Authorization', 'Bearer alert-token-1234')
        .send(body('resolved'));

      expect(firing.body.data).toEqual({ alerts: 1, sentTo: 1 });
      const emails = await testPrisma.capturedEmail.findMany({ orderBy: { createdAt: 'asc' } });
      expect(emails.map(({ recipient, subject }) => [recipient, subject])).toEqual([
        ['admin@example.com', 'Firing: Redis is not answering'],
        ['admin@example.com', 'Resolved: Redis is not answering'],
      ]);
      expect(emails[0]?.body).toContain('Events queue up in memory');
    } finally {
      settings['ALERT_WEBHOOK_TOKEN'] = '';
    }
  });

  it('refuses a missing or wrong token, and is closed when no token is set', async () => {
    const closed = await request(app).post('/ops/alerts').send(body('firing'));
    settings['ALERT_WEBHOOK_TOKEN'] = 'alert-token-1234';
    try {
      const wrong = await request(app)
        .post('/ops/alerts')
        .set('Authorization', 'Bearer guess')
        .send(body('firing'));
      expect([closed.status, wrong.status]).toEqual([401, 401]);
      expect(await testPrisma.capturedEmail.count()).toBe(0);
    } finally {
      settings['ALERT_WEBHOOK_TOKEN'] = '';
    }
  });
});
