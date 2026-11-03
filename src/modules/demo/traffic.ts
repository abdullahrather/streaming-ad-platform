/**
 * src/modules/demo/traffic.ts
 *
 * Fictional viewers, so the dashboard has live numbers to show. Each tick,
 * viewers reach ad breaks, an ad is chosen, and the results are stored as one
 * batch, exactly as a real player would report them.
 *
 * 'always' runs constantly. 'on-demand' runs only while someone is using the
 * dashboard, so an idle public demo lets its hosting and database sleep.
 */
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';
import { deliveryService } from '@/modules/delivery/delivery.service';
import { enqueueEvents, type QueuedEvent } from '@/modules/delivery/event-queue';
import { noteViewedGenre } from '@/modules/delivery/viewer-activity';
import { AdSlot, Device } from '@prisma/client';
import { isActive } from './activity';

const TICK_MS = 2000;
const AD_BREAKS_PER_TICK = 30;

const SLOTS = [
  AdSlot.PRE_ROLL,
  AdSlot.PRE_ROLL,
  AdSlot.MID_ROLL,
  AdSlot.MID_ROLL,
  AdSlot.MID_ROLL,
  AdSlot.POST_ROLL,
];
const COUNTRIES = ['DE', 'DE', 'DE', 'FR', 'FR', 'IT', 'ES', 'NL', 'AT', 'SE'];
const DEVICES = [
  Device.CTV,
  Device.CTV,
  Device.CTV,
  Device.MOBILE,
  Device.MOBILE,
  Device.WEB,
  Device.TABLET,
];
const CLICK_RATE: Record<Device, number> = { CTV: 0.003, MOBILE: 0.02, WEB: 0.014, TABLET: 0.011 };
const COMPLETION_RATE: Record<AdSlot, number> = { PRE_ROLL: 0.78, MID_ROLL: 0.93, POST_ROLL: 0.55 };

const VIEWER_POOL = 5000;
const CONSENT_RATE = 0.7;

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)] as T;

async function serveAdBreak(
  showIds: string[],
  genres: Map<string, string>,
): Promise<QueuedEvent[]> {
  const placement = {
    showId: pick(showIds),
    slot: pick(SLOTS),
    country: pick(COUNTRIES),
    device: pick(DEVICES),
  };

  const viewerNumber = Math.floor(Math.random() * VIEWER_POOL);
  const viewerId = `demo-viewer-${viewerNumber}`;
  const consent = viewerNumber < VIEWER_POOL * CONSENT_RATE;
  const breakId = crypto.randomUUID();

  const decision = await deliveryService.decide(placement, {
    viewerId,
    breakId,
    consent,
    requireCreative: true,
  });
  if (!decision) return [];

  const genre = genres.get(placement.showId);
  if (genre) await noteViewedGenre(viewerId, genre, consent);

  const event = (type: QueuedEvent['type']): QueuedEvent => ({
    ...placement,
    type,
    campaignId: decision.campaignId,
    creativeId: decision.creative?.id,
    viewerId,
    priceCpmCents: decision.priceCpmCents,
    eventId: crypto.randomUUID(),
    occurredAt: new Date(),
  });
  const events = [event('IMPRESSION')];
  const completion = COMPLETION_RATE[placement.slot];
  const stages = [
    { type: 'FIRST_QUARTILE', chance: Math.sqrt(Math.sqrt(completion)) },
    { type: 'MIDPOINT', chance: Math.sqrt(completion) },
    { type: 'THIRD_QUARTILE', chance: completion ** 0.75 },
    { type: 'COMPLETION', chance: completion },
  ] as const;

  // One draw per viewer, so nobody reaches a later stage without the earlier ones.
  const reached = Math.random();
  for (const { type, chance } of stages) {
    if (reached < chance) events.push(event(type));
  }
  if (Math.random() < CLICK_RATE[placement.device]) {
    events.push(event('CLICK'));
  }
  return events;
}

/** Plays one round of ad breaks and returns the number of events stored. */
export async function runTrafficTick(): Promise<number> {
  const shows = await prisma.show.findMany({ select: { id: true, genre: true } });
  if (shows.length === 0) return 0;

  const showIds = shows.map((show) => show.id);
  const genres = new Map(shows.map(({ id, genre }) => [id, genre]));
  const breaks = await Promise.all(
    Array.from({ length: AD_BREAKS_PER_TICK }, () => serveAdBreak(showIds, genres)),
  );

  const events = breaks.flat();
  if (events.length > 0) await enqueueEvents(events);
  return events.length;
}

export function startTraffic(): void {
  if (env.SIMULATE_TRAFFIC === 'off') return;

  let running = false;
  const timer = setInterval(() => {
    if (running || (env.SIMULATE_TRAFFIC === 'on-demand' && !isActive())) return;

    running = true;
    runTrafficTick()
      .catch((error: unknown) => console.warn('Demo traffic:', String(error)))
      .finally(() => {
        running = false;
      });
  }, TICK_MS);
  timer.unref();

  console.info(`🎬  Demo traffic: ${env.SIMULATE_TRAFFIC}`);
}
