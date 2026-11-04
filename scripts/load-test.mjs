// `npm run load:test`: runs the production build under k6, then proves the numbers.
//
// After the events test it waits for the queue to empty and compares the database
// with what the API accepted. One lost or repeated event fails the run.
//
// Options: RATE=10000 DURATION=5m BATCH=100 DECISION_RATE=2000 API_PROCESSES=4 WORKERS=1
// CRASH=1 kills the worker with no warning partway through, then starts a new one.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { Redis } from 'ioredis';
import { ROOT, ensureEnv, startDatabase, startRedis } from './db.mjs';

const RATE = Number(process.env.RATE ?? 10_000);
const DURATION = process.env.DURATION ?? '5m';
const BATCH = Number(process.env.BATCH ?? 100);
const DECISION_RATE = Number(process.env.DECISION_RATE ?? 2000);
const DECISION_DURATION = process.env.DECISION_DURATION ?? '1m';
const API_PROCESSES = Number(process.env.API_PROCESSES ?? 4);
const WORKERS = Number(process.env.WORKERS ?? 1);
const RACE_CAP = 10_000;
const RACE_REQUESTS = 50_000;
const FIRST_PORT = 3100;
const K6_IMAGE = 'grafana/k6:latest';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

ensureEnv();
await startRedis();
const stopDatabase = await startDatabase();

console.info('Building...');
const build = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', 'false'], {
  cwd: ROOT,
  stdio: 'inherit',
});
const alias = spawnSync(process.execPath, ['node_modules/tsc-alias/dist/bin/index.js', '-p', 'tsconfig.json'], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (build.status !== 0 || alias.status !== 0) throw new Error('Build failed.');

const database = new pg.Client({ connectionString: process.env.DATABASE_URL.split('?')[0] });
await database.connect();
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

const run = crypto.randomUUID().slice(0, 8);
const showId = `load-show-${run}`;
const userId = `load-user-${run}`;
const organisationId = `load-org-${run}`;

const createCampaign = async (name, goal) => {
  const id = `load-${name}-${run}`;
  await database.query(
    `INSERT INTO campaigns (id, organisation_id, user_id, title, advertiser, status, budget_cents,
       cpm_cents, impression_goal, starts_at, ends_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Load Test', 'ACTIVE', 2000000000, 1, $5,
       now() - interval '1 day', now() + interval '1 day', now())`,
    [id, organisationId, userId, `Load ${name}`, goal],
  );
  return id;
};

await database.query(`INSERT INTO shows (id, title, genre) VALUES ($1, $2, 'Load')`, [showId, showId]);
await database.query(
  `INSERT INTO users (id, email, password_hash, updated_at) VALUES ($1, $2, 'none', now())`,
  [userId, `${userId}@example.com`],
);
await database.query(`INSERT INTO organisations (id, name) VALUES ($1, 'Load Test')`, [organisationId]);
const eventsCampaign = await createCampaign('events', 2_000_000_000);

const serverEnv = {
  ...process.env,
  NODE_ENV: 'production',
  RUN_EVENT_WORKER: 'false',
  RUN_SCHEDULER: 'false',
  SIMULATE_TRAFFIC: 'off',
  DATABASE_URL: process.env.DATABASE_URL,
};

const children = [];
const start = (file, env) => {
  const child = spawn(process.execPath, [file], { cwd: ROOT, env, stdio: 'ignore' });
  children.push(child);
  return child;
};

const ports = Array.from({ length: API_PROCESSES }, (_, index) => FIRST_PORT + index);
ports.forEach((port) => start('dist/server.js', { ...serverEnv, PORT: String(port) }));
const workers = Array.from({ length: WORKERS }, () => start('dist/worker.js', serverEnv));

for (const port of ports) {
  for (let attempt = 0; ; attempt += 1) {
    const healthy = await fetch(`http://localhost:${port}/health`).then((r) => r.ok, () => false);
    if (healthy) break;
    if (attempt > 40) throw new Error(`The API on port ${port} did not start.`);
    await sleep(500);
  }
}

const targets = ports.map((port) => `http://host.docker.internal:${port}`).join(',');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'load-test-'));

const k6 = async (script, env, summary) => {
  const args = [
    'run', '--rm', '-v', `${path.join(ROOT, 'load')}:/scripts:ro`, '-v', `${output}:/output`,
    '--add-host', 'host.docker.internal:host-gateway',
    ...Object.entries({ TARGETS: targets, KEY: process.env.INGEST_API_KEY, ...env }).flatMap(
      ([name, value]) => ['-e', `${name}=${value}`],
    ),
    K6_IMAGE, 'run', '--quiet', '--summary-trend-stats=avg,p(95),p(99),max', `--summary-export=/output/${summary}`, `/scripts/${script}`,
  ];

  await new Promise((resolve) => {
    const child = spawn('docker', args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('close', resolve);
  });
  return JSON.parse(fs.readFileSync(path.join(output, summary), 'utf8')).metrics;
};

const waitForQueue = async () => {
  const started = Date.now();
  for (let length = await redis.xlen('ad-events'); length > 0; length = await redis.xlen('ad-events')) {
    if (Date.now() - started > 600_000) throw new Error(`Queue stuck at ${length} batches.`);
    await sleep(500);
  }
  return (Date.now() - started) / 1000;
};

const impressions = async (campaignId) => {
  const { rows } = await database.query(
    'SELECT COALESCE(SUM(impressions), 0)::bigint AS total FROM metrics WHERE campaign_id = $1',
    [campaignId],
  );
  return Number(rows[0].total);
};

const count = (metrics, name) => metrics[name]?.count ?? 0;
const failedRate = (metrics) => metrics.http_req_failed?.value ?? 0;
const ms = (metrics, stat) => metrics.http_req_duration?.[stat]?.toFixed(1);

const results = [];
let passed = true;

try {
  // 1. Sustained events
  console.info(`Events: ${RATE}/s for ${DURATION}, in batches of ${BATCH}...`);
  if (process.env.CRASH === '1') {
    setTimeout(() => {
      console.info('Killing the worker...');
      workers[0].kill('SIGKILL');
      setTimeout(() => {
        console.info('Starting a new worker...');
        workers[0] = start('dist/worker.js', serverEnv);
      }, 5000);
    }, 15_000);
  }
  const events = await k6(
    'events.js',
    { RATE, DURATION, BATCH, CAMPAIGN: eventsCampaign, SHOW: showId, RUN: run },
    'events.json',
  );
  const drainSeconds = await waitForQueue();
  const accepted = count(events, 'events_accepted');
  const duplicates = count(events, 'events_duplicate');
  const stored = await impressions(eventsCampaign);
  const exact = stored === accepted;
  const eventRate = events.events_accepted?.rate ?? 0;
  const meetsRate = eventRate >= RATE * 0.99;
  passed &&= exact && meetsRate;

  results.push(
    ['Events accepted', accepted.toLocaleString('en')],
    ['Sustained rate', `${Math.round(eventRate).toLocaleString('en')} events/s`],
    ['Replayed events dropped', duplicates.toLocaleString('en')],
    ['Events in the database', stored.toLocaleString('en')],
    ['Lost or double-counted', (stored - accepted).toLocaleString('en')],
    ['Event API p95 / p99', `${ms(events, 'p(95)')} ms / ${ms(events, 'p(99)') ?? 'n/a'} ms`],
    ['Failed requests', `${(failedRate(events) * 100).toFixed(3)}%`],
    ['Queue emptied after the test in', `${drainSeconds.toFixed(1)} s`],
  );

  // Each impression comes from one of a million viewers at random, so the expected
  // number of different viewers is 1,000,000 × (1 - e^(-impressions / 1,000,000)).
  const viewers = 1_000_000;
  const expectedReach = viewers * (1 - Math.exp(-accepted / viewers));
  const reach = await redis.pfcount(`reach:${eventsCampaign}`);
  const reachError = expectedReach > 0 ? Math.abs(reach - expectedReach) / expectedReach : 0;
  // The sketch has a standard error of about 0.8%, so 2.5% (three errors) only fails a real fault.
  passed &&= reachError < 0.025;
  results.push([
    'Reach counted / expected',
    `${reach.toLocaleString('en')} / ${Math.round(expectedReach).toLocaleString('en')} (${(reachError * 100).toFixed(2)}% off)`,
  ]);

  // 2. Decision speed
  console.info(`Decisions: ${DECISION_RATE}/s for ${DECISION_DURATION}...`);
  const decisions = await k6(
    'decisions.js',
    { RATE: DECISION_RATE, DURATION: DECISION_DURATION, SHOW: showId },
    'decisions.json',
  );
  results.push(
    ['Decisions served', `${Math.round(decisions.http_reqs?.rate ?? 0).toLocaleString('en')}/s`],
    ['Decision p95', `${ms(decisions, 'p(95)')} ms`],
    ['Decision failures', `${(failedRate(decisions) * 100).toFixed(3)}%`],
  );

  // 3. Race for a hard limit
  await database.query(`UPDATE campaigns SET status = 'PAUSED' WHERE id = $1`, [eventsCampaign]);
  const raceCampaign = await createCampaign('race', RACE_CAP);
  await sleep(6000);

  console.info(`Hard limit: ${RACE_REQUESTS} requests racing for ${RACE_CAP} ads...`);
  const race = await k6(
    'decisions.js',
    { RATE: 1, DURATION: '1s', SHOW: showId, MAX_DECISIONS: RACE_REQUESTS, CAMPAIGN: raceCampaign },
    'race.json',
  );
  const served = count(race, 'ads_served');
  const reserved = Number(await redis.get(`served:${raceCampaign}`));
  const raceExact = served === RACE_CAP && reserved === RACE_CAP;
  passed &&= raceExact;
  results.push(
    [`Ads served against a limit of ${RACE_CAP.toLocaleString('en')}`, served.toLocaleString('en')],
    ['Requests that raced for them', count(race, 'http_reqs').toLocaleString('en')],
  );

  await database.query('DELETE FROM campaigns WHERE id = ANY($1)', [[raceCampaign, eventsCampaign]]);
} finally {
  children.forEach((child) => child.kill());
  await database.query('DELETE FROM campaigns WHERE user_id = $1', [userId]).catch(() => {});
  await database.query('DELETE FROM shows WHERE id = $1', [showId]).catch(() => {});
  await database.query('DELETE FROM organisations WHERE id = $1', [organisationId]).catch(() => {});
  await database.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
  await database.end();
  redis.disconnect();
  await stopDatabase().catch(() => {});
}

const width = Math.max(...results.map(([label]) => label.length));
console.info('');
results.forEach(([label, value]) => console.info(`${label.padEnd(width)}  ${value}`));
console.info(`\n${passed ? 'PASSED' : 'FAILED'}: ${API_PROCESSES} API processes, ${WORKERS} worker(s), ${os.cpus().length} CPU threads`);
process.exit(passed ? 0 : 1);
