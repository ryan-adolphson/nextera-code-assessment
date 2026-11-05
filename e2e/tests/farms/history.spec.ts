import { expect, test, type Page, type Request } from "@playwright/test";
import { fixBrowserDate, shortTimeIn } from "../support/clock.js";
import {
  dailyQuery,
  dayLabel,
  escapeRegExp,
  historyRange,
  kw,
  nextDaily,
  plotOf,
  powerChart,
  rangeButton,
  recordDailyRequests,
  reportingDetail,
  selectedText,
  summaryText,
  utcRange,
  type FarmDailyHistory,
} from "../support/farm-history.js";
import { SEED_NOW, logIn, signIn } from "../support/session.js";

// Plan 14: the farm's History tab (/farms/:farmId/history, FarmHistoryPage): the farm's power
// output as one daily candle, from GET /api/farms/:farmId/telemetry/daily (precomputed by the farm
// rollup; db:seed runs one). Ranges 30d / 90d / 6 months of whole days ending today in the zone
// shown; answers are kept in memory per (farm, range, zone) for 15 minutes; Retry and Refresh
// skip that cache. Read-only.
//
// The clock is fixed at SEED_NOW (Jan 3, 00:00 UTC), so the default 30d range is Dec 5 … Jan 3
// and covers the fixture's Jan 1–2. Expected texts are derived from the response the page
// rendered (real API, no mocks except the 500). The live stream is cut (abort), so nothing changes
// the page mid-test. Note: any page.route also turns off Playwright's browser HTTP cache, so these
// request counts see the app's own cache only; the browser's HTTP cache (the API sends
// Cache-Control: private, no-cache, so every load revalidates) is guarded by
// tests/data/farm-history.spec.ts, which routes nothing.
//
// Locally, a database that also holds readings from now (db:seed:demo, the demo feed) prunes
// rollups older than 190 days before its newest reading, so the fixture's January days have no
// rollups there; the tests that need those days skip with that reason (CI's database has the
// fixture alone).

const FARM = "FARM01";
const FARM_NAME = "Prairie Ridge";
/** No test writes to it, and neither the fixture nor the demo data has readings near Jan 2026. */
const EMPTY_FARM = "FARM10";
const HISTORY_URL = `/farms/${FARM}/history`;
const TODAY = "2026-01-03"; // SEED_NOW's day in UTC
const PRUNED =
  "No rollups for the fixture days: this database also holds recent readings (db:seed:demo / " +
  "the demo feed), so January 2026 is past the rollup retention. CI runs on the fixture alone.";

const tabs = (page: Page) => page.getByTestId("farm-tabs");
const tab = (page: Page, id: "overview" | "history" | "weather") =>
  page.getByTestId(`farm-tab-${id}`);
const status = (page: Page) => page.getByTestId("farm-history-status");
const refresh = (page: Page) => page.getByTestId("farm-history-refresh");

/** A UTC browser at SEED_NOW, no live stream, signed in as a viewer; records daily requests. */
async function open(page: Page): Promise<Request[]> {
  await page.route("**/api/events**", (route) => route.abort());
  const seen = recordDailyRequests(page);
  await signIn(page, "viewer");
  return seen;
}

/** Opens the History tab by URL; resolves the response it rendered. */
async function openHistory(
  page: Page,
  url = HISTORY_URL,
): Promise<FarmDailyHistory> {
  const response = nextDaily(page);
  await page.goto(url);
  return response;
}

test.describe("Farm tabs: History", () => {
  test("History sits between Overview and Weather history and opens its own URL", async ({
    page,
  }) => {
    await open(page);
    await page.goto(`/farms/${FARM}`);

    await expect(tabs(page).getByRole("tab")).toHaveText([
      "Overview",
      "History",
      "Weather history",
    ]);
    await expect(tab(page, "overview")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(tab(page, "history")).toHaveAttribute(
      "aria-selected",
      "false",
    );

    await tab(page, "history").click();
    await expect(page).toHaveURL(new RegExp(`${HISTORY_URL}$`));
    await expect(tab(page, "history")).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, "overview")).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await expect(tab(page, "weather")).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await expect(page).toHaveTitle(`${FARM_NAME} · History · Nextera`);
    await expect(historyRange(page)).toBeVisible();
    await expect(page.getByTestId("farm-power")).toHaveCount(0);

    await tab(page, "weather").click();
    await expect(page).toHaveURL(new RegExp(`/farms/${FARM}/weather$`));
    await expect(tab(page, "weather")).toHaveAttribute("aria-selected", "true");
    await expect(historyRange(page)).toHaveCount(0);

    await tab(page, "overview").click();
    await expect(page).toHaveURL(new RegExp(`/farms/${FARM}$`));
    await expect(page.getByTestId("farm-power")).toBeVisible();
  });

  test("a deep link opens History with one request, and the back link returns to all farms", async ({
    page,
  }) => {
    const seen = await open(page);
    await openHistory(page);

    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      `${FARM_NAME} ${FARM}`,
    );
    await expect(tab(page, "history")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("farm-history-note")).toBeVisible();
    expect(seen).toHaveLength(1);

    await page.getByTestId("back-to-farms").click();
    await expect(page).toHaveURL(/\/farms$/);
    await expect(page.getByTestId("farms")).toBeVisible();
  });

  test("an unknown farm says it was not found and sends no request", async ({
    page,
  }) => {
    const seen = await open(page);
    await page.goto("/farms/NOPE/history");

    await expect(page.getByTestId("farm-not-found")).toHaveText(
      "Farm NOPE was not found.",
    );
    await expect(tabs(page)).toHaveCount(0);
    await expect(historyRange(page)).toHaveCount(0);
    expect(seen).toEqual([]);
  });
});

test.describe("History tab (UTC, real API)", () => {
  test("the default range is the last 30 UTC days ending today, in one request", async ({
    page,
  }) => {
    const seen = await open(page);
    const history = await openHistory(page);

    await expect(rangeButton(page, "30d")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(rangeButton(page, "90d")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(rangeButton(page, "6m")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(page.getByText("Days are UTC.")).toBeVisible();
    expect(seen.map(dailyQuery)).toEqual([
      // Dec 5 … Jan 3 (today included).
      {
        farmId: FARM,
        from: "2025-12-05T00:00:00.000Z",
        to: "2026-01-04T00:00:00.000Z",
        timeZone: "UTC",
      },
    ]);
    // The API echoes the query.
    expect(history).toMatchObject({
      farmId: FARM,
      from: "2025-12-05T00:00:00.000Z",
      to: "2026-01-04T00:00:00.000Z",
      timeZone: "UTC",
    });
  });

  test("the fixture days are daily candles: count, latest value and selected-day text from the response", async ({
    page,
  }) => {
    await open(page);
    const history = await openHistory(page);
    test.skip(history.days.length === 0, PRUNED);
    // db:seed's Jan 1 and Jan 2 (later [DATA] runs add turbines to FARM01, never days in this range).
    expect(history.days.map((d) => d.date)).toEqual([
      "2026-01-01",
      "2026-01-02",
    ]);

    const chart = powerChart(page);
    await expect(
      page.getByTestId("farm-history-charts").locator("app-line-chart"),
    ).toHaveCount(1);
    await expect(chart.getByTestId("chart-title")).toHaveText(
      "Farm power output",
    );
    await expect(chart.getByTestId("candle-size")).toHaveText(
      "Daily candles · drag across the chart to zoom",
    );
    const last = history.days.at(-1)!;
    await expect(chart.getByTestId("latest")).toHaveText(
      `${kw(last.powerOutputKw.close)} kW`,
    );
    await expect(chart.getByTestId("chart-empty")).toHaveCount(0);
    await expect(chart.locator("svg").first()).toBeVisible();
    // The summary counts every candle and reading of the response.
    await expect(plotOf(chart)).toHaveAttribute(
      "aria-label",
      summaryText(history),
    );

    // Focus selects the latest day: its tooltip and the selected text name the day, its OHLC and
    // how many of the farm's turbines reported.
    await plotOf(chart).focus();
    await expect(plotOf(chart)).toHaveAttribute(
      "aria-label",
      new RegExp(`${escapeRegExp(selectedText(last, history.turbineCount))}$`),
    );
    await expect(
      chart.getByText(
        `${dayLabel(last.date)} · ${reportingDetail(last, history.turbineCount)}`,
      ),
    ).toBeVisible();
    // Home moves to the first day.
    await plotOf(chart).press("Home");
    await expect(plotOf(chart)).toHaveAttribute(
      "aria-label",
      new RegExp(
        `${escapeRegExp(selectedText(history.days[0], history.turbineCount))}$`,
      ),
    );
    await expect(page.getByTestId("farm-history-reset-zoom")).toHaveCount(0);
    await expect(page.getByTestId("farm-history-empty")).toHaveCount(0);
  });

  test("dragging across the chart zooms it; Reset zoom and a range change clear the zoom", async ({
    page,
  }) => {
    await open(page);
    const history = await openHistory(page);
    test.skip(history.days.length === 0, PRUNED);
    const reset = page.getByTestId("farm-history-reset-zoom");
    const brush = async () => {
      const box = (await plotOf(powerChart(page)).boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4, {
        steps: 10,
      });
      await page.mouse.up();
    };
    await expect(reset).toHaveCount(0);

    await brush();
    await expect(reset).toBeVisible();
    await reset.click();
    await expect(reset).toHaveCount(0);

    await brush();
    await expect(reset).toBeVisible();
    const answered = nextDaily(page);
    await rangeButton(page, "90d").click();
    await answered;
    await expect(reset).toHaveCount(0);
  });

  test("the status line says when the rollup last ran (computedAt) and how often it refreshes", async ({
    page,
  }) => {
    await open(page);
    const history = await openHistory(page);
    test.skip(history.computedAt === null, PRUNED);

    await expect(status(page)).toHaveRole("status");
    await expect(page.getByTestId("farm-history-updated")).toHaveText(
      `Updated ${shortTimeIn(history.computedAt!, "UTC")} UTC.`,
    );
    await expect(page.getByTestId("farm-history-note")).toHaveText(
      "Daily figures refresh every 15 minutes.",
    );
  });

  test("90d and 6 months send one request each; switching back is answered from the cache", async ({
    page,
  }) => {
    const seen = await open(page);
    await openHistory(page);
    await expect(refresh(page)).toBeEnabled();

    for (const [id, days] of [
      ["90d", 90],
      ["6m", 182],
    ] as const) {
      const answered = nextDaily(page);
      await rangeButton(page, id).click();
      await expect(rangeButton(page, id)).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(await answered).toMatchObject(utcRange(TODAY, days));
      await expect(refresh(page)).toBeEnabled();
    }
    expect(seen.map(dailyQuery)).toEqual([
      { farmId: FARM, ...utcRange(TODAY, 30), timeZone: "UTC" },
      // Oct 6 … Jan 3, then Jul 6 … Jan 3 (182 days: the API allows 183).
      {
        farmId: FARM,
        from: "2025-10-06T00:00:00.000Z",
        to: "2026-01-04T00:00:00.000Z",
        timeZone: "UTC",
      },
      {
        farmId: FARM,
        from: "2025-07-06T00:00:00.000Z",
        to: "2026-01-04T00:00:00.000Z",
        timeZone: "UTC",
      },
    ]);

    // Back to 30d, then 90d: both answered from memory.
    await rangeButton(page, "30d").click();
    await expect(rangeButton(page, "30d")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByTestId("farm-history-note")).toBeVisible();
    await rangeButton(page, "90d").click();
    await expect(rangeButton(page, "90d")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(refresh(page)).toBeEnabled();
    // A fence: Refresh does send a request, so any request the switches sent would come before it.
    const refreshed = nextDaily(page);
    await refresh(page).click();
    await refreshed;
    expect(seen.map((r) => dailyQuery(r).from)).toEqual([
      "2025-12-05T00:00:00.000Z",
      "2025-10-06T00:00:00.000Z",
      "2025-07-06T00:00:00.000Z",
      "2025-10-06T00:00:00.000Z", // the Refresh
    ]);
  });

  test("Refresh skips the cache: one new request for the same days, and the chart stays", async ({
    page,
  }) => {
    const seen = await open(page);
    const first = await openHistory(page);
    await expect(refresh(page)).toBeEnabled();

    const refreshed = nextDaily(page);
    await refresh(page).click();
    const second = await refreshed;
    expect(seen).toHaveLength(2);
    expect(dailyQuery(seen[1])).toEqual(dailyQuery(seen[0]));
    expect(second.days).toEqual(first.days);
    await expect(refresh(page)).toBeEnabled();
    await expect(page.getByTestId("farm-history-note")).toBeVisible();
    await expect(page.getByTestId("farm-history-error")).toHaveCount(0);
    if (second.days.length)
      await expect(powerChart(page).getByTestId("latest")).toHaveText(
        `${kw(second.days.at(-1)!.powerOutputKw.close)} kW`,
      );
  });

  test("a 500 shows the error without a chart or Refresh; Retry loads the days", async ({
    page,
  }) => {
    let failures = 1;
    await page.route(
      (url) => /\/api\/farms\/[^/]+\/telemetry\/daily$/.test(url.pathname),
      async (route) => {
        if (route.request().method() === "GET" && failures > 0) {
          failures--;
          await route.fulfill({
            status: 500,
            json: { statusCode: 500, message: "Internal server error" },
          });
        } else {
          await route.continue();
        }
      },
    );
    const seen = await open(page);
    await page.goto(HISTORY_URL);

    const error = page.getByTestId("farm-history-error");
    await expect(error).toHaveRole("alert");
    await expect(error).toContainText("The daily history could not be loaded.");
    await expect(refresh(page)).toHaveCount(0);
    await expect(page.getByTestId("farm-history-charts")).toHaveCount(0);
    await expect(page.getByTestId("farm-history-empty")).toHaveCount(0);
    expect(seen).toHaveLength(1);

    const answered = nextDaily(page);
    await page.getByTestId("farm-history-retry").click();
    const history = await answered;
    await expect(error).toHaveCount(0);
    await expect(refresh(page)).toBeVisible();
    await expect(page.getByTestId("farm-history-note")).toBeVisible();
    expect(seen.map(dailyQuery)).toEqual([
      dailyQuery(seen[0]),
      dailyQuery(seen[0]),
    ]);
    if (history.days.length)
      await expect(powerChart(page).getByTestId("latest")).toHaveText(
        `${kw(history.days.at(-1)!.powerOutputKw.close)} kW`,
      );
    else await expect(page.getByTestId("farm-history-empty")).toBeVisible();
  });

  test("a farm without daily history shows the empty state and no chart", async ({
    page,
  }) => {
    await open(page);
    const history = await openHistory(page, `/farms/${EMPTY_FARM}/history`);
    expect(
      history.days,
      `${EMPTY_FARM} has no readings around Jan 2026`,
    ).toEqual([]);

    await expect(page.getByTestId("farm-history-empty")).toHaveText(
      "No daily history yet for this farm.",
    );
    await expect(page.getByTestId("farm-history-charts")).toHaveCount(0);
    await expect(page.getByTestId("farm-history-error")).toHaveCount(0);
    await expect(page.getByTestId("farm-history-note")).toBeVisible();
    await expect(refresh(page)).toBeVisible();
  });
});

test.describe("History tab in Local time (browser in America/Chicago)", () => {
  test.use({ timezoneId: "America/Chicago" });
  const ZONE = "America/Chicago";

  test("Local mode asks for local-midnight days and draws the response in Chicago days", async ({
    page,
  }) => {
    // fixBrowserDate, not page.clock: page.clock's Date breaks the zoned Date subclasses
    // (support/clock.ts). SEED_NOW is Jan 2, 18:00 CST.
    await fixBrowserDate(page, SEED_NOW);
    await page.route("**/api/events**", (route) => route.abort());
    const seen = recordDailyRequests(page);
    await logIn(page, "viewer");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Settings" })
      .click();
    const local = page
      .getByTestId("time-zone")
      .getByRole("radio", { name: /^Local/ });
    await local.click();
    await expect(local).toHaveAttribute("aria-checked", "true");

    const history = await openHistory(page);
    await expect(
      page.getByText(`Days are local time (${ZONE}).`),
    ).toBeVisible();
    // Dec 4 … Jan 2 in Chicago: local midnights are 06:00 UTC (CST, UTC−6).
    expect(seen.map(dailyQuery)).toEqual([
      {
        farmId: FARM,
        from: "2025-12-04T06:00:00.000Z",
        to: "2026-01-03T06:00:00.000Z",
        timeZone: ZONE,
      },
    ]);
    expect(history.timeZone).toBe(ZONE);

    test.skip(history.days.length === 0, PRUNED);
    // The fixture's Jan 1–2 UTC readings span three Chicago days (Dec 31 18:00 CST on).
    expect(history.days.map((d) => d.date)).toEqual([
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
    ]);
    const chart = powerChart(page);
    await expect(plotOf(chart)).toHaveAttribute(
      "aria-label",
      summaryText(history),
    );
    await expect(chart.getByTestId("latest")).toHaveText(
      `${kw(history.days.at(-1)!.powerOutputKw.close)} kW`,
    );
    await expect(page.getByTestId("farm-history-updated")).toHaveText(
      `Updated ${shortTimeIn(history.computedAt!, ZONE)} ${zoneName(history.computedAt!, ZONE)}.`,
    );
  });
});

/** "CST" / "CDT": the zone's short name at `iso` (en-US). */
function zoneName(iso: string, zone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    timeZoneName: "short",
  })
    .formatToParts(new Date(iso))
    .find((p) => p.type === "timeZoneName")!.value;
}
