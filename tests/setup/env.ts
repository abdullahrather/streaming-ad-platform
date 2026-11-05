/**
 * tests/setup/env.ts
 *
 * Runs before each test file's imports, so the app's config and Prisma client
 * can only ever connect to the test database.
 */
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];
if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL must be set to run the tests.');

process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] = testDatabaseUrl;
process.env['JWT_SECRET'] ??= 'test-secret-that-is-at-least-32-characters';
process.env['INGEST_API_KEY'] ??= 'test-ingest-key-1234';
process.env['ENCRYPTION_KEY'] ??= 'test-encryption-key-that-is-long-enough';
process.env['LOGIN_RATE_LIMIT'] = '100000';
const redisUrl = new URL(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
redisUrl.pathname = '/1';
process.env['REDIS_URL'] = redisUrl.toString();
process.env['RUN_EVENT_WORKER'] = 'false';
process.env['RUN_SCHEDULER'] = 'false';
// Schedules and report days are checked against Berlin, daylight saving included.
process.env['PLATFORM_TIMEZONE'] = 'Europe/Berlin';
process.env['DECISION_CACHE_MS'] = '0';
process.env['MIN_COMPLETION_RATIO'] = '0';
// The runner's own AI settings never apply to tests.
process.env['AI_PROVIDER'] = '';
process.env['AI_API_KEY'] = '';
process.env['AI_MODEL'] = '';
process.env['AI_BASE_URL'] = '';
process.env['MAX_ADS_PER_VIEWER_MINUTE'] = '20';
process.env['PLAYER_RATE_LIMIT'] = '100000';
process.env['MEDIA_DIR'] = path.join(os.tmpdir(), 'streaming-ad-platform-test-media');
