/**
 * src/tracing.ts
 *
 * OpenTelemetry tracing, on when OTEL_EXPORTER_OTLP_ENDPOINT is set (the standard
 * OpenTelemetry setting), such as http://tempo:4318 in the Docker stack. It records
 * each request, its Express route and its Redis calls, and sends them to Tempo, where
 * Grafana shows them.
 *
 * Imported first in server.ts, before the modules it instruments are loaded.
 */
import dotenv from 'dotenv';
import { getNodeAutoInstrumentations } from './tracing-instrumentations';

dotenv.config({ quiet: true });

const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

if (endpoint && process.env['NODE_ENV'] !== 'test') {
  // Required lazily, so nothing tracing-related loads when tracing is off.
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { NodeSDK } =
    require('@opentelemetry/sdk-node') as typeof import('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } =
    require('@opentelemetry/exporter-trace-otlp-http') as typeof import('@opentelemetry/exporter-trace-otlp-http');
  const { resourceFromAttributes } =
    require('@opentelemetry/resources') as typeof import('@opentelemetry/resources');
  const { ATTR_SERVICE_NAME } =
    require('@opentelemetry/semantic-conventions') as typeof import('@opentelemetry/semantic-conventions');
  /* eslint-enable @typescript-eslint/no-var-requires */

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env['OTEL_SERVICE_NAME'] ?? 'campaign-analytics-api',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: getNodeAutoInstrumentations(),
  });
  sdk.start();

  const shutdown = (): void => {
    void sdk.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
