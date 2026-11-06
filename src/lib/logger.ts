/**
 * src/lib/logger.ts
 *
 * Structured logs: one JSON object per line, with the level, the time, a message and
 * any fields worth searching on. Each line written while a request is traced carries
 * its trace ID, so a log line leads straight to the trace in Grafana. In development
 * the lines are printed readably; with LOKI_URL set they are also sent to Loki.
 */
import { trace } from '@opentelemetry/api';
import pino, { type TransportTargetOptions } from 'pino';
import { env } from '@/config/env';

const targets: TransportTargetOptions[] = [];
if (env.NODE_ENV === 'development') {
  targets.push({ target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } });
} else if (env.NODE_ENV !== 'test') {
  targets.push({ target: 'pino/file', options: { destination: 1 } });
}
if (env.LOKI_URL && env.NODE_ENV !== 'test') {
  targets.push({
    target: 'pino-loki',
    options: { host: env.LOKI_URL, batching: true, interval: 2, labels: { service: 'api' } },
  });
}

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  base: { service: 'api' },
  // The active trace, so a log line can be found from its trace and the other way round.
  mixin: () => {
    const span = trace.getActiveSpan();
    if (!span) return {};
    const { traceId, spanId } = span.spanContext();
    return { trace_id: traceId, span_id: spanId };
  },
  ...(targets.length > 0 ? { transport: { targets } } : {}),
});
