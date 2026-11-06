/**
 * e2e/privacy.spec.ts
 *
 * GDPR tools in a real browser: a viewer's data on the demo streaming site, and
 * a dashboard user downloading their data and deleting their account.
 */
import { expect, test, type Download } from '@playwright/test';
import { signIn } from './helpers';

const json = async (download: Download): Promise<Record<string, unknown>> => {
  const chunks = await (await download.createReadStream()).toArray();
  return (JSON.parse(Buffer.concat(chunks).toString()) as { data: Record<string, unknown> }).data;
};

test('a viewer downloads and deletes their data on the streaming site', async ({ page }) => {
  await page.goto('/watch');
  await page.getByRole('list').getByRole('button').first().click();
  await page.getByLabel('Use what I watch to choose ads').check();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download my data' }).click();
  const data = await json(await download);
  expect(data['consent']).toBe(true);
  expect(data).toHaveProperty('interests');

  await page.getByRole('button', { name: 'Delete my data' }).click();
  await expect(page.getByText('Everything held about you was deleted')).toBeVisible();
  await expect(page.getByLabel('Use what I watch to choose ads')).not.toBeChecked();
});

test('a user downloads their data, then deletes their account', async ({ page, request }) => {
  const email = `e2e-${Date.now()}@example.com`;
  const password = 'E2e-password-123';
  const registered = await request.post('/auth/register', {
    data: { email, password, name: 'Erin Example', organisationName: 'Erin Studio' },
  });
  expect(registered.status()).toBe(202);
  // The local mailbox holds the confirmation link, since no mail server is set up.
  const mailbox = (await (await request.get('/dev/mailbox')).json()) as {
    data: { recipient: string; link: string }[];
  };
  const link = mailbox.data.find((mail) => mail.recipient === email)?.link ?? '';
  await page.goto(`/${new URL(link).hash}`);
  await expect(page.getByText('Your email is confirmed')).toBeVisible();

  await signIn(page, email, password);
  await page.getByRole('link', { name: 'Account' }).click();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download my data' }).click();
  const data = await json(await download);
  expect((data['profile'] as { email: string }).email).toBe(email);

  await page.getByRole('button', { name: 'Delete my account…' }).click();
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Delete my account', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  const again = await request.post('/auth/login', { data: { email, password } });
  expect(again.status()).toBe(401);
});
