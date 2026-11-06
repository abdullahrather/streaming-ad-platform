/**
 * src/app.ts
 *
 * Express application factory.
 *
 * This module exports a fully-configured Express app WITHOUT calling
 * app.listen(). This separation is critical for testability — Jest can
 * import this module and Supertest will bind it to an ephemeral port,
 * so tests don't collide with a running development server.
 */
import fs from 'fs';
import path from 'path';
import express, { type Application, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';

import { accountRouter } from '@/modules/account/account.routes';
import { adminRouter } from '@/modules/admin/admin.routes';
import { aiRouter } from '@/modules/ai/ai.routes';
import { billingRouter, stripeWebhook } from '@/modules/billing/billing.routes';
import { alertsRouter } from '@/modules/alerts/alerts.routes';
import { authRouter } from '@/modules/auth/auth.routes';
import { campaignsRouter } from '@/modules/campaigns/campaigns.routes';
import { creativesRouter, mediaRouter } from '@/modules/creatives/creatives.routes';
import { deliveryRouter } from '@/modules/delivery/delivery.routes';
import { devRouter } from '@/modules/dev/dev.routes';
import { docsRouter } from '@/modules/docs/docs.routes';
import { playbackRouter } from '@/modules/playback/playback.routes';
import { reportsRouter } from '@/modules/reports/reports.routes';
import { segmentsRouter } from '@/modules/segments/segments.routes';
import { showsRouter } from '@/modules/shows/shows.routes';
import { invitationsRouter, teamRouter } from '@/modules/team/team.routes';
import { errorHandler } from '@/middleware/errorHandler';
import { prisma } from '@/lib/prisma';
import { redis } from '@/lib/redis';
import { env } from '@/config/env';

const DASHBOARD_DIR = path.resolve(process.cwd(), 'web', 'dist');

export function createApp(): Application {
  const app = express();

  // Behind a hosting proxy, rate limits need the visitor's address, not the proxy's.
  app.set('trust proxy', env.TRUST_PROXY);

  // ── Security middleware ───────────────────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
    }),
  );
  const origins = env.CORS_ORIGIN.split(',').filter(Boolean);
  app.use(cors({ origin: origins.length > 0 ? origins : false, credentials: true }));

  // ── Body parsing ──────────────────────────────────────────────────────────
  // Stripe signs the raw body, so its webhook is read before the JSON parser.
  app.post(
    '/billing/stripe/webhook',
    express.raw({ type: 'application/json', limit: '1mb' }),
    (req, res) => {
      void stripeWebhook(req, res);
    },
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // ── Logging ───────────────────────────────────────────────────────────────
  if (env.NODE_ENV === 'production') {
    app.use(morgan('combined', { skip: (req) => req.path === '/live' }));
  }

  // ── Status checks (no auth required) ─────────────────────────────────────
  // /live skips the database, so a hosting health check can't keep it awake.
  app.get('/live', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/health', (_req: Request, res: Response) => {
    Promise.all([prisma.$queryRaw`SELECT 1`, redis.ping()])
      .then(() => res.status(200).json({ status: 'ok', environment: env.NODE_ENV }))
      .catch(() => res.status(503).json({ status: 'error', message: 'A service is unavailable.' }));
  });

  // ── API routes ────────────────────────────────────────────────────────────
  app.use(docsRouter);
  app.use(devRouter);
  app.use('/auth', authRouter);
  app.use('/account', accountRouter);
  app.use('/team', teamRouter);
  app.use('/invitations', invitationsRouter);
  app.use('/admin', adminRouter);
  app.use('/campaigns', campaignsRouter);
  app.use('/creatives', creativesRouter);
  app.use(mediaRouter);
  app.use(playbackRouter);
  app.use('/shows', showsRouter);
  app.use('/segments', segmentsRouter);
  app.use('/reports', reportsRouter);
  app.use('/alerts', alertsRouter);
  app.use('/ai', aiRouter);
  app.use('/billing', billingRouter);
  app.use(deliveryRouter);

  // ── Dashboard (when built) ────────────────────────────────────────────────
  if (fs.existsSync(DASHBOARD_DIR)) {
    app.use(express.static(DASHBOARD_DIR, { extensions: ['html'] }));
  }

  // ── 404 handler ───────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ status: 'error', message: 'Route not found.' });
  });

  // ── Global error handler (must be last) ──────────────────────────────────
  app.use(errorHandler);

  return app;
}
