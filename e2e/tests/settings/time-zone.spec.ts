import { expect, test, type Page, type Response } from "@playwright/test";
import { fixBrowserDate } from "../support/clock.js";
import { fetchTurbine, isApiGet, pageToken } from "../support/fleet.js";
import { SEED_NOW, logIn, userEmail, type Role } from "../support/session.js";

// Plan 12: Settings → Time zone, in a browser whose zone is America/Chicago (UTC−6 in January).
// Read-only: the setting lives in the browser's localStorage, and each test has its own context.
//
// The clock is fixed at SEED_NOW (2026-01-03T00:00Z = Jan 2, 18:00 CST) with fixBrowserDate, not
// page.clock: page.clock's Date breaks the Date subclasses the app formats with (UTCDate, TZDate),
// which only goes unnoticed in a UTC browser (see support/clock.ts).
//
// The live stream is cut (page.route abort): a reading arriving over SSE (the demo feed, another
// test's upload) would change a turbine's latest reading mid-test. The app then retries in the
// background and never opens, so nothing resyncs either. The latest reading's expected text is
// derived from the GET /api/farms response the page rendered (with the db:seed fixture alone:
// TURB001's 2026-01-02T23:55Z reading, "Jan 2, 23:55 UTC" / "Jan 2, 17:55 CST").

test.use({ timezoneId: "America/Chicago" });

const ZONE = "America/Chicago";
const TURBINE = "TURB001";

interface Farms {
  turbines: { id: string; latest: { timestamp: string } | null }[];
}

/** "Jan 2, 17:55" (date-fns "MMM d, HH:mm") of `iso` in `zone`, with " CST" when `withZone`. */
function shown(iso: string, zone: string, withZone = false): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)!.value;
  const text = `${part("month")} ${part("day")}, ${part("hour")}:${part("minute")}`;
  return withZone ? `${text} ${part("timeZoneName")}` : text;
}

/** TURBINE's latest measurement time in the next GET /api/farms response. */
const latestFrom = (loaded: Promise<Page>) => latestOf(loaded);

/** Resolves when the page has loaded its summaries; TURBINE's latest time then comes from the API. */
const farmsResponse = (page: Page): Promise<Page> =>
  page.waitForResponse((r) => isApiGet(r, "farm-summaries")).then(() => page);

async function latestOf(loaded: Promise<Page>): Promise<string> {
  const page = await loaded;
  const turbine = await fetchTurbine(
    page.request,
    await pageToken(page),
    TURBINE,
  );
  expect(
    turbine.latest,
    `${TURBINE} has a reading (npm run db:seed)`,
  ).toBeTruthy();
  return turbine.latest!.timestamp;
}

/** A fixed clock, no live stream, signed in as `role` on /farms; resolves TURBINE's latest time. */
async function open(page: Page, role: Role = "admin"): Promise<string> {
  await fixBrowserDate(page, SEED_NOW);
  await page.route("**/api/events**", (route) => route.abort());
  const farms = farmsResponse(page);
  await logIn(page, role);
  return latestFrom(farms);
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });
const zoneToggle = (page: Page, name: "UTC" | RegExp) =>
  page.getByTestId("time-zone").getByRole("radio", { name, exact: true });

async function chooseOnSettings(
  page: Page,
  mode: "UTC" | "Local",
): Promise<void> {
  await nav(page).getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  const toggle = zoneToggle(page, mode === "UTC" ? "UTC" : /^Local/);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
}

/** The turbines table filtered to TURBINE: its row, link and Last reading column header. */
async function openTurbines(page: Page) {
  await nav(page).getByRole("link", { name: "Turbines" }).click();
  await expect(page).toHaveURL(/\/turbines$/);
  await page.getByRole("searchbox", { name: "Turbine or farm" }).fill(TURBINE);
  const row = page.getByRole("row").filter({ hasText: TURBINE });
  await expect(row).toHaveCount(1);
  return {
    header: page.getByTestId("sort-time"),
    row,
    link: row.getByRole("link", { name: TURBINE, exact: true }),
  };
}

test.describe("Settings: time zone (browser in America/Chicago)", () => {
  test("shows UTC everywhere by default", async ({ page }) => {
    const latest = await open(page);

    await nav(page).getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveTitle("Settings · Nextera");
    await expect(zoneToggle(page, "UTC")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(zoneToggle(page, /^Local/)).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(zoneToggle(page, /^Local/)).toHaveText(
      "Local (America/Chicago, UTC−6)",
    );
    await expect(page.getByTestId("time-zone-now")).toHaveText(
      "Jan 3, 00:00 UTC",
    );
    await expect(page.getByTestId("time-zone-note")).toHaveText(
      "Saved in this browser.",
    );

    const { header, row, link } = await openTurbines(page);
    await expect(header).toHaveText("Last reading (UTC)");
    await expect(row).toContainText(shown(latest, "UTC"));

    await link.click();
    await expect(page).toHaveURL(new RegExp(`/turbines/${TURBINE}$`));
    await expect(page.getByTestId("window-end")).toHaveText(
      "Ending now (00:00 UTC)",
    );
    await expect(page.getByTestId("status")).toContainText(
      `Latest reading ${shown(latest, "UTC", true)}`,
    );

    const alerts = page.waitForRequest(/\/api\/alerts\?/);
    await nav(page).getByRole("link", { name: "Alerting" }).click();
    const query = new URL((await alerts).url()).searchParams;
    expect([query.get("from"), query.get("to")]).toEqual([
      "2026-01-02T00:00:00.000Z",
      "2026-01-04T00:00:00.000Z",
    ]);
    await expect(page.getByTestId("history-range")).toContainText(
      "Dates (UTC)",
    );
  });

  test("choosing Local shows times in Chicago time, 6 hours earlier, with the zone name", async ({
    page,
  }) => {
    const latest = await open(page);
    await chooseOnSettings(page, "Local");
    await expect(page.getByTestId("time-zone-now")).toHaveText(
      "Jan 2, 18:00 CST",
    );

    // Every page follows at once (no reload).
    const { header, row, link } = await openTurbines(page);
    await expect(header).toHaveText("Last reading (local)");
    await expect(row).toContainText(shown(latest, ZONE));

    await link.click();
    await expect(page).toHaveURL(new RegExp(`/turbines/${TURBINE}$`));
    await expect(page.getByTestId("window-end")).toHaveText(
      "Ending now (18:00 CST)",
    );
    await expect(page.getByTestId("status")).toContainText(
      `Latest reading ${shown(latest, ZONE, true)}`,
    );
  });

  test("History's default days are yesterday and today in Chicago (local midnights)", async ({
    page,
  }) => {
    await open(page);
    await chooseOnSettings(page, "Local");

    const alerts = page.waitForRequest(/\/api\/alerts\?/);
    await nav(page).getByRole("link", { name: "Alerting" }).click();
    await expect(page).toHaveURL(/\/alerting\/history$/);
    const query = new URL((await alerts).url()).searchParams;
    // Jan 2, 18:00 CST: yesterday = Jan 1, today = Jan 2, each from 00:00 CST (06:00Z).
    expect([query.get("from"), query.get("to")]).toEqual([
      "2026-01-01T06:00:00.000Z",
      "2026-01-03T06:00:00.000Z",
    ]);
    await expect(page.getByTestId("history-range")).toContainText(
      "Dates (local)",
    );
    await expect(page.getByTestId("history-from")).toHaveValue("1/1/2026");
    await expect(page.getByTestId("history-to")).toHaveValue("1/2/2026");
  });

  test("Reporting runs whole local days and lists fixture readings in Chicago time", async ({
    page,
  }) => {
    await open(page, "owner");
    await chooseOnSettings(page, "Local");
    await nav(page).getByRole("link", { name: "Reporting" }).click();
    await expect(page.getByTestId("report-range")).toContainText(
      "Dates (local)",
    );

    await page.getByLabel("Farm or turbine").fill(TURBINE);
    await page.getByRole("option", { name: new RegExp(`^${TURBINE}`) }).click();
    // Typed like a user, read by the native DateAdapter (en-US) as Chicago calendar days.
    await page.getByRole("textbox", { name: "Start date" }).fill("1/1/2026");
    await page.getByRole("textbox", { name: "End date" }).fill("1/2/2026");
    const report = page.waitForRequest(/\/api\/reports\/telemetry\?/);
    await page.getByRole("button", { name: "Run report" }).click();
    const query = new URL((await report).url()).searchParams;
    expect([query.get("from"), query.get("to")]).toEqual([
      "2026-01-01T06:00:00.000Z",
      "2026-01-03T06:00:00.000Z",
    ]);

    await expect(page.getByTestId("report-status")).toHaveText(
      `${TURBINE} · Prairie Ridge, Jan 1, 2026 – Jan 2, 2026 (local)`,
    );
    const table = page.getByTestId("report-table");
    await expect(table.getByRole("columnheader").first()).toHaveText(
      "Measured (local)",
    );
    // The fixture's 2026-01-01T06:00Z reading: the first of the local day Jan 1.
    await expect(
      table.getByRole("row").nth(1).getByRole("cell").first(),
    ).toHaveText("Jan 1, 00:00");
  });

  test("Local survives a reload, is per user, and switching back restores UTC", async ({
    page,
  }) => {
    await open(page, "admin");
    await chooseOnSettings(page, "Local");
    expect(
      await page.evaluate(
        (key) => localStorage.getItem(key),
        `nextera.timeZone.${userEmail("admin")}`,
      ),
    ).toBe("local");

    // A reload (a new app instance) restores the admin's choice.
    const reloaded = farmsResponse(page);
    await page.reload();
    const latestAfterReload = await latestFrom(reloaded);
    await expect(zoneToggle(page, /^Local/)).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByTestId("time-zone-now")).toHaveText(
      "Jan 2, 18:00 CST",
    );
    let turbines = await openTurbines(page);
    await expect(turbines.row).toContainText(shown(latestAfterReload, ZONE));

    // Another user on this browser keeps their own setting (UTC: never chosen).
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    const viewerFarms = farmsResponse(page);
    await logIn(page, "viewer");
    const viewerLatest = await latestFrom(viewerFarms);
    turbines = await openTurbines(page);
    await expect(turbines.header).toHaveText("Last reading (UTC)");
    await expect(turbines.row).toContainText(shown(viewerLatest, "UTC"));
    await nav(page).getByRole("link", { name: "Settings" }).click();
    await expect(zoneToggle(page, "UTC")).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // The admin again: still Local; switching back to UTC restores the UTC text.
    await page.getByRole("button", { name: "Sign out" }).click();
    const adminFarms = farmsResponse(page);
    await logIn(page, "admin");
    const adminLatest = await latestFrom(adminFarms);
    turbines = await openTurbines(page);
    await expect(turbines.header).toHaveText("Last reading (local)");
    await chooseOnSettings(page, "UTC");
    await expect(page.getByTestId("time-zone-now")).toHaveText(
      "Jan 3, 00:00 UTC",
    );
    turbines = await openTurbines(page);
    await expect(turbines.header).toHaveText("Last reading (UTC)");
    await expect(turbines.row).toContainText(shown(adminLatest, "UTC"));
  });
});
