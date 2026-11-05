import { expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Shared sign-in and API helpers for the browser tests (not a spec: Playwright only runs
 * `*.spec.ts`). The browser clock is fixed just after the seed's last reading (see seed.spec.ts),
 * while the API and ingestion run on the real clock.
 */
export const SEED_NOW = new Date("2026-01-03T00:00:00Z");

/** The compose API (the web image's API_BASE_URL) and ingestion worker. */
export const API_URL = process.env.E2E_API_URL ?? "http://localhost:8080/api";
export const INGESTION_URL =
  process.env.E2E_INGESTION_URL ?? "http://localhost:8081";

export type Role = "viewer" | "owner" | "admin";

export function userEmail(role: Role): string {
  return `${role}@nextera.local`;
}

function seedPassword(): string {
  const password = process.env.SEED_USER_PASSWORD;
  if (!password)
    throw new Error(
      "Set SEED_USER_PASSWORD (repo .env) and run npm run db:seed",
    );
  return password;
}

/** Fixes the browser clock at SEED_NOW and signs in through /login; ends on /farms. */
export async function signIn(page: Page, role: Role): Promise<void> {
  await page.clock.setFixedTime(SEED_NOW);
  await logIn(page, role);
}

/** Signs in through /login (whatever clock the page has); ends on /farms. */
export async function logIn(page: Page, role: Role): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(userEmail(role));
  await page.getByLabel("Password").fill(seedPassword());
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/farms$/);
}

/** A Bearer token for direct API calls (setup, cleanup, checks the UI can't make). */
export async function apiToken(
  request: APIRequestContext,
  role: Role,
): Promise<string> {
  const response = await request.post(`${API_URL}/auth/login`, {
    data: { email: userEmail(role), password: seedPassword() },
  });
  expect(response.status(), "POST /api/auth/login").toBe(200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}
