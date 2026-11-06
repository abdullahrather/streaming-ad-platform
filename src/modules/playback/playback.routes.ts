/**
 * src/modules/playback/playback.routes.ts
 *
 * Public endpoints used by video players. A VAST response carries signed links,
 * so a player can report what happened to the ad it was served, without holding
 * a secret and without being able to invent events for another campaign.
 */
import crypto from 'crypto';
import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { env } from '@/config/env';
import { allowAnyOrigin, handle } from '@/lib/http';
import { prisma } from '@/lib/prisma';
import { storage } from '@/lib/storage';
import { AppError } from '@/middleware/errorHandler';
import { requireIngestKey } from '@/middleware/ingestKey';
import {
  adContextSchema,
  adDecisionQuerySchema,
  playerTokenSchema,
  type AdDecisionQuery,
  type EventType,
} from '@/modules/delivery/delivery.schema';
import { decisionCache } from '@/modules/delivery/decision-cache';
import { deliveryService } from '@/modules/delivery/delivery.service';
import { enqueueEvents, enqueueFiltered } from '@/modules/delivery/event-queue';
import { deleteViewerProfile, noteViewedGenre } from '@/modules/delivery/viewer-activity';
import { isBot, isExcessive, isImpossibleCompletion, type FilterReason } from './traffic-quality';
import { buildVast, emptyVast } from './vast';
import { logger } from '@/lib/logger';

const TRACKING_AUDIENCE = 'ad-tracking';
const TRACKING_TTL = '1h';
const PLAYER_AUDIENCE = 'player';
const PLAYER_TOKEN_TTL_SECONDS = 15 * 60;

const EVENTS: Record<string, EventType> = {
  impression: 'IMPRESSION',
  firstQuartile: 'FIRST_QUARTILE',
  midpoint: 'MIDPOINT',
  thirdQuartile: 'THIRD_QUARTILE',
  complete: 'COMPLETION',
};

interface TrackingClaims extends AdDecisionQuery {
  campaignId: string;
  creativeId: string;
  durationSeconds: number;
  viewerId: string;
  consent: boolean;
  genre: string;
  priceCpmCents: number;
  jti: string;
  iat: number;
}

const playbackRouter = Router();

const playerLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.PLAYER_RATE_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many requests.' },
});

playbackRouter.use(['/vast', '/track', '/click', '/player'], playerLimiter);
playbackRouter.use(['/vast', '/track', '/player'], allowAnyOrigin);

const originOf = (req: Request): string => `${req.protocol}://${req.get('host') ?? 'localhost'}`;

const signTracking = (claims: Omit<TrackingClaims, 'jti' | 'iat'>): string =>
  jwt.sign(claims, env.JWT_SECRET, {
    audience: TRACKING_AUDIENCE,
    expiresIn: TRACKING_TTL,
    jwtid: crypto.randomUUID(),
  });

const readTracking = (token: unknown): TrackingClaims => {
  try {
    if (typeof token !== 'string') throw new Error('Missing token.');
    return jwt.verify(token, env.JWT_SECRET, {
      audience: TRACKING_AUDIENCE,
    }) as unknown as TrackingClaims;
  } catch {
    throw new AppError(400, 'This tracking link is invalid or has expired.');
  }
};

/** The event ID comes from the signed link, so a repeat of the same link counts once. */
const record = (claims: TrackingClaims, type: EventType, name: string): Promise<unknown> =>
  enqueueEvents([
    {
      eventId: `${claims.jti}:${name}`,
      type,
      campaignId: claims.campaignId,
      showId: claims.showId,
      slot: claims.slot,
      country: claims.country,
      device: claims.device,
      occurredAt: new Date(),
      creativeId: claims.creativeId,
      viewerId: claims.viewerId,
      priceCpmCents: claims.priceCpmCents,
    },
  ]);

const filterEvent = (claims: TrackingClaims, name: string, reason: FilterReason): Promise<void> =>
  enqueueFiltered({
    eventId: `${claims.jti}:${name}`,
    campaignId: claims.campaignId,
    reason,
  });

interface PlayerClaims {
  viewerId: string;
  consent: boolean;
}

const issuePlayerToken = ({
  viewerId,
  consent,
}: PlayerClaims): { token: string; expiresIn: number; viewerId: string } => ({
  token: jwt.sign({ consent }, env.JWT_SECRET, {
    subject: viewerId,
    audience: PLAYER_AUDIENCE,
    expiresIn: PLAYER_TOKEN_TTL_SECONDS,
  }),
  expiresIn: PLAYER_TOKEN_TTL_SECONDS,
  viewerId,
});

const readPlayerToken = (token: unknown): PlayerClaims => {
  try {
    if (typeof token !== 'string') throw new Error('Missing token.');
    const { sub, consent } = jwt.verify(token, env.JWT_SECRET, {
      audience: PLAYER_AUDIENCE,
    }) as jwt.JwtPayload;
    return { viewerId: sub as string, consent: consent === true };
  } catch {
    throw new AppError(401, 'A valid player token is required.');
  }
};

/** For a publisher's server: swaps the ad server key for a short-lived player token. */
playbackRouter.post('/player-tokens', requireIngestKey, (req, res) => {
  const { viewerId, consent } = playerTokenSchema.parse(req.body ?? {});
  res.status(201).json({
    status: 'success',
    data: issuePlayerToken({ viewerId: viewerId ?? crypto.randomUUID(), consent }),
  });
});

/** Stands in for a publisher's server on the demo site. Closed in production. */
playbackRouter.post('/player/session', (req, res) => {
  if (env.NODE_ENV === 'production' && !env.DEMO_MODE) throw new AppError(404, 'Not found.');

  const { viewerId, consent } = playerTokenSchema.parse(req.body ?? {});
  res.status(201).json({
    status: 'success',
    data: issuePlayerToken({ viewerId: viewerId ?? crypto.randomUUID(), consent }),
  });
});

/** Lets a viewer delete their interest profile. */
playbackRouter.delete(
  '/player/profile',
  handle(async (req, res) => {
    const { viewerId } = readPlayerToken(req.query['token']);
    await deleteViewerProfile(viewerId);
    res.status(204).end();
  }),
);

/** What the demo streaming site can play. */
playbackRouter.get(
  '/player/catalogue',
  handle(async (_req, res) => {
    const shows = await prisma.show.findMany({
      where: { videoKey: { not: '' } },
      orderBy: { title: 'asc' },
      select: { id: true, title: true, genre: true },
    });

    res.status(200).json({
      status: 'success',
      data: shows.map((show) => ({
        ...show,
        videoUrl: `/media/shows/${show.id}/video`,
        posterUrl: `/media/shows/${show.id}/poster`,
      })),
    });
  }),
);

playbackRouter.get(
  '/media/shows/:id/:file',
  handle(async (req, res) => {
    const file = { video: 'episode.mp4', poster: 'poster.jpg' }[req.params['file'] as string];
    const show = await prisma.show.findUnique({ where: { id: req.params['id'] as string } });
    if (!show?.videoKey || !file) throw new AppError(404, 'Not found.');

    res.sendFile(storage.localPath(`shows/${show.id}/${file}`), { dotfiles: 'allow' });
  }),
);

/** Asks for an ad in VAST. An empty VAST means nothing can run in this break. */
playbackRouter.get(
  '/vast',
  handle(async (req, res) => {
    const { viewerId, consent } = readPlayerToken(req.query['token']);
    const query = adDecisionQuerySchema.parse(req.query);
    const { breakId } = adContextSchema.parse(req.query);
    res.type('application/xml');

    const reason: FilterReason | null = isBot(req.get('user-agent'))
      ? 'BOT_USER_AGENT'
      : (await isExcessive(viewerId))
        ? 'EXCESSIVE_REQUESTS'
        : null;

    if (reason) {
      await enqueueFiltered({ eventId: crypto.randomUUID(), reason });
      res.status(200).send(emptyVast());
      return;
    }

    const decision = await deliveryService.decide(query, {
      requireCreative: true,
      viewerId,
      breakId,
      consent,
    });

    if (!decision?.creative) {
      res.status(200).send(emptyVast());
      return;
    }

    const { creative } = decision;
    const token = signTracking({
      ...query,
      campaignId: decision.campaignId,
      creativeId: creative.id,
      durationSeconds: creative.durationSeconds,
      viewerId,
      consent,
      genre: (await decisionCache.get()).genreByShow.get(query.showId) ?? '',
      priceCpmCents: decision.priceCpmCents,
    });
    const origin = originOf(req);
    const track = (event: string): string => `${origin}/track/${event}?t=${token}`;

    res.status(200).send(
      buildVast({
        id: creative.id,
        title: creative.name,
        advertiser: decision.advertiser,
        durationSeconds: creative.durationSeconds,
        width: creative.width,
        height: creative.height,
        videoUrl: `${origin}/media/creatives/${creative.id}/video`,
        clickThroughUrl: `${origin}/click?t=${token}`,
        impressionUrl: track('impression'),
        trackingUrls: {
          start: track('start'),
          firstQuartile: track('firstQuartile'),
          midpoint: track('midpoint'),
          thirdQuartile: track('thirdQuartile'),
          complete: track('complete'),
        },
      }),
    );
  }),
);

playbackRouter.get(
  '/track/:event',
  handle(async (req, res) => {
    const name = req.params['event'] as string;
    const claims = readTracking(req.query['t']);

    // "start" duplicates the impression, so it's accepted but not counted.
    if (name !== 'start') {
      const type = EVENTS[name];
      if (!type) throw new AppError(404, 'Unknown event.');

      if (isBot(req.get('user-agent'))) {
        await filterEvent(claims, name, 'BOT_USER_AGENT');
      } else if (
        name === 'complete' &&
        isImpossibleCompletion(claims.iat, claims.durationSeconds)
      ) {
        await filterEvent(claims, name, 'IMPOSSIBLE_TIMING');
      } else {
        await record(claims, type, name);
        if (name === 'impression') {
          await noteViewedGenre(claims.viewerId, claims.genre, claims.consent);
        }
      }
    }

    res.status(204).end();
  }),
);

/** Records the click, then sends the viewer to the advertiser's page. */
playbackRouter.get(
  '/click',
  handle(async (req, res) => {
    const claims = readTracking(req.query['t']);
    const creative = await prisma.creative.findUnique({ where: { id: claims.creativeId } });
    if (!creative) throw new AppError(404, 'This ad is no longer available.');

    // A failed save shouldn't stop the viewer reaching the advertiser's page.
    const saved = isBot(req.get('user-agent'))
      ? filterEvent(claims, 'click', 'BOT_USER_AGENT')
      : record(claims, 'CLICK', 'click');
    await saved.catch((error: unknown) =>
      logger.error({ err: String(error) }, 'Click not recorded'),
    );
    res.redirect(302, creative.clickUrl);
  }),
);

export { playbackRouter };
