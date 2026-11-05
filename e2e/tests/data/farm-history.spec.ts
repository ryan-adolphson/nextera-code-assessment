import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { createTurbine } from "../support/fleet.js";
import {
  dayLabel,
  fetchDaily,
  kw,
  nextDaily,
  plotOf,
  powerChart,
  runRollup,
  type FarmDailyHistory,
} from "../support/farm-history.js";
import { apiToken, logIn } from "../support/session.js";
import { uploadTelemetry } from "../support/telemetry.js";
import { removeUnallocated } from "../support/unallocated.js";

/**
 * [DATA] The farm History tab end to end (plan 14.10–14.11): a CSV upload through the ingestion
 * worker (:8081) for a new day, one farm rollup run (`npm run rollup`, the code of the compose
 * farm-rollup service and the Cloud Run Job), then Refresh on an open History tab shows that day
 * as the farm's newest candle.
 *
 * Re-runnable on the same database:
 * - FARM09 (Rolling Hills), which no other test uses. The turbine is new per run (`E2E-<run>-FH`:
 *   held, then assigned through the API), so the "N of M turbines reporting" texts are this run's.
 * - Each run uses four new days after the farm's newest day since Jan 10, 2026 (D-1 baseline,
 *   D, D+1 and D+2 uploads), so every upload is a new day for the farm, and nothing lands in the windows
 *   the read-only tests show at SEED_NOW (they end on Jan 3). The browser clock is fixed on the
 *   day under test, so the 30d range ends there.
 * - The rollup prunes (and never computes) rollups older than 190 days before the newest reading
 *   (or now). In a fixture-only database (CI: FARM01's Jan 2026 days are rolled up) days start on
 *   Jan 10, 2026 and stay before July 2026 (checked), since a later reading would prune the
 *   fixture's January rollups. In a database that also holds current readings (db:seed:demo, the
 *   demo feed; the fixture's rollups are already gone) days start 150 days ago and stay 30 days in
 *   the past. A database that reaches the limit needs `docker compose down -v` + `db:seed`.
 * Left behind (no turbine/telemetry delete API, as in live.spec.ts): the turbine and its readings
 * and their rollups. The Unallocated entry is removed in afterAll.
 */

const FARM = "FARM09";
const DAY_MS = 86_400_000;
/** Midnight UTC of `t`. */
const midnight = (t: number) => Math.floor(t / DAY_MS) * DAY_MS;

/**
 * The days a run may use (see above): [first, last] midnights UTC. Fixture-only when FARM01's
 * fixture days are rolled up; else 150 … 30 days before today.
 */
async function dayWindow(
  request: APIRequestContext,
): Promise<{ first: number; last: number }> {
  const fixture = await fetchDaily(request, token, "FARM01", {
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-03T00:00:00.000Z",
  });
  if (fixture.days.length)
    return {
      first: Date.parse("2026-01-10T00:00:00Z"),
      last: Date.parse("2026-06-30T00:00:00Z"),
    };
  const today = midnight(Date.now());
  return { first: today - 150 * DAY_MS, last: today - 30 * DAY_MS };
}

let TURBINE = "";
let token = "";
/** The baseline day (midnight UTC, epoch ms); the uploads use base + 1, + 2 and + 3 days. */
let base = 0;

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const at = (day: number, hhmm: string) =>
  new Date(day + Date.parse(`1970-01-01T${hhmm}:00Z`)).toISOString();

/** The farm's days in the 30d range ending on `day` (UTC), as the page asks for them. */
const thirtyDays = (
  request: APIRequestContext,
  day: number,
): Promise<FarmDailyHistory> =>
  fetchDaily(request, token, FARM, {
    from: new Date(day - 29 * DAY_MS).toISOString(),
    to: new Date(day + DAY_MS).toISOString(),
  });

/** Runs the rollup until the API shows `day` as the farm's newest (another run may hold the lock). */
async function rollUpUntil(
  request: APIRequestContext,
  day: number,
): Promise<FarmDailyHistory> {
  let history: FarmDailyHistory | undefined;
  await expect
    .poll(
      async () => {
        await runRollup();
        history = await thirtyDays(request, day);
        return history.days.at(-1)?.date;
      },
      {
        message: `the rollup shows ${isoDay(day)} for ${FARM}`,
        timeout: 60_000,
        intervals: [0, 500, 1_000],
      },
    )
    .toBe(isoDay(day));
  return history!;
}

/** Signs in as a viewer with the browser clock at noon UTC of `day`; opens FARM's History tab. */
async function openHistoryOn(
  page: Page,
  day: number,
): Promise<FarmDailyHistory> {
  await page.clock.setFixedTime(new Date(day + 12 * 3_600_000));
  await logIn(page, "viewer");
  const response = nextDaily(page);
  await page.goto(`/farms/${FARM}/history`);
  return response;
}

/** The chart shows `history`'s newest day: latest value, its name in the summary, every candle. */
async function expectNewest(
  page: Page,
  history: FarmDailyHistory,
): Promise<void> {
  const last = history.days.at(-1)!;
  const chart = powerChart(page);
  await expect(chart.getByTestId("latest")).toHaveText(
    `${kw(last.powerOutputKw.close)} kW`,
  );
  await expect(plotOf(chart)).toHaveAttribute(
    "aria-label",
    new RegExp(
      `at ${dayLabel(last.date)}\\. \\d+ readings in ${history.days.length} daily candles\\.`,
    ),
  );
}

test.describe("[DATA] Farm History: upload, rollup, Refresh", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ request }) => {
    TURBINE = `E2E-${Date.now().toString(36).toUpperCase()}-FH`;
    token = await apiToken(request, "owner");
    // Earlier runs' readings may not be rolled up yet (a run that stopped early).
    await runRollup();
    const { first, last } = await dayWindow(request);
    const since = await fetchDaily(request, token, FARM, {
      from: new Date(first).toISOString(),
      to: new Date(last + DAY_MS).toISOString(),
    });
    const newest = since.days.at(-1)?.date;
    base = newest ? Date.parse(`${newest}T00:00:00Z`) + DAY_MS : first;
    expect(
      base + 3 * DAY_MS,
      `${FARM}'s History days reached ${isoDay(last)}: reset the database (docker compose down -v, db:seed)`,
    ).toBeLessThanOrEqual(last);

    // The baseline: the turbine joins FARM with two readings on the base day.
    await createTurbine(request, token, TURBINE, FARM, [
      { timestamp: at(base, "12:00"), powerOutputKw: 1000 },
      { timestamp: at(base, "12:05"), powerOutputKw: 1100 },
    ]);
    await rollUpUntil(request, base);
  });

  test.afterAll(async ({ request }) => {
    await removeUnallocated(
      request,
      await apiToken(request, "owner"),
      (e) => e.turbineId === TURBINE,
    );
  });

  test("[DATA] Refresh shows a new day uploaded and rolled up after the tab opened (app cache only)", async ({
    page,
    request,
  }) => {
    const day = base + DAY_MS;
    // Any page.route turns off the browser's HTTP cache in Playwright, so this test isolates the
    // app's own cache (which Refresh skips). The next test leaves the HTTP cache on.
    await page.route("**/api/events**", (route) => route.abort());
    const before = await openHistoryOn(page, day);
    expect(before.days.at(-1)!.date).toBe(isoDay(base));
    await expectNewest(page, before);

    const uploaded = await uploadTelemetry(request, [
      {
        turbineId: TURBINE,
        farmId: FARM,
        timestamp: at(day, "06:00"),
        powerOutputKw: 1234,
      },
      {
        turbineId: TURBINE,
        farmId: FARM,
        timestamp: at(day, "06:05"),
        powerOutputKw: 1321,
      },
    ]);
    expect(uploaded).toMatchObject({ inserted: 2, duplicates: 0 });
    const after = await rollUpUntil(request, day);
    expect(after.days.at(-1)).toMatchObject({
      date: isoDay(day),
      turbines: 1,
      readings: 2,
      powerOutputKw: { open: 1234, close: 1321, high: 1321, low: 1234 },
    });

    const refreshed = nextDaily(page);
    await page.getByTestId("farm-history-refresh").click();
    expect((await refreshed).days.at(-1)!.date).toBe(isoDay(day));
    await expectNewest(page, after);
    await expect(powerChart(page).getByTestId("latest")).toHaveText("1,321 kW");
  });

  // Regression guard for the browser HTTP cache: Refresh within a minute of a load must reach the
  // server. The API used to answer with `Cache-Control: private, max-age=60`, so Chromium served
  // Refresh from its disk cache and the new day never appeared. It now sends `private, no-cache`
  // (the ETag/304 is unchanged), so the browser revalidates every time. Routes nothing, so
  // Chromium's HTTP cache is on, as for a user.
  test("[DATA] Refresh within a minute of opening shows a new day (browser HTTP cache on)", async ({
    page,
    request,
  }) => {
    const day = base + 2 * DAY_MS;
    const before = await openHistoryOn(page, day);
    expect(before.days.at(-1)!.date).toBe(isoDay(base + DAY_MS));
    await expectNewest(page, before);

    await uploadTelemetry(request, [
      {
        turbineId: TURBINE,
        farmId: FARM,
        timestamp: at(day, "09:00"),
        powerOutputKw: 1500,
      },
    ]);
    const after = await rollUpUntil(request, day);

    const refreshed = nextDaily(page);
    await page.getByTestId("farm-history-refresh").click();
    expect((await refreshed).days.at(-1)!.date).toBe(isoDay(day));
    await expectNewest(page, after);
    await expect(powerChart(page).getByTestId("latest")).toHaveText("1,500 kW");
  });

  // The live path (plan 14.10, `farm-rollup.completed`): no navigation and no Refresh. The rollup
  // run publishes the event through Redis; the open tab's API stream carries it and the page
  // reloads quietly. Routes nothing, so the real event stream is used.
  test("[DATA] An open History tab shows a newly rolled-up day on the rollup event, without Refresh", async ({
    page,
    request,
  }) => {
    const day = base + 3 * DAY_MS;
    const before = await openHistoryOn(page, day);
    expect(before.days.at(-1)!.date).toBe(isoDay(base + 2 * DAY_MS));
    await expectNewest(page, before);
    await expect(page.getByTestId("live-status")).toHaveText("Live");

    await uploadTelemetry(request, [
      {
        turbineId: TURBINE,
        farmId: FARM,
        timestamp: at(day, "10:00"),
        powerOutputKw: 1777,
      },
    ]);
    // The page's own reload (not Refresh): start waiting before the rollup publishes.
    const reloaded = nextDaily(page);
    await rollUpUntil(request, day);
    expect((await reloaded).days.at(-1)!.date).toBe(isoDay(day));

    await expect(powerChart(page).getByTestId("latest")).toHaveText("1,777 kW");
    await expect(page.getByTestId("farm-history-error")).toHaveCount(0);
  });
});
