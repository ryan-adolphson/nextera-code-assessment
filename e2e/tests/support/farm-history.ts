import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import { API_URL } from "./session.js";

/**
 * Helpers for the farm History tab (/farms/:farmId/history, FarmHistoryPage): the
 * GET /api/farms/:farmId/telemetry/daily shape (mirrors apps/web/src/app/farm-history/farm-history.model.ts),
 * a recorder for the page's daily requests, oracles for the texts the chart derives from a
 * response, and a farm rollup run for [DATA] tests.
 */

export interface Ohlc {
  open: number;
  close: number;
  high: number;
  low: number;
}

export interface FarmDailyDay {
  date: string;
  turbines: number;
  readings: number;
  powerOutputKw: Ohlc;
  windSpeedMs: Ohlc;
  rotorRpm: Ohlc;
  bladePitchDeg: Ohlc;
  gearboxTempC: Ohlc;
}

export interface FarmDailyHistory {
  farmId: string;
  from: string;
  to: string;
  timeZone: string;
  turbineCount: number;
  computedAt: string | null;
  days: FarmDailyDay[];
}

const DAILY = /\/api\/farms\/([^/]+)\/telemetry\/daily$/;

/** True for a GET of a farm's daily history (not the CORS preflight). */
export function isDailyRequest(request: Request): boolean {
  return (
    request.method() === "GET" && DAILY.test(new URL(request.url()).pathname)
  );
}

/** The farm and query of a daily request. */
export function dailyQuery(request: Request) {
  const url = new URL(request.url());
  return {
    farmId: decodeURIComponent(DAILY.exec(url.pathname)?.[1] ?? ""),
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
    timeZone: url.searchParams.get("timeZone"),
  };
}

/** Records every daily request the page sends from now on (in order). */
export function recordDailyRequests(page: Page): Request[] {
  const seen: Request[] = [];
  page.on("request", (request) => {
    if (isDailyRequest(request)) seen.push(request);
  });
  return seen;
}

/** The next daily response of the page (start waiting before the action). */
export async function nextDaily(page: Page): Promise<FarmDailyHistory> {
  const response = await page.waitForResponse((r) =>
    isDailyRequest(r.request()),
  );
  expect(response.status(), "GET /api/farms/:farmId/telemetry/daily").toBe(200);
  return (await response.json()) as FarmDailyHistory;
}

/** GET /api/farms/:farmId/telemetry/daily through the API (setup and oracles outside the page). */
export async function fetchDaily(
  request: APIRequestContext,
  token: string,
  farmId: string,
  query: { from: string; to: string; timeZone?: string },
): Promise<FarmDailyHistory> {
  const response = await request.get(
    `${API_URL}/farms/${encodeURIComponent(farmId)}/telemetry/daily`,
    {
      params: { timeZone: "UTC", ...query },
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as FarmDailyHistory;
}

// --- What the page shows ----------------------------------------------------------------------

export const historyRange = (page: Page): Locator =>
  page.getByTestId("farm-history-range");

/** A range option's toggle button (it carries aria-checked). */
export const rangeButton = (page: Page, id: "30d" | "90d" | "6m"): Locator =>
  page.getByTestId(`farm-history-range-${id}`).getByRole("radio");

export const powerChart = (page: Page): Locator =>
  page
    .getByTestId("farm-history-charts")
    .locator('app-line-chart[data-metric="powerOutputKw"]');

/** The focusable plot (role img; its aria-label is the chart's text summary). */
export const plotOf = (chart: Locator): Locator =>
  chart.locator('div[role="img"]');

/** Power as the chart formats it (0 decimals, en-US). */
export const kw = (v: number): string =>
  v.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

/** "Fri, Jan 2, 2026": a YYYY-MM-DD day's candle name (date-fns 'EEE, MMM d, yyyy'). */
export function dayLabel(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00Z`));
}

/** "2 of 3 turbines reporting": a day candle's detail line. */
export const reportingDetail = (
  day: FarmDailyDay,
  turbineCount: number,
): string =>
  `${day.turbines} of ${turbineCount} ${turbineCount === 1 ? "turbine" : "turbines"} reporting`;

/** The aria-label sentence the chart gives a selected day candle. */
export function selectedText(day: FarmDailyDay, turbineCount: number): string {
  const p = day.powerOutputKw;
  return (
    `Selected: ${dayLabel(day.date)}: start ${kw(p.open)}, end ${kw(p.close)}, ` +
    `low ${kw(p.low)}, high ${kw(p.high)} kW (${reportingDetail(day, turbineCount)}).`
  );
}

/** The chart's summary: latest value at its day, readings in N daily candles. */
export function summaryText(history: FarmDailyHistory): string {
  const last = history.days.at(-1)!;
  const readings = history.days.reduce((sum, d) => sum + d.readings, 0);
  return (
    `Farm power output: latest ${kw(last.powerOutputKw.close)} kW at ${dayLabel(last.date)}. ` +
    `${readings} readings in ${history.days.length} daily candles.`
  );
}

/** Escapes a string for use inside a RegExp. */
export const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** [from, to) of the last `days` whole UTC days ending on `today` (YYYY-MM-DD), as the page asks. */
export function utcRange(
  today: string,
  days: number,
): { from: string; to: string } {
  const end = Date.parse(`${today}T00:00:00.000Z`) + 86_400_000;
  return {
    from: new Date(end - days * 86_400_000).toISOString(),
    to: new Date(end).toISOString(),
  };
}

// --- The farm rollup --------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * One incremental farm rollup run (`npm run rollup` at the repo root, the same code as the compose
 * farm-rollup service and the Cloud Run Job), against DATABASE_URL (the repo .env, which the
 * Playwright config loads; a real env var wins). A run skipped because another holds the lock
 * exits 0 too, so callers poll the API for the result rather than trusting one run.
 */
export async function runRollup(): Promise<string> {
  const { stdout } = await promisify(execFile)(
    "npm",
    ["run", "--silent", "rollup"],
    {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: 60_000,
    },
  );
  return stdout;
}
