/**
 * src/server.ts
 *
 * Application entry point.
 *
 * Separated from app.ts so that:
 *  a) Tests can import `app.ts` without starting a real server.
 *  b) The server startup concerns (port binding, graceful shutdown)
 *     are isolated in one place.
 */
import { createApp } from './app';
import { env } from '@/config/env';
import { prisma } from '@/lib/prisma';
import { creativesService } from '@/modules/creatives/creatives.service';
import { refreshAiSettings } from '@/modules/ai/ai.config';
import { startScheduler } from '@/modules/alerts/scheduler';
import { startEventWorker } from '@/modules/delivery/event-queue';
import { startTraffic } from '@/modules/demo/traffic';

const app = createApp();

// A longer queue absorbs bursts of new connections at peak traffic.
const CONNECTION_BACKLOG = 4096;

const server = app.listen({ port: env.PORT, backlog: CONNECTION_BACKLOG }, () => {
  console.info(`🚀  Server running at http://localhost:${env.PORT}`);
  console.info(`📋  Environment: ${env.NODE_ENV}`);
  console.info(`🏥  Health check: http://localhost:${env.PORT}/health`);
  if (env.RUN_EVENT_WORKER) startEventWorker();
  if (env.RUN_SCHEDULER) startScheduler();
  // Settings saved in the dashboard, read again so every API process sees a change.
  void refreshAiSettings();
  setInterval(() => void refreshAiSettings(), 30_000).unref();
  startTraffic();
  creativesService
    .resumeProcessing()
    .catch((error: unknown) => console.error('Ad conversions:', String(error)));
});

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
// Ensures in-flight requests complete and the DB connection is cleanly closed
// before the process exits. Essential for zero-downtime deployments.

const shutdown = (signal: string): void => {
  console.info(`\n📴  ${signal} received. Shutting down gracefully...`);

  server.close(() => {
    console.info('🔌  HTTP server closed.');
    void prisma.$disconnect().finally(() => {
      console.info('🗄️   Database connection closed.');
      process.exit(0);
    });
  });

  // Force exit if graceful shutdown takes too long
  setTimeout(() => {
    console.error('❌  Forced shutdown after timeout.');
    process.exit(1);
  }, 10_000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
