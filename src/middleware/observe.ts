/**
 * src/middleware/observe.ts
 *
 * Every request gets an ID (the caller's X-Request-ID if it sent a sensible one), sent
 * back in the response and written on every log line for that request. Each request is
 * logged once when it finishes, and its duration recorded for Prometheus by route
 * pattern, such as /campaigns/:id, so the metrics don't grow a series per ID.
 */
import crypto from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import pinoHttp from 'pino-http';
import { logger } from '@/lib/logger';
import { httpDuration } from '@/lib/metrics';

const QUIET = new Set(['/live', '/health', '/metrics']);
const REQUEST_ID = /^[\w.-]{8,64}$/;

const routeOf = (req: Request, res: Response): string => {
  const pattern = (req.route as { path?: string } | undefined)?.path;
  if (pattern) return `${req.baseUrl}${pattern}`;
  return res.statusCode === 404 ? 'not_found' : 'other';
};

export const observe = (): RequestHandler[] => [
  (req, res, next): void => {
    const given = req.headers['x-request-id'];
    const id = typeof given === 'string' && REQUEST_ID.test(given) ? given : crypto.randomUUID();
    req.headers['x-request-id'] = id;
    res.setHeader('X-Request-ID', id);

    const stop = httpDuration.startTimer();
    res.on('finish', () => {
      if (QUIET.has(req.path)) return;
      stop({ method: req.method, route: routeOf(req, res), status: String(res.statusCode) });
    });
    next();
  },
  pinoHttp({
    logger,
    genReqId: (req) => String(req.headers['x-request-id']),
    autoLogging: { ignore: (req) => QUIET.has((req.url ?? '').split('?')[0] ?? '') },
    // A request line needs where and how it went, not every header.
    serializers: {
      req: (req: { id: string; method: string; url: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url.split('?')[0],
      }),
      res: (res: { statusCode: number }) => ({ status: res.statusCode }),
    },
    customLogLevel: (_req, res, error) =>
      error || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
  }),
];
