/**
 * e2e/dashboard.spec.ts
 *
 * The dashboard in a real browser: signing in, a campaign's page, a report
 * download, and switching to German and back.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test('signs in and opens a campaign', async ({ page }) => {
  await signIn(page, 'advertiser@example.com', 'advert1234');

  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  const campaigns = page.getByRole('table').first().getByRole('link');
  await expect(campaigns.first()).toBeVisible();
  const title = (await campaigns.first().textContent()) ?? '';
  await campaigns.first().click();

  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Delivery', exact: true })).toBeVisible();
});

test('downloads a report as CSV', async ({ page }) => {
  await signIn(page, 'analyst@example.com', 'analyst1234');
  await page.getByRole('link', { name: 'Reports' }).click();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  const file = await download;

  expect(file.suggestedFilename()).toMatch(/\.csv$/);
  const text = await (await file.createReadStream()).toArray();
  expect(Buffer.concat(text).toString()).toContain('Impressions');
});

test('switches to German and back, keeping the sign-in', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Language').selectOption('de');
  await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible();

  await page.getByLabel('E-Mail').fill('advertiser@example.com');
  await page.getByLabel('Passwort').fill('advert1234');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('heading', { name: 'Übersicht' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');

  await page.getByLabel('Sprache').selectOption('en');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
});

test('a crafted link cannot point campaign requests at another API path', async ({ page }) => {
  await signIn(page, 'admin@example.com', 'admin1234');
  const requested: string[] = [];
  page.on('request', (sent) => requested.push(new URL(sent.url()).pathname));

  await page.goto('/#/campaigns/../admin/users');
  await page.waitForLoadState('networkidle');

  expect(requested.filter((path) => path.startsWith('/admin/users'))).toEqual([]);
});
