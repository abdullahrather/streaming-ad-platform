/**
 * src/lib/metrics.ts
 *
 * Prometheus metrics, read at /metrics. Counters and timings are updated as things
 * happen; the queue backlog, whether Postgres and Redis respond, and the age of the
 * newest backup are checked each time Prometheus asks, so they're always current.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { env } from '@/config/env';

export const registry = new Registry();
registry.setDefaultLabels({ service: 'api' });
collectDefaultMetrics({ register: registry });

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'How long requests take, by route and status',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const adDecisions = new Counter({
  name: 'ad_decisions_total',
  help: 'Ad breaks asked for an ad, by whether one was chosen',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const eventsIngested = new Counter({
  name: 'events_ingested_total',
  help: 'Player and ad server events received, accepted or dropped as duplicates',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const eventsWritten = new Counter({
  name: 'events_written_total',
  help: 'Events the worker added to the database',
  registers: [registry],
});

export const invoicesIssued = new Counter({
  name: 'invoices_issued_total',
  help: 'Invoices issued for finished campaigns',
  registers: [registry],
});

export const schedulerFailures = new Counter({
  name: 'scheduler_task_failures_total',
  help: 'Scheduled tasks that failed, by task',
  labelNames: ['task'] as const,
  registers: [registry],
});

export const schedulerLastSuccess = new Gauge({
  name: 'scheduler_task_last_success_timestamp_seconds',
  help: 'When each scheduled task last finished without an error',
  labelNames: ['task'] as const,
  registers: [registry],
});

/** Checks run at scrape time. Set by the server, so tests and scripts don't open connections. */
interface LiveChecks {
  queueDepth: () => Promise<number>;
  postgres: () => Promise<unknown>;
  redis: () => Promise<unknown>;
  /** From Redis, so it's right wherever the worker runs. */
  workerLastBatch: () => Promise<number | null>;
}
let checks: LiveChecks | null = null;
export const setLiveChecks = (live: LiveChecks): void => {
  checks = live;
};

const withTimeout = <T>(promise: Promise<T>, ms = 2000): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);

new Gauge({
  name: 'event_queue_pending',
  help: 'Event batches waiting to reach the database',
  registers: [registry],
  async collect(): Promise<void> {
    if (!checks) return;
    this.set(await withTimeout(checks.queueDepth()).catch(() => -1));
  },
});

new Gauge({
  name: 'event_worker_last_batch_timestamp_seconds',
  help: 'When any event worker last wrote a batch, read from Redis',
  registers: [registry],
  async collect(): Promise<void> {
    if (!checks) return;
    const at = await withTimeout(checks.workerLastBatch()).catch(() => null);
    if (at !== null) this.set(at);
  },
});

new Gauge({
  name: 'dependency_up',
  help: 'Whether Postgres and Redis answered, 1 or 0',
  labelNames: ['dependency'] as const,
  registers: [registry],
  async collect(): Promise<void> {
    if (!checks) return;
    const live = checks;
    const up = async (check: () => Promise<unknown>): Promise<number> =>
      withTimeout(check()).then(
        () => 1,
        () => 0,
      );
    const [postgres, redis] = await Promise.all([up(live.postgres), up(live.redis)]);
    this.set({ dependency: 'postgres' }, postgres);
    this.set({ dependency: 'redis' }, redis);
  },
});

interface LatestBackup {
  finishedAt?: string;
  lastDrill?: { at?: string; ok?: boolean };
}

/** latest.json, written by the backup and restore drill scripts, or null before the first. */
const latestBackup = async (): Promise<LatestBackup | null> => {
  try {
    return JSON.parse(
      await fs.readFile(path.join(env.BACKUP_DIR, 'latest.json'), 'utf8'),
    ) as LatestBackup;
  } catch {
    return null;
  }
};

const seconds = (iso: string | undefined): number | null => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(at) ? null : at / 1000;
};

new Gauge({
  name: 'backup_last_success_timestamp_seconds',
  help: 'When the newest backup finished, from latest.json in BACKUP_DIR',
  registers: [registry],
  async collect(): Promise<void> {
    // Before the first backup this stays at 0, so the "backup too old" alert fires.
    const at = seconds((await latestBackup())?.finishedAt);
    if (at !== null) this.set(at);
  },
});

new Gauge({
  name: 'backup_restore_drill_ok',
  help: 'Whether the last restore drill matched every table, 1 or 0',
  registers: [registry],
  async collect(): Promise<void> {
    const drill = (await latestBackup())?.lastDrill;
    if (drill) this.set(drill.ok ? 1 : 0);
  },
});

new Gauge({
  name: 'backup_restore_drill_timestamp_seconds',
  help: 'When the last restore drill ran',
  registers: [registry],
  async collect(): Promise<void> {
    const at = seconds((await latestBackup())?.lastDrill?.at);
    if (at !== null) this.set(at);
  },
});
