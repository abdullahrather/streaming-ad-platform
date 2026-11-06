/**
 * src/modules/delivery/viewer-activity.ts
 *
 * What's known about viewing. Ad requests are counted for forecasting without
 * identifying anyone: individuals only feed anonymous unique-viewer estimates.
 * A personal interest profile exists only for viewers who consented, and can be
 * deleted at any time.
 */
import { prisma } from '@/lib/prisma';
import { localTimeAt } from '@/lib/platform-time';
import { redis } from '@/lib/redis';
import { logger } from '@/lib/logger';

const PROFILE_DAYS = 90;
const COUNTER_DAYS = 3;
const HOUR_MS = 3_600_000;

const profileKey = (viewerId: string): string => `profile:${viewerId}`;
const inventoryKey = (bucket: string): string => `inventory:${bucket}`;
const OPEN_BUCKETS = 'inventory-buckets';
const ALL_TIME_AUDIENCE = 'audience:all';

const hourOf = (time: number): string =>
  new Date(Math.floor(time / HOUR_MS) * HOUR_MS).toISOString();

export interface AdRequest {
  genre: string;
  slot: string;
  country: string;
  device: string;
  viewerId?: string | undefined;
  consent?: boolean | undefined;
}

/**
 * Counts one ad request. Counting must never slow or fail a decision, so nothing
 * waits for it.
 */
export const recordAdRequest = (request: AdRequest, now = Date.now()): void => {
  const bucket = hourOf(now);
  const day = localTimeAt(now).day;
  const field = [request.genre, request.slot, request.country, request.device].join('|');

  const pipeline = redis
    .pipeline()
    .hincrby(inventoryKey(bucket), field, 1)
    .expire(inventoryKey(bucket), COUNTER_DAYS * 86_400)
    .sadd(OPEN_BUCKETS, bucket);

  if (request.viewerId) {
    pipeline.pfadd(`audience:${day}`, request.viewerId);
    pipeline.expire(`audience:${day}`, COUNTER_DAYS * 86_400);
    pipeline.pfadd(ALL_TIME_AUDIENCE, request.viewerId);
    if (request.consent) {
      pipeline.pfadd(`audience:${day}:consented`, request.viewerId);
      pipeline.expire(`audience:${day}:consented`, COUNTER_DAYS * 86_400);
    }
  }

  pipeline.exec().catch((error: unknown) => logger.warn({ err: String(error) }, 'Inventory'));
};

/**
 * Copies the running counts into PostgreSQL. It overwrites rather than adds, so
 * running it twice, or from two workers, can't change the totals.
 */
export const flushInventory = async (now = Date.now()): Promise<void> => {
  const buckets = await redis.smembers(OPEN_BUCKETS);

  for (const bucket of buckets) {
    const counts = await redis.hgetall(inventoryKey(bucket));
    const rows = Object.entries(counts).map(([field, requests]) => {
      const [genre = '', slot = '', country = '', device = ''] = field.split('|');
      return { genre, slot, country, device, requests: Number(requests) };
    });

    if (rows.length > 0) {
      await prisma.$executeRaw`
        INSERT INTO inventory_hours (bucket, genre, slot, country, device, requests)
        SELECT ${bucket}::timestamptz, t.genre, t.slot::"AdSlot", t.country, t.device::"Device",
          t.requests
        FROM unnest(
          ${rows.map((row) => row.genre)}::text[],
          ${rows.map((row) => row.slot)}::text[],
          ${rows.map((row) => row.country)}::text[],
          ${rows.map((row) => row.device)}::text[],
          ${rows.map((row) => row.requests)}::int[]
        ) AS t(genre, slot, country, device, requests)
        ON CONFLICT (bucket, genre, slot, country, device) DO UPDATE SET
          requests = EXCLUDED.requests
      `;
    }

    const finished = new Date(bucket).getTime() < now - 2 * HOUR_MS;
    if (finished) await redis.srem(OPEN_BUCKETS, bucket);
  }

  const { day } = localTimeAt(now);
  const [viewers, consented, allTime] = await Promise.all([
    redis.pfcount(`audience:${day}`),
    redis.pfcount(`audience:${day}:consented`),
    redis.pfcount(ALL_TIME_AUDIENCE),
  ]);
  if (viewers === 0) return;

  await prisma.audienceDay.upsert({
    where: { day },
    create: { day, viewers, consented, allTime },
    update: { viewers, consented, allTime },
  });
};

/** Notes a watched genre. Without consent nothing is stored. */
export const noteViewedGenre = async (
  viewerId: string,
  genre: string,
  consent: boolean,
): Promise<void> => {
  if (!consent) return;

  const key = profileKey(viewerId);
  await redis
    .pipeline()
    .hincrby(key, genre, 1)
    .expire(key, PROFILE_DAYS * 86_400)
    .exec();
};

export const viewerInterests = async (viewerId: string): Promise<Map<string, number>> => {
  const profile = await redis.hgetall(profileKey(viewerId));
  return new Map(Object.entries(profile).map(([genre, views]) => [genre, Number(views)]));
};

/** Honours a viewer withdrawing consent or asking to be forgotten. */
export const deleteViewerProfile = async (viewerId: string): Promise<void> => {
  await redis.del(profileKey(viewerId));
};
