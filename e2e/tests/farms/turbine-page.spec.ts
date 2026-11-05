import {
  expect,
  test,
  type Locator,
  type Page,
  type Response,
} from "@playwright/test";
import { farmsFrom, farmsResponse, turbinesOf } from "../support/fleet.js";
import { SEED_NOW, logIn } from "../support/session.js";
import { boundTelemetryAt } from "../support/telemetry.js";

// Plan 3.6–3.12: the turbine page against the real API (TURB001, the db:seed fixture's Jan 2),
// in a real browser so the charts have a layout: range buttons and their requests, the stats
// lines, brush zoom + Reset zoom and the shared crosshair across the charts, the readings table
// and the empty window. Read-only.
//
// Isolation: the live stream is aborted (no reading arrives mid-test) and the history/stats
// requests are bounded at the browser clock (boundTelemetryAt), so a DB that also holds later
// readings (demo data, the demo feed) still shows the fixture's days. Expectations come from the
// responses the page rendered.

const HOUR = 3_600_000;
const PATH = "/farms/FARM01/turbines/TURB001";

interface Reading {
  timestamp: string;
  powerOutputKw: number;
  windSpeedMs: number;
  rotorRpm: number;
  bladePitchDeg: number;
  gearboxTempC: number;
}
interface Stats {
  count: number;
  metrics: Record<Metric, { median: number; high: number; low: number }>;
}
type Metric =
  | "powerOutputKw"
  | "windSpeedMs"
  | "rotorRpm"
  | "bladePitchDeg"
  | "gearboxTempC";

const METRICS: { key: Metric; unit: string; decimals: number }[] = [
  { key: "powerOutputKw", unit: "kW", decimals: 0 },
  { key: "windSpeedMs", unit: "m/s", decimals: 1 },
  { key: "rotorRpm", unit: "rpm", decimals: 1 },
  { key: "bladePitchDeg", unit: "°", decimals: 1 },
  { key: "gearboxTempC", unit: "°C", decimals: 1 },
];

const fmt = (v: number, decimals: number) =>
  v.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

/** "Jan 2, 23:55" in UTC (date-fns "MMM d, HH:mm"). */
const shortTime = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(new Date(iso))
    .replace(/(\w+) (\d+), /, "$1 $2, ");

const isTelemetry = (r: Response) =>
  /\/api\/turbines\/TURB001\/telemetry$/.test(new URL(r.url()).pathname);
const isStats = (r: Response) =>
  /\/api\/turbines\/TURB001\/telemetry\/stats$/.test(new URL(r.url()).pathname);

/** Signs in with the clock at `at`, no live stream, history bounded at `at`; opens the page. */
async function openTurbine(page: Page, at = SEED_NOW) {
  await page.clock.setFixedTime(at);
  await boundTelemetryAt(page, at);
  await page.route("**/api/events**", (route) => route.abort());
  await logIn(page, "admin");
  // The overview has loaded the fleet (no request of that document still in flight).
  await expect(
    page.getByRole("heading", { name: "Fleet overview" }),
  ).toBeVisible();
  const farms = farmsResponse(page);
  const telemetry = page.waitForResponse(isTelemetry);
  const stats = page.waitForResponse(isStats);
  await page.goto(PATH);
  return {
    farms: farmsFrom(farms),
    readings: telemetry.then((r) => r.json() as Promise<Reading[]>),
    stats: stats.then((r) => r.json() as Promise<Stats>),
  };
}

const charts = (page: Page) =>
  page
    .getByRole("region", { name: "Telemetry charts" })
    .locator("app-line-chart");
const chart = (page: Page, metric: string) =>
  page.locator(`app-line-chart[data-metric="${metric}"]`);
/** The focusable plot (role img, aria-label = the chart's text summary); ECharts' own svg is also an img. */
const plot = (c: Locator) => c.locator('div[role="img"]');

/** The x-axis tick labels each chart draws (SVG text that isn't a y value or a stats label). */
async function xTicks(page: Page): Promise<string[]> {
  return charts(page).evaluateAll((els) =>
    els.map((el) =>
      [...el.querySelectorAll("svg text")]
        .map((t) => t.textContent ?? "")
        .filter((t) => /^(\d\d:\d\d|[A-Z][a-z]{2} \d+)$/.test(t))
        .join("|"),
    ),
  );
}

test.describe("Turbine page (TURB001, fixture day)", () => {
  test("shows the header, the 24h range and one candlestick chart per metric with its stats", async ({
    page,
  }) => {
    const opened = await openTurbine(page);
    const [readings, stats, farms] = await Promise.all([
      opened.readings,
      opened.stats,
      opened.farms,
    ]);
    const turbine = turbinesOf(farms).find((t) => t.id === "TURB001")!;

    await expect(page).toHaveTitle("Turbine · Nextera");
    const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumbs).toHaveText(
      /All farms\s*›\s*Prairie Ridge\s*›\s*TURB001/,
    );
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "TURB001 Prairie Ridge",
    );
    await expect(page.getByTestId("not-commissioned")).toHaveCount(
      turbine.commissioned ? 0 : 1,
    );
    await expect(page.getByTestId("status")).toContainText(
      `Latest reading ${shortTime(turbine.latest!.timestamp)} UTC`,
    );
    await expect(page.getByTestId("window-end")).toHaveText(
      "Ending now (00:00 UTC)",
    );
    const range = page.getByRole("radiogroup", { name: "Time range" });
    await expect(range.getByRole("radio", { name: "24h" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    expect(
      readings.length,
      "fixture readings on Jan 2 (npm run db:seed)",
    ).toBeGreaterThan(0);
    await expect(charts(page)).toHaveCount(6);
    await expect(page.getByTestId("chart-title")).toHaveText([
      "Power output",
      "Wind speed",
      "Rotor speed",
      "Blade pitch",
      "Gearbox temperature",
      "Alert rules triggered",
    ]);
    await expect(page.getByTestId("candle-size")).toHaveText(
      Array(5).fill("30 min candles · drag across the chart to zoom"),
    );
    for (const { key, unit, decimals } of METRICS) {
      const c = chart(page, key);
      await expect(c.locator("svg")).toBeVisible();
      const s = stats.metrics[key];
      await expect(c.getByTestId("stat-median")).toHaveText(
        `${fmt(s.median, decimals)} ${unit}`,
      );
      await expect(c.getByTestId("stat-high")).toHaveText(
        `${fmt(s.high, decimals)} ${unit}`,
      );
      await expect(c.getByTestId("stat-low")).toHaveText(
        `${fmt(s.low, decimals)} ${unit}`,
      );
      // The latest value is the newest reading of the window.
      await expect(c.getByTestId("latest")).toHaveText(
        `${fmt(readings[0][key], decimals)} ${unit}`,
      );
      await expect(plot(c)).toHaveAttribute(
        "aria-label",
        new RegExp(`${readings.length} readings in \\d+ 30 min candles`),
      );
    }
    // The stats cover exactly the rows the readings endpoint returned.
    expect(stats.count).toBe(readings.length);
  });

  for (const [label, hours, candle] of [
    ["6h", 6, "15 min"],
    ["48h", 48, "1 h"],
    ["7d", 168, "4 h"],
  ] as const) {
    test(`the ${label} button asks for ${hours} hours ending now and draws ${candle} candles`, async ({
      page,
    }) => {
      const opened = await openTurbine(page);
      await opened.readings;
      await expect(charts(page)).toHaveCount(6);

      const telemetry = page.waitForRequest((r) =>
        isTelemetry({ url: () => r.url() } as Response),
      );
      const stats = page.waitForRequest((r) =>
        isStats({ url: () => r.url() } as Response),
      );
      const rows = page.waitForResponse(isTelemetry);
      await page.getByRole("radio", { name: label }).click();
      for (const request of [await telemetry, await stats]) {
        const query = new URL(request.url()).searchParams;
        expect(query.get("from")).toBe(
          new Date(SEED_NOW.getTime() - hours * HOUR).toISOString(),
        );
        // Every reading of the window fits (one per 5 minutes, plus the end), up to the API's 2016.
        expect(Number(query.get("limit"))).toBe(Math.min(hours * 12 + 1, 2016));
      }
      const readings = (await (await rows).json()) as Reading[];
      await expect(page.getByRole("radio", { name: label })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(page.getByTestId("candle-size").first()).toHaveText(
        `${candle} candles · drag across the chart to zoom`,
      );
      await expect(plot(chart(page, "powerOutputKw"))).toHaveAttribute(
        "aria-label",
        new RegExp(`${readings.length} readings in \\d+ ${candle} candles`),
      );
      await expect(page.getByTestId("history-paginator")).toContainText(
        `of ${readings.length}`,
      );
    });
  }

  test("dragging across a chart zooms every chart to that window; Reset zoom restores the range", async ({
    page,
  }) => {
    await (
      await openTurbine(page)
    ).readings;
    await expect(charts(page)).toHaveCount(6);
    await expect(
      plot(chart(page, "powerOutputKw")).locator("svg"),
    ).toBeVisible();
    await expect(page.getByTestId("reset-zoom")).toHaveCount(0);
    await expect
      .poll(() => xTicks(page))
      .toEqual(Array(6).fill(expect.stringContaining("Jan 2")));
    const before = await xTicks(page);

    // A horizontal drag over the wind chart (brush), from 30% to 55% of its width.
    const box = (await plot(chart(page, "windSpeedMs")).boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.4, {
      steps: 10,
    });
    await page.mouse.up();

    await expect(page.getByTestId("reset-zoom")).toBeVisible();
    // Every chart now shows the same, finer time axis (half-hour ticks, no day labels).
    await expect
      .poll(async () => new Set(await xTicks(page)).size, {
        message: "one shared axis",
      })
      .toBe(1);
    const zoomed = await xTicks(page);
    expect(zoomed[0]).not.toEqual(before[0]);
    expect(zoomed[0]).not.toMatch(/Jan/);
    expect(zoomed[0].split("|").length).toBeGreaterThan(2);

    await page.getByTestId("reset-zoom").click();
    await expect(page.getByTestId("reset-zoom")).toHaveCount(0);
    await expect.poll(() => xTicks(page)).toEqual(before);
  });

  test("changing the range clears the zoom", async ({ page }) => {
    await (
      await openTurbine(page)
    ).readings;
    const box = (await plot(chart(page, "powerOutputKw")).boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2, {
      steps: 10,
    });
    await page.mouse.up();
    await expect(page.getByTestId("reset-zoom")).toBeVisible();

    await page.getByRole("radio", { name: "48h" }).click();
    await expect(page.getByTestId("candle-size").first()).toContainText(
      "1 h candles",
    );
    await expect(page.getByTestId("reset-zoom")).toHaveCount(0);
  });

  test("hovering one chart moves the crosshair on every chart", async ({
    page,
  }) => {
    await (
      await openTurbine(page)
    ).readings;
    await expect(charts(page)).toHaveCount(6);
    for (const c of await charts(page).all())
      await expect(plot(c)).not.toHaveAttribute("aria-label", /Selected:/);

    const box = (await plot(chart(page, "powerOutputKw")).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // The same candle (time span) is selected on every metric chart.
    const selected = async () =>
      (
        await charts(page)
          .locator('div[role="img"]')
          .evaluateAll((els) =>
            els.map(
              (e) =>
                /Selected: (.+? UTC)/.exec(
                  e.getAttribute("aria-label") ?? "",
                )?.[1] ?? null,
            ),
          )
      ).slice(0, 5);
    await expect
      .poll(selected)
      .toEqual(
        Array(5).fill(
          expect.stringMatching(/^Jan 2, \d\d:\d\d–\d\d:\d\d UTC$/),
        ),
      );
    expect(new Set(await selected()).size).toBe(1);
  });

  test("the readings table lists the window newest first and pages through it", async ({
    page,
  }) => {
    const readings = await (await openTurbine(page)).readings;
    const table = page.getByTestId("history");
    await expect(table.getByRole("columnheader")).toHaveText([
      "Measured (UTC)",
      "Arrived after",
      "Power (kW)",
      "Wind (m/s)",
      "Rotor (rpm)",
      "Pitch (°)",
      "Gearbox (°C)",
      "Alerts",
    ]);
    const rows = table.getByRole("row");
    const paginator = page.getByTestId("history-paginator");
    const firstPage = Math.min(50, readings.length);
    await expect(rows).toHaveCount(firstPage + 1);
    await expect(paginator).toContainText(
      `1 – ${firstPage} of ${readings.length}`,
    );
    const first = rows.nth(1).getByRole("cell");
    await expect(first.nth(0)).toHaveText(shortTime(readings[0].timestamp));
    await expect(first.nth(2)).toHaveText(fmt(readings[0].powerOutputKw, 1));
    await expect(first.nth(6)).toHaveText(fmt(readings[0].gearboxTempC, 1));
    // The fixture triggered no rules (none existed when db:seed loaded it): a dash, no pill.
    // (Flagged readings' pills and tooltip: tests/data/live.spec.ts.)
    expect((readings[0] as { alerts?: unknown[] }).alerts).toEqual([]);
    await expect(table.getByTestId("reading-alerts").first()).toHaveText("–");

    // The fixture has 286 readings on Jan 2: more than one page.
    expect(readings.length).toBeGreaterThan(50);
    await paginator.getByRole("button", { name: "Next page" }).click();
    await expect(paginator).toContainText(
      `51 – ${Math.min(100, readings.length)} of ${readings.length}`,
    );
    await expect(rows.nth(1).getByRole("cell").first()).toHaveText(
      shortTime(readings[50].timestamp),
    );
  });

  test("a window without readings explains it and offers the next longer range", async ({
    page,
  }) => {
    // Jan 4: the fixture ends on Jan 2, so the 24 h window is empty and 48 h reaches Jan 2.
    const at = new Date("2026-01-04T00:00:00Z");
    const opened = await openTurbine(page, at);
    const farms = await opened.farms;
    const latest = turbinesOf(farms).find((t) => t.id === "TURB001")!.latest!;
    expect(await opened.readings).toEqual([]);

    const empty = page.getByTestId("empty-window");
    await expect(empty.getByTestId("empty-window-message")).toHaveText(
      "No readings in the last 24 hours.",
    );
    const lastDay = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(latest.timestamp));
    await expect(empty.getByTestId("empty-window-last-reading")).toHaveText(
      `Last reading: ${lastDay}, ${latest.timestamp.slice(11, 16)} UTC`,
    );
    await expect(charts(page)).toHaveCount(0);
    await expect(page.getByTestId("history")).toHaveCount(0);

    const rows = page.waitForResponse(isTelemetry);
    await empty.getByRole("button", { name: "Show the last 48 hours" }).click();
    const readings = (await (await rows).json()) as Reading[];
    expect(readings.length, "fixture readings on Jan 2").toBeGreaterThan(0);
    await expect(page.getByRole("radio", { name: "48h" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(empty).toHaveCount(0);
    await expect(charts(page)).toHaveCount(6);
  });

  test("the fixture's anomalies show in the 48h stats (TURB002 pitch spike, stuck gearbox; TURB001 0 kW)", async ({
    page,
  }) => {
    // db:seed's planted anomalies: TURB002 Jan 1 18:10 pitch 44°, Jan 2 03:20–03:30 gearbox 126.5 °C;
    // TURB001 Jan 1 13:40–13:50 0 kW at 15.8 m/s. The 48h window at SEED_NOW covers Jan 1–2.
    await page.clock.setFixedTime(SEED_NOW);
    await boundTelemetryAt(page, SEED_NOW);
    await page.route("**/api/events**", (route) => route.abort());
    await logIn(page, "viewer");
    for (const [path, expected] of [
      [
        "/farms/FARM02/turbines/TURB002",
        { bladePitchDeg: "44.0 °", gearboxTempC: "126.5 °C" },
      ],
      [
        "/farms/FARM01/turbines/TURB001",
        { powerOutputKw: "0 kW", windSpeedMs: "15.8 m/s" },
      ],
    ] as const) {
      await page.goto(path);
      await page.getByRole("radio", { name: "48h" }).click();
      await expect(page.getByTestId("candle-size").first()).toContainText(
        "1 h candles",
      );
      for (const [metric, text] of Object.entries(expected)) {
        const stat = metric === "powerOutputKw" ? "stat-low" : "stat-high";
        await expect(chart(page, metric).getByTestId(stat)).toHaveText(text);
      }
    }
  });

  test("an unknown farm or turbine, or a turbine on another farm, shows not found", async ({
    page,
  }) => {
    await page.clock.setFixedTime(SEED_NOW);
    await page.route("**/api/events**", (route) => route.abort());
    await logIn(page, "viewer");

    await page.goto("/farms/NOPE");
    await expect(page.getByTestId("farm-not-found")).toHaveText(
      "Farm NOPE was not found.",
    );
    await page.goto("/farms/FARM01/turbines/NOPE");
    await expect(page.getByTestId("turbine-not-found")).toHaveText(
      "Turbine NOPE was not found on FARM01.",
    );
    await page.goto("/farms/FARM02/turbines/TURB001");
    await expect(page.getByTestId("turbine-not-found")).toHaveText(
      "Turbine TURB001 was not found on FARM02.",
    );
    await page.getByRole("link", { name: "← Back to the farm" }).click();
    await expect(page).toHaveURL(/\/farms\/FARM02$/);
  });
});
