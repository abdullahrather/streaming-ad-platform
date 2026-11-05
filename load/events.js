// Sends ad event batches at a fixed rate. Some batches are sent twice on purpose,
// because a retry must never count twice. Run through `npm run load:test`.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const { RATE, DURATION, BATCH, CAMPAIGN, SHOW, KEY, TARGETS, RUN } = __ENV;

const batchSize = Number(BATCH);
// A million made-up viewers, so reach sketches fill as they would on a real service.
const VIEWERS = 1_000_000;
const requestsPerSecond = Math.ceil(Number(RATE) / batchSize);
const targets = TARGETS.split(',');

const accepted = new Counter('events_accepted');
const duplicates = new Counter('events_duplicate');

export const options = {
  discardResponseBodies: false,
  scenarios: {
    events: {
      executor: 'constant-arrival-rate',
      rate: requestsPerSecond,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 100,
      maxVUs: 1000,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    http_req_duration: ['p(95)<500'],
  },
};

const headers = { 'content-type': 'application/json', 'x-ingest-key': KEY };

export default function send() {
  const occurredAt = new Date().toISOString();
  const prefix = `${RUN}-${__VU}-${__ITER}`;
  const events = [];

  for (let index = 0; index < batchSize; index += 1) {
    events.push({
      eventId: `${prefix}-${index}`,
      type: 'IMPRESSION',
      campaignId: CAMPAIGN,
      showId: SHOW,
      slot: 'MID_ROLL',
      country: 'DE',
      device: 'CTV',
      occurredAt,
      // Real players identify viewers, which also counts them towards reach.
      viewerId: `viewer-${Math.floor(Math.random() * VIEWERS)}`,
    });
  }

  const body = JSON.stringify({ events });
  const url = `${targets[__ITER % targets.length]}/events`;
  const attempts = __ITER % 50 === 0 ? 2 : 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = http.post(url, body, { headers });
    const healthy = check(response, { accepted: ({ status }) => status === 202 });
    if (healthy) {
      const { data } = response.json();
      accepted.add(data.accepted);
      duplicates.add(data.duplicates);
    }
  }
}
