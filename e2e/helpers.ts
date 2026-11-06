import { expect, type Page } from '@playwright/test';

/** Signs in and waits for the overview, where every sign-in lands. */
export const signIn = async (page: Page, email: string, password: string): Promise<void> => {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
};
