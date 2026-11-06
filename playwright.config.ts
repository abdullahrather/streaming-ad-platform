/**
 * playwright.config.ts
 *
 * End-to-end browser tests against the built app: the API serving the dashboard
 * on one port, with the demo data seeded. Run `npm run build`, `npm run build
 * --prefix web` and `npm run db:seed` first, then `npm run test:e2e`.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // The tests share one database, so they run one at a time.
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    locale: 'en-GB',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node dist/server.js',
    url: 'http://localhost:3000/health',
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
  },
});
