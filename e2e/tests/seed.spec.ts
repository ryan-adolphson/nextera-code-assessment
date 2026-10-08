import { expect, test } from '@playwright/test';

// Seed for the Playwright test agents (planner/generator/healer) and a smoke test of sign-in.
// The seed data covers 2026-01-01T00:00Z..2026-01-02T23:55Z and every window in the app ends at
// the client clock, so the clock is fixed just after the last reading: turbines read as reporting,
// the 24 h turbine range covers Jan 2 and History's default (yesterday-today) includes it.
export const SEED_NOW = new Date('2026-01-03T00:00:00Z');

test('seed', async ({ page }) => {
  const email = process.env.E2E_USER ?? 'admin@nextera.local';
  const password = process.env.SEED_USER_PASSWORD;
  if (!password) throw new Error('Set SEED_USER_PASSWORD (repo .env) and run npm run db:seed');

  await page.clock.setFixedTime(SEED_NOW);
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/farms$/);
});
