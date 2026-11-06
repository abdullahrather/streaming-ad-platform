/**
 * src/worker.ts
 *
 * Writes queued ad events to the database. Run this as its own process to scale
 * it separately from the API. Otherwise the API runs a worker itself.
 */
import { prisma } from '@/lib/prisma';
import { startEventWorker } from '@/modules/delivery/event-queue';
import { logger } from '@/lib/logger';

const stop = startEventWorker();
logger.info(`Event worker running (${process.pid}).`);

const shutdown = (): void => {
  void stop()
    .then(() => prisma.$disconnect())
    .finally(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
