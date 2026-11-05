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
  REDIS_URL: z.string().default('redis://localhost:6379'),
  RUN_EVENT_WORKER: z.stringbool().default(true),
  RUN_SCHEDULER: z.stringbool().default(true),
  ALERT_CHECK_MS: z.coerce.number().int().positive().default(300_000),
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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌  Invalid environment variables:');
  console.error(z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
