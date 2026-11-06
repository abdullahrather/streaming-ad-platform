/**
 * src/config/env.ts
 *
 * Validates all required environment variables at startup using Zod.
 * If any are missing, the process exits immediately with a clear error.
 * This prevents silent misconfigurations in production.
 */
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const PLACEHOLDER = /^change-me/;

const secret = (name: string, minLength: number): z.ZodType<string> =>
  z
    .string()
    .min(minLength, { error: `${name} must be at least ${minLength} characters long` })
    .refine((value) => process.env['NODE_ENV'] !== 'production' || !PLACEHOLDER.test(value), {
      error: `${name} still has the placeholder value`,
    });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url({ error: 'DATABASE_URL must be a valid connection string URL' }),
  JWT_SECRET: secret('JWT_SECRET', 32),
  JWT_EXPIRES_IN: z.string().default('15m'),
  ENCRYPTION_KEY: secret('ENCRYPTION_KEY', 32),
  APP_URL: z.url().default('http://localhost:5173'),
  SMTP_URL: z.string().default(''),
  MAIL_FROM: z.string().default('Campaign Analytics <no-reply@example.com>'),
  INGEST_API_KEY: secret('INGEST_API_KEY', 16),
  CORS_ORIGIN: z.string().default(''),
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(20),
  /** Dashboard API requests per minute from one address. A busy dashboard page makes about 100. */
  DASHBOARD_RATE_LIMIT: z.coerce.number().int().positive().default(600),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  RUN_EVENT_WORKER: z.stringbool().default(true),
  RUN_SCHEDULER: z.stringbool().default(true),
  ALERT_CHECK_MS: z.coerce.number().int().positive().default(300_000),
  AI_PROVIDER: z.enum(['', 'anthropic', 'openai', 'local']).default(''),
  AI_API_KEY: z.string().default(''),
  AI_MODEL: z.string().default(''),
  AI_BASE_URL: z.string().default(''),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  AI_RATE_LIMIT: z.coerce.number().int().positive().default(30),
  EVENT_DEDUPE_SECONDS: z.coerce.number().int().positive().default(3600),
  DECISION_CACHE_MS: z.coerce.number().int().nonnegative().default(5000),
  MAX_ADS_PER_VIEWER_MINUTE: z.coerce.number().int().positive().default(30),
  MIN_COMPLETION_RATIO: z.coerce.number().nonnegative().default(0.5),
  PLATFORM_TIMEZONE: z.string().default('Europe/Berlin'),
  AUCTION_FLOOR_CPM_CENTS: z.coerce.number().int().positive().default(100),
  MEDIA_DIR: z.string().default('.data/media'),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(200),
  PLAYER_RATE_LIMIT: z.coerce.number().int().positive().default(1200),
  DEMO_MODE: z.stringbool().default(false),
  SIMULATE_TRAFFIC: z.enum(['off', 'on-demand', 'always']).default('off'),
  TRUST_PROXY: z.coerce.number().int().nonnegative().default(0),

  // Billing. Stripe is optional: without a key, admins add credit by hand.
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  // The seller printed on invoices. The defaults are fictional.
  SELLER_NAME: z.string().default('Campaign Analytics GmbH'),
  SELLER_ADDRESS: z.string().default('Beispielstraße 1, 10115 Berlin, Germany'),
  SELLER_VAT_ID: z.string().default('DE000000000'),
  // Free public services: daily euro exchange rates and EU VAT ID checks.
  ECB_RATES_URL: z
    .string()
    .url()
    .default('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'),
  VIES_URL: z.string().url().default('https://ec.europa.eu/taxation_customs/vies/rest-api'),

  // Operations. Logs are JSON lines; LOKI_URL also sends them to Loki.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOKI_URL: z.string().default(''),
  // Prometheus scrapes /metrics with this as a bearer token. Empty serves it only outside production.
  METRICS_TOKEN: z.string().default(''),
  // Alertmanager posts alerts here with this as a bearer token, and admins get them by email.
  ALERT_WEBHOOK_TOKEN: z.string().default(''),
  // Where backups are written. The newest one's age is reported in the metrics.
  BACKUP_DIR: z.string().default('.data/backups'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌  Invalid environment variables:');
  console.error(z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
