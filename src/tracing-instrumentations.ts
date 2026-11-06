/**
 * src/tracing-instrumentations.ts
 *
 * What gets traced: incoming and outgoing HTTP, Express routes and Redis. Health
 * checks and metrics scrapes are left out, so traces show real work.
 */
import type { Instrumentation } from '@opentelemetry/instrumentation';

const QUIET_PATHS = new Set(['/live', '/health', '/metrics']);

export const getNodeAutoInstrumentations = (): Instrumentation[] => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { HttpInstrumentation } =
    require('@opentelemetry/instrumentation-http') as typeof import('@opentelemetry/instrumentation-http');
  const { ExpressInstrumentation } =
    require('@opentelemetry/instrumentation-express') as typeof import('@opentelemetry/instrumentation-express');
  const { IORedisInstrumentation } =
    require('@opentelemetry/instrumentation-ioredis') as typeof import('@opentelemetry/instrumentation-ioredis');
  /* eslint-enable @typescript-eslint/no-var-requires */

  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (request) =>
        QUIET_PATHS.has((request.url ?? '').split('?')[0] ?? ''),
    }),
    new ExpressInstrumentation(),
    new IORedisInstrumentation(),
  ];
};
