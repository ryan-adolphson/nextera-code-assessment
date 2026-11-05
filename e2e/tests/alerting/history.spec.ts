import { expect, test, type Page, type Request } from "@playwright/test";
import { mainNav } from "../support/fleet.js";
import { SEED_NOW, logIn } from "../support/session.js";

// Plan 6: Alerting → History. The default range, the date range picker (a real Material
// calendar overlay), the range errors and Retry run against the real GET /api/alerts. The fixture
// has no flagged readings (rules didn't exist when it was loaded), so the expandable rows, chips
// and paging use a served response here; tests/data/live.spec.ts covers real flagged readings.
// Read-only; live stream aborted.

const isAlerts = (url: string) => /\/api\/alerts$/.test(new URL(url).pathname);
const query = (r: Request) => {
  const q = new URL(r.url()).searchParams;
  return [q.get("from"), q.get("to")];
};

interface Flagged {
  id: string;
  turbineId: string;
  farmId: string;
  timestamp: string;
  receivedAt: string;
  powerOutputKw: number;
  windSpeedMs: number;
  rotorRpm: number;
  bladePitchDeg: number;
  gearboxTempC: number;
  alerts: {
    id: string;
    measurementMetric: string;
    comparison: string;
    valueMetric: number;
    alertLevel: string;
    enabled: boolean;
  }[];
}

const GEARBOX_ERROR = {
  id: "00000000-0000-4000-8000-000000000001",
  measurementMetric: "gearboxTempC",
  comparison: "above",
  valueMetric: 120,
  alertLevel: "error",
  enabled: true,
};
const PITCH_INFO = {
  id: "00000000-0000-4000-8000-000000000002",
  measurementMetric: "bladePitchDeg",
  comparison: "above",
  valueMetric: 30,
  alertLevel: "info",
  enabled: true,
};

/** 30 turbines on FARM01, each with two flagged readings on Jan 2 (newest first). */
function flaggedFleet(): Flagged[] {
  return Array.from({ length: 30 }, (_, i) => {
    const turbineId = `GEN${String(i + 1).padStart(3, "0")}`;
    const reading = (
      n: number,
      hour: number,
      alerts: Flagged["alerts"],
    ): Flagged => ({
      id: `00000000-0000-4000-9000-${String(i * 2 + n).padStart(12, "0")}`,
      turbineId,
      farmId: "FARM01",
      timestamp: `2026-01-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
      receivedAt: `2026-01-02T${String(hour).padStart(2, "0")}:01:00.000Z`,
      powerOutputKw: 1500,
      windSpeedMs: 8,
      rotorRpm: 13,
      bladePitchDeg: 44,
      gearboxTempC: 126.5,
      alerts,
    });
    return [
      reading(0, 23 - (i % 20), [GEARBOX_ERROR, PITCH_INFO]),
      reading(1, 1, [PITCH_INFO]),
    ];
  })
    .flat()
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

async function openHistory(
  page: Page,
): Promise<{ first: Request; body: () => Promise<Flagged[]> }> {
  await page.clock.setFixedTime(SEED_NOW);
  await page.route("**/api/events**", (route) => route.abort());
  await logIn(page, "viewer");
  const request = page.waitForRequest((r) => isAlerts(r.url()));
  const response = page.waitForResponse((r) => isAlerts(r.url()));
  await mainNav(page).getByRole("link", { name: "Alerting" }).click();
  await expect(page).toHaveURL(/\/alerting\/history$/);
  return {
    first: await request,
    body: async () => (await (await response).json()) as Flagged[],
  };
}

const count = (page: Page) => page.getByTestId("history-count");

test.describe("Alerting history", () => {
  test("defaults to yesterday and today (whole UTC days) and counts what the API returned", async ({
    page,
  }) => {
    const { first, body } = await openHistory(page);
    await expect(page).toHaveTitle("Alert history · Nextera");
    // SEED_NOW is Jan 3, 00:00 UTC: yesterday = Jan 2, today = Jan 3 (to = the next midnight).
    expect(query(first)).toEqual([
      "2026-01-02T00:00:00.000Z",
      "2026-01-04T00:00:00.000Z",
    ]);
    await expect(page.getByTestId("history-from")).toHaveValue("1/2/2026");
    await expect(page.getByTestId("history-to")).toHaveValue("1/3/2026");

    const readings = await body();
    const turbines = new Set(readings.map((r) => r.turbineId)).size;
    await expect(count(page)).toHaveText(
      `${readings.length} flagged ${readings.length === 1 ? "reading" : "readings"} on ${turbines} ${turbines === 1 ? "turbine" : "turbines"}`,
    );
    await expect(page.getByTestId("history-turbine")).toHaveCount(
      Math.min(turbines, 25),
    );
    if (!readings.length)
      await expect(page.getByTestId("history-empty")).toHaveText(
        "No alerts in this range.",
      );

    // Tabs: Rules and back.
    const tabs = page.getByRole("tablist", { name: "Alerting" });
    await tabs.getByRole("tab", { name: "Rules" }).click();
    await expect(page).toHaveURL(/\/alerting\/rules$/);
    await tabs.getByRole("tab", { name: "History" }).click();
    await expect(page).toHaveURL(/\/alerting\/history$/);
  });

  test("picking days in the calendar sends one request, for both new days, once the end is picked", async ({
    page,
  }) => {
    await openHistory(page);
    await expect(count(page)).not.toHaveText("Loading alerts…");
    const requests: Request[] = [];
    page.on("request", (r) => {
      if (isAlerts(r.url())) requests.push(r);
    });

    await page.getByRole("button", { name: "Open calendar" }).click();
    const calendar = page.getByRole("dialog");
    // No future days: Jan 3 (today at the fixed clock) is the last one enabled.
    await expect(
      calendar.getByRole("button", { name: "January 4, 2026" }),
    ).toBeDisabled();
    await calendar.getByRole("button", { name: "Previous month" }).click();

    // Mid-pick: the start is set and the end cleared; nothing is sent and no error shows.
    await calendar.getByRole("button", { name: "December 30, 2025" }).click();
    await expect(page.getByTestId("history-from")).toHaveValue("12/30/2025");
    await expect(page.getByTestId("history-to")).toHaveValue("");
    await expect(calendar).toBeVisible();
    await expect(page.getByTestId("history-range-error")).toHaveCount(0);
    await expect(count(page)).toHaveText(
      /flagged readings? on \d+ turbines?|No alerts/,
    );

    const loaded = page.waitForResponse((r) => isAlerts(r.url()));
    await calendar.getByRole("button", { name: "December 31, 2025" }).click();
    await loaded;
    await expect(calendar).toBeHidden();
    await expect(page.getByTestId("history-from")).toHaveValue("12/30/2025");
    await expect(page.getByTestId("history-to")).toHaveValue("12/31/2025");
    await expect(count(page)).toHaveText(/flagged readings? on \d+ turbines?/);
    // Exactly one request since the calendar opened (none with the old end day), whole UTC days.
    expect(requests.map(query)).toEqual([
      ["2025-12-30T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    ]);
  });

  test("closing the calendar on the range already shown sends nothing", async ({
    page,
  }) => {
    await openHistory(page);
    await expect(count(page)).not.toHaveText("Loading alerts…");
    const requests: Request[] = [];
    page.on("request", (r) => {
      if (isAlerts(r.url())) requests.push(r);
    });

    // Re-pick the default days (Jan 2 – Jan 3): complete again, but the same range.
    await page.getByRole("button", { name: "Open calendar" }).click();
    const calendar = page.getByRole("dialog");
    await calendar.getByRole("button", { name: "January 2, 2026" }).click();
    await expect(page.getByTestId("history-to")).toHaveValue("");
    await calendar.getByRole("button", { name: "January 3, 2026" }).click();
    await expect(calendar).toBeHidden();
    await expect(page.getByTestId("history-to")).toHaveValue("1/3/2026");
    await expect(page.getByTestId("history-range-error")).toHaveCount(0);

    // Then a typed day (a real change) is the first request; its answer proves the stream is idle.
    const typed = page.waitForResponse((r) => isAlerts(r.url()));
    await page.getByTestId("history-from").fill("1/1/2026");
    await page.getByTestId("history-from").blur();
    await typed;
    expect(requests.map(query)).toEqual([
      ["2026-01-01T00:00:00.000Z", "2026-01-04T00:00:00.000Z"],
    ]);
  });

  test("typed days load as soon as the range is complete and valid", async ({
    page,
  }) => {
    await openHistory(page);
    await expect(count(page)).not.toHaveText("Loading alerts…");
    const requests: Request[] = [];
    page.on("request", (r) => {
      if (isAlerts(r.url())) requests.push(r);
    });

    const from = page.getByTestId("history-from");
    const to = page.getByTestId("history-to");
    let loaded = page.waitForResponse((r) => isAlerts(r.url()));
    await from.fill("12/30/2025");
    await from.blur();
    await loaded;
    loaded = page.waitForResponse((r) => isAlerts(r.url()));
    await to.fill("12/31/2025");
    await to.blur();
    await loaded;
    await expect(count(page)).toHaveText(/flagged readings? on \d+ turbines?/);
    expect(requests.map(query)).toEqual([
      ["2025-12-30T00:00:00.000Z", "2026-01-04T00:00:00.000Z"],
      ["2025-12-30T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    ]);
  });

  test("an end before the start, or more than 31 days, is explained and not requested", async ({
    page,
  }) => {
    await openHistory(page);
    await expect(count(page)).not.toHaveText("Loading alerts…");
    const requests: string[] = [];
    page.on("request", (r) => {
      if (isAlerts(r.url())) requests.push(r.url());
    });

    const from = page.getByTestId("history-from");
    const to = page.getByTestId("history-to");
    await from.fill("1/2/2026");
    await from.blur();
    await to.fill("1/1/2026");
    await to.blur();
    await expect(page.getByTestId("history-range-error")).toHaveText(
      "The end date must not be before the start date.",
    );

    await from.fill("12/1/2025");
    await from.blur();
    await to.fill("1/2/2026");
    await to.blur();
    await expect(page.getByTestId("history-range-error")).toHaveText(
      "Choose at most 31 days.",
    );
    expect(requests).toEqual([]);

    // Exactly 31 days is fine.
    const request = page.waitForRequest((r) => isAlerts(r.url()));
    await to.fill("12/31/2025");
    await to.blur();
    expect(query(await request)).toEqual([
      "2025-12-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
    await expect(page.getByTestId("history-range-error")).toHaveCount(0);
  });

  test("a failed load shows the error; Retry loads again", async ({ page }) => {
    let fail = true;
    await page.route(
      (url) => isAlerts(url.toString()),
      (route) =>
        fail
          ? route.fulfill({
              status: 500,
              json: { statusCode: 500, message: "Internal server error" },
            })
          : route.continue(),
    );
    await openHistory(page);
    await expect(page.getByTestId("history-error")).toContainText(
      "The alerts could not be loaded.",
    );
    await expect(page.getByTestId("alert-history")).toHaveCount(0);

    fail = false;
    const retried = page.waitForResponse((r) => isAlerts(r.url()) && r.ok());
    await page.getByTestId("history-retry").click();
    await retried;
    await expect(page.getByTestId("history-error")).toHaveCount(0);
    await expect(count(page)).toHaveText(/flagged readings? on \d+ turbines?/);
  });

  test("turbine rows expand to their readings with level chips, 25 turbines per page", async ({
    page,
  }) => {
    const served = flaggedFleet();
    await page.route(
      (url) => isAlerts(url.toString()),
      (route) => route.fulfill({ json: served }),
    );
    await openHistory(page);
    await expect(count(page)).toHaveText("60 flagged readings on 30 turbines");
    const paginator = page.getByTestId("history-paginator");
    await expect(paginator).toContainText("1 – 25 of 30");

    // GEN001's newest reading is at 23:00, so it sorts first (newest alert first).
    const row = page.locator(
      '[data-testid="history-turbine"][data-turbine-id="GEN001"]',
    );
    await expect(row.getByRole("cell").nth(2)).toHaveText(
      "Prairie Ridge FARM01",
    );
    await expect(row.getByTestId("level-count")).toHaveText([
      "Error: 1",
      "Info: 2",
    ]);
    await expect(row).toHaveAttribute("data-level", "error");

    const expand = row.getByRole("button", {
      name: "Show readings for GEN001",
    });
    await expand.click();
    await expect(
      row.getByRole("button", { name: "Hide readings for GEN001" }),
    ).toHaveAttribute("aria-expanded", "true");
    // The chips are @defer'red until the first expand: their chunk loads, then they render.
    const detail = page.getByRole("list", { name: "Readings for GEN001" });
    const readings = detail.getByTestId("history-reading");
    await expect(readings).toHaveCount(2);
    await expect(readings.nth(0)).toContainText("Jan 2, 23:00");
    await expect(readings.nth(0).getByTestId("alert-chip")).toHaveText([
      "Error: Gearbox temperature 126.5 °C > 120",
      "Info: Blade pitch 44° > 30",
    ]);
    await expect(
      readings.nth(0).getByTestId("alert-chip").first(),
    ).toHaveAttribute("data-level", "error");
    await expect(readings.nth(1).getByTestId("alert-chip")).toHaveText([
      "Info: Blade pitch 44° > 30",
    ]);

    // A second row expands independently; a row click toggles too.
    const second = page.getByTestId("history-turbine").nth(1);
    await second.getByRole("cell").nth(1).click();
    await expect(
      page.locator('[data-testid="history-turbine"][data-expanded]'),
    ).toHaveCount(2);
    await row.getByRole("button", { name: "Hide readings for GEN001" }).click();
    await expect(detail).toHaveCount(0);
    await expect(
      page.locator('[data-testid="history-turbine"][data-expanded]'),
    ).toHaveCount(1);

    await paginator.getByRole("button", { name: "Next page" }).click();
    await expect(paginator).toContainText("26 – 30 of 30");
    await expect(page.getByTestId("history-turbine")).toHaveCount(5);
    await expect(
      page.locator('[data-testid="history-turbine"][data-expanded]'),
    ).toHaveCount(0);
  });
});
