import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import {
  fetchTurbinePage,
  mainNav,
  pageToken,
  turbinesOf,
  turbinesResponse,
  farmsResponse,
  type FleetFarm,
  type FleetTurbine,
} from "../support/fleet.js";
import {
  mockReading,
  mockTurbine,
  mockTurbines,
  type MockTurbine,
} from "../support/mock-turbines.js";
import { SEED_NOW, logIn } from "../support/session.js";

// Plan 4: /turbines — filters (text, status, commissioning), sorting and paging, served page by
// page by GET /api/turbines. Filtering and sorting run on the real API: the expectation is the
// API's own answer to the query the page should have sent (fetchTurbinePage), plus the fleet read
// through the API for the sort orders. With a status filter the page sends `asOf` (the browser's
// fixed clock), so the server judges "reporting" like the pill: the status filter is checked
// against both the API's answer and the pills of the rows shown. Paging
// needs more than 25 turbines, which the fixture doesn't have, and the fixture has no never-reported
// turbine, so those tests serve a generated fleet (mockTurbines, which answers like the API). The
// paginator has next and previous only. Read-only; live stream aborted.

type Staleness =
  | "Reporting"
  | "No data in 15 min"
  | "No data in 30 min"
  | "No data in 60 min"
  | "No readings yet";

/** The status pill at the fixed browser clock (staleness.ts: strictly more than 15/30/60 min). */
function status(t: FleetTurbine): Staleness {
  if (!t.latest) return "No readings yet";
  const age = SEED_NOW.getTime() - Date.parse(t.latest.timestamp);
  return age > 3_600_000
    ? "No data in 60 min"
    : age > 1_800_000
      ? "No data in 30 min"
      : age > 900_000
        ? "No data in 15 min"
        : "Reporting";
}

async function openTurbines(
  page: Page,
  stream: (route: Route) => Promise<void> = (route) => route.abort(),
): Promise<(FleetTurbine & { farm: FleetFarm })[]> {
  await page.clock.setFixedTime(SEED_NOW);
  await page.route("**/api/events**", stream);
  const farms = farmsResponse(page);
  await logIn(page, "viewer");
  const turbines = turbinesOf(await farms);
  await mainNav(page).getByRole("link", { name: "Turbines" }).click();
  await expect(page).toHaveURL(/\/turbines$/);
  return turbines;
}

const rows = (page: Page) =>
  page.getByTestId("turbines").locator("tr[data-turbine-id]");
const shownIds = (page: Page) =>
  rows(page).evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-turbine-id")!),
  );
const count = (page: Page) => page.getByTestId("turbine-count");
const search = (page: Page) =>
  page.getByRole("searchbox", { name: "Turbine or farm" });
const byId = (a: string, b: string) => a.localeCompare(b);
const hideNoData = (page: Page) =>
  page.getByRole("switch", { name: "Hide turbines with no data" });
const paginator = (page: Page) => page.getByTestId("turbines-paginator");

/** The table's order for Last reading: `dir` by time, ties by id (never-reported ones hidden). */
const byTime = (turbines: FleetTurbine[], dir: "asc" | "desc") =>
  turbines
    .filter((t) => t.latest)
    .sort((a, b) => {
      const order = a.latest!.timestamp.localeCompare(b.latest!.timestamp);
      return (dir === "asc" ? order : -order) || byId(a.id, b.id);
    })
    .map((t) => t.id);

/** The count line: the rows on the page of the `total` matches ("25 of 60 turbines"). */
function countText(total: number, onPage = Math.min(total, 25)): string {
  return `${onPage} of ${total.toLocaleString("en-US")} turbines`;
}

/** The message of an empty table while the switch hides turbines that never reported. */
const NO_MATCHES_HIDING =
  "No turbines match the filters. Turbines with no readings yet are hidden: turn off “Hide turbines with no data” to show them.";
const NO_MATCHES = "No turbines match the filters.";

// Never-reported ids on both sides of the others, so "last" can't come from the id order. R01 and
// R02 tie on time, and their power runs against the time order.
const STALE = [
  ["R03", "No data in 15 min", 20],
  ["R04", "No data in 30 min", 45],
  ["R05", "No data in 60 min", 120],
] as const;
/** A fresh copy each time: tests change a turbine's reading to change what the "server" answers. */
const mixedFleet = (): MockTurbine[] => [
  mockTurbine("A01", "FARM01", null),
  mockTurbine("Z01", "FARM01", null),
  mockTurbine("R02", "FARM01", 5, { power: 200 }),
  mockTurbine("R01", "FARM01", 5, { power: 100 }),
  mockTurbine("R06", "FARM01", 1, { power: 300 }),
  ...STALE.map(([id, , age], i) =>
    mockTurbine(id, "FARM01", age, { power: 400 + i }),
  ),
];
const REPORTED_NEWEST_FIRST = ["R06", "R01", "R02", "R03", "R04", "R05"];
const MIXED_COUNT = "6 of 6 turbines";
const AGE: Record<string, number> = {
  R06: 1,
  R01: 5,
  R02: 5,
  R03: 20,
  R04: 45,
  R05: 120,
};
const oldestFirst = (a: string, b: string) => AGE[b] - AGE[a] || byId(a, b);

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.documentElement;
        return {
          viewport: window.innerWidth,
          overflow:
            Math.max(root.scrollWidth, document.body.scrollWidth) -
            root.clientWidth,
        };
      }),
    )
    .toEqual({ viewport: 360, overflow: 0 });
}

/** Inside the 360px viewport, so overflow hidden by the page's clipping fails too. */
async function expectWithinPhoneWidth(
  page: Page,
  element: Locator,
): Promise<void> {
  await expect(element).toBeVisible();
  const box = (await element.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
}

test.describe("Turbines table", () => {
  test("lists turbines newest reading first with their columns and the match count", async ({
    page,
  }) => {
    const turbines = await openTurbines(page);
    const reported = turbines.filter((t) => t.latest);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Turbines",
    );
    await expect(
      page.getByTestId("turbines").getByRole("columnheader"),
    ).toHaveText([
      "Turbine",
      "Farm",
      "Status",
      "Commissioned",
      /^Power \(kW\)/,
      /^Wind \(m\/s\)/,
      /^Gearbox \(°C\)/,
      "Last reading (UTC)",
    ]);
    await expect(count(page)).toHaveText(countText(reported.length));
    await expect(page.getByTestId("sort-time")).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    await expect
      .poll(() => shownIds(page))
      .toEqual(byTime(turbines, "desc").slice(0, 25));

    await search(page).fill("TURB001");
    const turb001 = page.locator('tr[data-turbine-id="TURB001"]');
    const t1 = turbines.find((t) => t.id === "TURB001")!;
    await expect(turb001.getByRole("cell").nth(1)).toHaveText(
      "Prairie Ridge FARM01",
    );
    await expect(turb001.getByRole("cell").nth(2)).toHaveText(status(t1));
    await expect(turb001.getByTestId("commissioned-icon")).toHaveAttribute(
      "data-icon",
      t1.commissioned ? "check" : "x",
    );
  });

  test("the text filter is sent to the server after the typing pauses, and matches ids and farm names, case-insensitively; Clear resets it", async ({
    page,
  }) => {
    const turbines = await openTurbines(page);
    const matches = (text: string) =>
      turbines.filter(
        (t) =>
          !!t.latest &&
          [t.id, t.farm.id, t.farm.name].some((s) =>
            s.toLowerCase().includes(text.toLowerCase()),
          ),
      );

    const sent = turbinesResponse(page, (p) => p.get("q") === "turb002");
    await search(page).fill("turb002");
    expect((await sent).status()).toBe(200);
    await expect.poll(() => shownIds(page)).toEqual(["TURB002"]);
    await expect(count(page)).toHaveText(countText(1));

    await search(page).fill("prairie");
    const prairie = matches("prairie");
    await expect(count(page)).toHaveText(countText(prairie.length));
    await expect(rows(page)).toHaveCount(Math.min(prairie.length, 25));
    for (const farm of await rows(page)
      .getByRole("cell")
      .nth(1)
      .allTextContents())
      expect(farm).toContain("Prairie Ridge");

    await search(page).fill("zzzz");
    await expect(page.getByTestId("no-matches")).toHaveText(NO_MATCHES_HIDING);
    await expect(count(page)).toHaveText("0 of 0 turbines");

    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(search(page)).toHaveValue("");
    await expect(search(page)).toBeFocused();
    await expect(count(page)).toHaveText(
      countText(turbines.filter((t) => t.latest).length),
    );
    await expect(
      page.getByRole("button", { name: "Clear search" }),
    ).toHaveCount(0);
  });

  test("the rows under each status filter have matching pills, and the request carries asOf", async ({
    page,
    request,
  }) => {
    await openTurbines(page);
    const token = await pageToken(page);
    const statusFilter = page.getByTestId("status-filter");
    await expect(statusFilter.locator("option")).toHaveText([
      "All statuses",
      "Reporting",
      "No recent data",
      "No readings yet",
    ]);
    for (const [label, value, pill] of [
      ["Reporting", "reporting", /^Reporting$/],
      ["No recent data", "stale", /^No data in (15|30|60) min$/],
      ["No readings yet", "no_data", /^No readings yet$/],
    ] as const) {
      const sent = turbinesResponse(page, (p) => p.get("status") === value);
      await statusFilter.selectOption({ label });
      // The server judges at the browser's (fixed) clock, as the pill does.
      const asOf = new URL((await sent).url()).searchParams.get("asOf");
      expect(asOf).toBe(SEED_NOW.toISOString());
      // "No readings yet" lists the never-reported ones, so the switch must not hide them.
      const expected = await fetchTurbinePage(request, token, {
        status: value,
        asOf: SEED_NOW.toISOString(),
        sort: "time",
        dir: "desc",
        limit: 25,
        ...(value === "no_data" ? {} : { hasData: true }),
      });
      await expect(count(page)).toHaveText(
        countText(expected.total, expected.items.length),
      );
      if (expected.items.length) {
        await expect
          .poll(() => shownIds(page))
          .toEqual(expected.items.map((t) => t.id));
        for (const pillText of await rows(page)
          .getByTestId("staleness")
          .allTextContents()) {
          expect(pillText.trim()).toMatch(pill);
        }
      } else {
        await expect(page.getByTestId("no-matches")).toBeVisible();
      }
    }
    await statusFilter.selectOption({ label: "All statuses" });
    await expect(statusFilter).toHaveValue("all");
  });

  test("the commissioning filter shows only check marks or only crosses, and ANDs with the text", async ({
    page,
    request,
  }) => {
    const turbines = await openTurbines(page);
    const token = await pageToken(page);
    const filter = page.getByTestId("commissioned-filter");
    for (const [label, commissioned, icon] of [
      ["Not commissioned", false, "x"],
      ["Commissioned", true, "check"],
    ] as const) {
      const sent = turbinesResponse(
        page,
        (p) => p.get("commissioned") === String(commissioned),
      );
      await filter.selectOption({ label });
      await sent;
      const expected = await fetchTurbinePage(request, token, {
        commissioned,
        hasData: true,
        sort: "time",
        dir: "desc",
        limit: 25,
      });
      await expect(count(page)).toHaveText(
        countText(expected.total, expected.items.length),
      );
      const icons = await rows(page)
        .getByTestId("commissioned-icon")
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-icon")));
      expect(new Set(icons)).toEqual(
        new Set(expected.items.length ? [icon] : []),
      );
    }

    await filter.selectOption({ label: "Not commissioned" });
    await search(page).fill("TURB001");
    const both = turbines.filter(
      (t) =>
        !!t.latest && !t.commissioned && t.id.toLowerCase().includes("turb001"),
    );
    await expect(count(page)).toHaveText(countText(both.length));
    await filter.selectOption({ label: "Any" });
    await expect(count(page)).toHaveText(
      countText(
        turbines.filter(
          (t) => !!t.latest && t.id.toLowerCase().includes("turb001"),
        ).length,
      ),
    );
  });

  test("a column header sorts ascending first; clicking again reverses", async ({
    page,
  }) => {
    const turbines = await openTurbines(page);
    const withReadings = turbines.filter((t) => t.latest);
    const ids = withReadings.map((t) => t.id).sort(byId);

    await page.getByTestId("sort-id").click();
    await expect(page.getByTestId("sort-id")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await expect.poll(() => shownIds(page)).toEqual(ids.slice(0, 25));

    await page.getByTestId("sort-id").click();
    await expect(page.getByTestId("sort-id")).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    await expect.poll(() => shownIds(page)).toEqual(ids.reverse().slice(0, 25));

    await page.getByTestId("sort-farm").click();
    await expect(page.getByTestId("sort-farm")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await expect
      .poll(async () => {
        const farmOrder = await rows(page).evaluateAll((els) =>
          els.map((e) =>
            e.querySelectorAll("td")[1].querySelector("a")!.textContent!.trim(),
          ),
        );
        return (
          JSON.stringify(farmOrder) ===
          JSON.stringify([...farmOrder].sort(byId))
        );
      })
      .toBe(true);

    await page.getByTestId("sort-commissioned").click();
    await expect(page.getByTestId("sort-commissioned")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await page.getByTestId("sort-commissioned").click();
    await expect(page.getByTestId("sort-commissioned")).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  });

  test("power, wind and gearbox cannot be sorted across the fleet: disabled, with the reason", async ({
    page,
  }) => {
    await openTurbines(page);
    const requests: string[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.endsWith("/api/turbines"))
        requests.push(r.url());
    });

    for (const key of ["power", "wind", "gearbox"]) {
      const header = page.getByTestId(`sort-${key}`);
      await expect(header).toHaveAttribute(
        "title",
        "Open a farm to sort by this value",
      );
      await expect(header).toContainText(
        "sorting is not available across the whole fleet; open a farm",
      );
      await header.click({ force: true });
    }
    await expect(page.getByTestId("metric-sort-hint")).toHaveText(
      "Power, wind and gearbox can be sorted on a farm's page. Here the list sorts by turbine, farm, commissioning or last reading.",
    );
    await expect(page.getByTestId("sort-time")).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    expect(requests).toEqual([]);
  });

  test("a farm page sorts by power, and has no hint", async ({
    page,
    request,
  }) => {
    await openTurbines(page);
    const token = await pageToken(page);
    await page.goto("/farms/FARM01");
    await expect(page.getByTestId("metric-sort-hint")).toHaveCount(0);
    const header = page.getByTestId("sort-power");
    await expect(header).not.toHaveAttribute("title", /.+/);

    const sent = turbinesResponse(
      page,
      (p) =>
        p.get("sort") === "power" &&
        p.get("dir") === "desc" &&
        p.get("farmId") === "FARM01",
    );
    await header.click();
    await header.click();
    await sent;
    await expect(header).toHaveAttribute("aria-sort", "descending");
    const expected = await fetchTurbinePage(request, token, {
      farmId: "FARM01",
      sort: "power",
      dir: "desc",
      hasData: true,
      limit: 25,
    });
    await expect
      .poll(() => shownIds(page))
      .toEqual(expected.items.map((t) => t.id));
  });

  test("the first click on Last reading, the default sort, gives oldest first", async ({
    page,
  }) => {
    const turbines = await openTurbines(page);
    const lastReading = page.getByTestId("sort-time");
    await expect(lastReading).toHaveAttribute("aria-sort", "descending");

    await lastReading.click();
    await expect(lastReading).toHaveAttribute("aria-sort", "ascending");
    await expect
      .poll(() => shownIds(page))
      .toEqual(byTime(turbines, "asc").slice(0, 25));

    await lastReading.click();
    await expect(lastReading).toHaveAttribute("aria-sort", "descending");
    await expect
      .poll(() => shownIds(page))
      .toEqual(byTime(turbines, "desc").slice(0, 25));
  });

  test("ties on the last reading sort by id, in both directions", async ({
    page,
  }) => {
    await mockTurbines(page, mixedFleet());
    await openTurbines(page);
    await expect.poll(() => shownIds(page)).toEqual(REPORTED_NEWEST_FIRST);

    await page.getByTestId("sort-time").click();
    await expect
      .poll(() => shownIds(page))
      .toEqual(["R05", "R04", "R03", "R01", "R02", "R06"]);
  });

  test("a turbine link opens its page", async ({ page }) => {
    await openTurbines(page);
    await search(page).fill("TURB002");
    await page
      .locator('tr[data-turbine-id="TURB002"]')
      .getByRole("link", { name: "TURB002" })
      .click();
    await expect(page).toHaveURL(/\/farms\/FARM02\/turbines\/TURB002$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "TURB002",
    );
  });

  test("pages through 60 turbines with next and previous only; filters return to the first page", async ({
    page,
  }) => {
    // A generated fleet: the fixture has 2 turbines (paging needs more than 25). One timestamp for
    // all, so the default sort falls back to the id order the assertions read.
    const generated = Array.from({ length: 60 }, (_, i) =>
      mockTurbine(`GEN${String(i + 1).padStart(3, "0")}`, "FARM01", 5, {
        power: 1000 + i,
        commissioned: i % 2 === 0,
      }),
    );
    const { requests } = await mockTurbines(page, generated);
    await openTurbines(page);
    const pages = paginator(page);
    await expect(pages).toContainText("1 – 25 of 60");
    await expect(count(page)).toHaveText("25 of 60 turbines");
    await expect(
      pages.getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
    await expect(rows(page).first()).toHaveAttribute(
      "data-turbine-id",
      "GEN001",
    );
    // No jump to a page, no page size: next and previous are all there is.
    await expect(pages.getByRole("button", { name: "First page" })).toHaveCount(
      0,
    );
    await expect(pages.getByRole("button", { name: "Last page" })).toHaveCount(
      0,
    );
    await expect(pages.getByRole("combobox")).toHaveCount(0);

    await pages.getByRole("button", { name: "Next page" }).click();
    await expect(pages).toContainText("26 – 50 of 60");
    await expect(rows(page).first()).toHaveAttribute(
      "data-turbine-id",
      "GEN026",
    );
    expect(requests.at(-1)!.get("cursor")).toBe("25");
    await expect(
      pages.getByRole("button", { name: "Previous page" }),
    ).toBeEnabled();

    await pages.getByRole("button", { name: "Next page" }).click();
    await expect(pages).toContainText("51 – 60 of 60");
    await expect(rows(page)).toHaveCount(10);
    await expect(
      pages.getByRole("button", { name: "Next page" }),
    ).toBeDisabled();

    await pages.getByRole("button", { name: "Previous page" }).click();
    await expect(pages).toContainText("26 – 50 of 60");
    await expect(rows(page).first()).toHaveAttribute(
      "data-turbine-id",
      "GEN026",
    );

    await page
      .getByTestId("commissioned-filter")
      .selectOption({ label: "Commissioned" });
    await expect(pages).toContainText("1 – 25 of 30");
    await expect(rows(page).first()).toHaveAttribute(
      "data-turbine-id",
      "GEN001",
    );
    expect(requests.at(-1)!.has("cursor")).toBe(false);
  });

  test('a total past the server cap reads "10,000+"', async ({ page }) => {
    const generated = Array.from({ length: 30 }, (_, i) =>
      mockTurbine(`GEN${String(i + 1).padStart(3, "0")}`, "FARM01", 5),
    );
    await mockTurbines(page, generated, { capTotalAt: 10_000 });
    await openTurbines(page);

    await expect(count(page)).toHaveText("25 of 10,000+ turbines");
    await expect(paginator(page)).toContainText("1 – 25 of 10,000+");
  });

  test("shows loading, then an error with Retry when the page cannot be loaded", async ({
    page,
  }) => {
    let fail = true;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => url.pathname.endsWith("/api/turbines"),
      async (route) => {
        await held;
        if (fail)
          await route.fulfill({ status: 503, body: "Service Unavailable" });
        else await route.fallback();
      },
    );
    await page.clock.setFixedTime(SEED_NOW);
    await page.route("**/api/events**", (route) => route.abort());
    await logIn(page, "viewer");
    await mainNav(page).getByRole("link", { name: "Turbines" }).click();

    await expect(count(page)).toHaveText("Loading turbines…");
    await expect(page.getByTestId("turbines-loading")).toBeVisible();
    release();
    await expect(page.getByTestId("turbines-error")).toContainText(
      "The turbines could not be loaded.",
    );
    await expect(count(page)).toHaveText("Turbines unavailable");

    fail = false;
    await page.getByTestId("turbines-retry").click();
    await expect(page.getByTestId("turbines-error")).toHaveCount(0);
    await expect(rows(page).first()).toBeVisible();
  });
});

test.describe("Commissioned cell by role", () => {
  // Reads only: the switch itself is in tests/data/commissioned.spec.ts.
  test("a viewer sees the icon and its words, and no switch", async ({
    page,
  }) => {
    await openTurbines(page);
    await search(page).fill("TURB001");
    const row = page.locator('tr[data-turbine-id="TURB001"]');
    await expect(row.getByTestId("commissioned-icon")).toBeVisible();
    await expect(row.getByTestId("commissioned-cell")).toHaveText(
      /^\s*(Not commissioned|Commissioned)\s*$/,
    );
    await expect(page.getByTestId("commissioned-toggle")).toHaveCount(0);
    await expect(
      page.getByRole("switch", { name: /^Mark .* as commissioned$/ }),
    ).toHaveCount(0);
  });

  for (const role of ["owner", "admin"] as const) {
    test(`an ${role} gets a switch in the cell on /turbines and the farm page, not the icon or its words`, async ({
      page,
    }) => {
      await page.clock.setFixedTime(SEED_NOW);
      await page.route("**/api/events**", (route) => route.abort());
      await logIn(page, role);
      await mainNav(page).getByRole("link", { name: "Turbines" }).click();
      await search(page).fill("TURB001");
      const row = page.locator('tr[data-turbine-id="TURB001"]');
      await expect(
        row.getByRole("switch", { name: "Mark TURB001 as commissioned" }),
      ).toBeVisible();
      await expect(row.getByTestId("commissioned-toggle")).toBeVisible();
      await expect(row.getByTestId("commissioned-icon")).toHaveCount(0);
      await expect(row.getByTestId("commissioned-cell")).not.toContainText(
        "ommissioned",
      );

      await row.getByRole("link", { name: "Prairie Ridge" }).click();
      await expect(page).toHaveURL(/\/farms\/FARM01$/);
      await expect(
        page.getByRole("switch", { name: "Mark TURB001 as commissioned" }),
      ).toBeVisible();
    });
  }
});

test.describe("Hide turbines with no data", () => {
  test("is on by default: never-reported turbines are hidden and the server is told so", async ({
    page,
  }) => {
    const { requests } = await mockTurbines(page, mixedFleet());
    await openTurbines(page);

    await expect(hideNoData(page)).toBeChecked();
    await expect(hideNoData(page)).toBeEnabled();
    await expect(page.getByTestId("hide-no-data")).toBeVisible();
    await expect(count(page)).toHaveText(MIXED_COUNT);
    await expect.poll(() => shownIds(page)).toEqual(REPORTED_NEWEST_FIRST);
    expect(requests.at(-1)!.get("hasData")).toBe("true");
  });

  test("turbines that have gone stale stay visible while it is on", async ({
    page,
  }) => {
    await mockTurbines(page, mixedFleet());
    await openTurbines(page);

    await expect(hideNoData(page)).toBeChecked();
    for (const [id, label] of STALE) {
      await expect(
        page.locator(`tr[data-turbine-id="${id}"]`).getByTestId("staleness"),
      ).toHaveText(label);
    }
  });

  test("turned off, it lists them last whichever way the table is sorted", async ({
    page,
  }) => {
    const { requests } = await mockTurbines(page, mixedFleet());
    await openTurbines(page);
    const neverReported = ["A01", "Z01"];

    await hideNoData(page).click();
    await expect(hideNoData(page)).not.toBeChecked();
    await expect(count(page)).toHaveText("8 of 8 turbines");
    expect(requests.at(-1)!.has("hasData")).toBe(false);
    await expect(page.getByTestId("sort-time")).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    await expect
      .poll(() => shownIds(page))
      .toEqual([...REPORTED_NEWEST_FIRST, ...neverReported]);
    await expect(
      page.locator('tr[data-turbine-id="A01"]').getByTestId("staleness"),
    ).toHaveText("No readings yet");

    await page.getByTestId("sort-time").click();
    await expect(page.getByTestId("sort-time")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await expect
      .poll(() => shownIds(page))
      .toEqual([
        ...[...REPORTED_NEWEST_FIRST].sort(oldestFirst),
        ...neverReported,
      ]);

    // Power can be sorted on a farm's page only: all eight are in FARM01.
    await page.goto("/farms/FARM01");
    await hideNoData(page).click();
    await expect(count(page)).toHaveText("8 of 8 turbines");
    await page.getByTestId("sort-power").click();
    await expect(page.getByTestId("sort-power")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    const byPower = ["R01", "R02", "R06", "R03", "R04", "R05"];
    await expect
      .poll(() => shownIds(page))
      .toEqual([...byPower, ...neverReported]);

    await page.getByTestId("sort-power").click();
    await expect(page.getByTestId("sort-power")).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    await expect
      .poll(() => shownIds(page))
      .toEqual([...byPower.reverse(), ...neverReported]);

    await hideNoData(page).click();
    await expect(hideNoData(page)).toBeChecked();
    await expect(count(page)).toHaveText(MIXED_COUNT);
    await expect(rows(page)).toHaveCount(6);
  });

  test("is not saved: a reload turns it back on", async ({ page }) => {
    await mockTurbines(page, mixedFleet());
    await openTurbines(page);
    await hideNoData(page).click();
    await expect(hideNoData(page)).not.toBeChecked();

    await page.reload();
    await expect(hideNoData(page)).toBeChecked();
    await expect(count(page)).toHaveText(MIXED_COUNT);
  });

  test('status "No readings yet" shows them with the switch off and disabled; another status restores it', async ({
    page,
  }) => {
    await mockTurbines(page, mixedFleet());
    await openTurbines(page);
    const statusFilter = page.getByTestId("status-filter");

    await statusFilter.selectOption({ label: "No readings yet" });
    await expect(hideNoData(page)).not.toBeChecked();
    await expect(hideNoData(page)).toBeDisabled();
    await expect(count(page)).toHaveText("2 of 2 turbines");
    await expect.poll(() => shownIds(page)).toEqual(["A01", "Z01"]);

    await statusFilter.selectOption({ label: "All statuses" });
    await expect(hideNoData(page)).toBeChecked();
    await expect(hideNoData(page)).toBeEnabled();
    await expect(count(page)).toHaveText(MIXED_COUNT);
    await expect(rows(page)).toHaveCount(6);

    // The user's own setting comes back too, not just the default.
    await hideNoData(page).click();
    await statusFilter.selectOption({ label: "No readings yet" });
    await expect(hideNoData(page)).toBeDisabled();
    await statusFilter.selectOption({ label: "Reporting" });
    await expect(hideNoData(page)).not.toBeChecked();
    await expect(hideNoData(page)).toBeEnabled();
    await expect.poll(() => shownIds(page)).toEqual(["R06", "R01", "R02"]);
  });

  test("the message says when only the switch hides the match, and not otherwise", async ({
    page,
  }) => {
    await mockTurbines(page, mixedFleet());
    await openTurbines(page);

    await search(page).fill("Z01");
    await expect(page.getByTestId("no-matches")).toHaveText(NO_MATCHES_HIDING);
    await expect(count(page)).toHaveText("0 of 0 turbines");

    await hideNoData(page).click();
    await expect.poll(() => shownIds(page)).toEqual(["Z01"]);
    await search(page).fill("zzzz");
    await expect(page.getByTestId("no-matches")).toHaveText(NO_MATCHES);
    await expect(count(page)).toHaveText("0 of 0 turbines");
  });

  test("a farm where no turbine has reported explains the empty table, and the switch reveals them", async ({
    page,
  }) => {
    await mockTurbines(page, [
      mockTurbine("N01", "FARM02", null),
      mockTurbine("N02", "FARM02", null),
      mockTurbine("R01", "FARM01", 5),
    ]);
    await page.clock.setFixedTime(SEED_NOW);
    await page.route("**/api/events**", (route) => route.abort());
    await logIn(page, "viewer");
    await page.goto("/farms/FARM02");

    const noMatches = page.getByTestId("no-matches");
    await expect(noMatches).toHaveText(NO_MATCHES_HIDING);
    await expect(count(page)).toHaveText("0 of 0 turbines");
    await expect(rows(page)).toHaveCount(0);

    await hideNoData(page).click();
    await expect(noMatches).toHaveCount(0);
    await expect(count(page)).toHaveText("2 of 2 turbines");
    await expect.poll(() => shownIds(page)).toEqual(["N01", "N02"]);
  });

  test("a hidden turbine appears once the page is fetched again (the stream reopens), not on a live reading", async ({
    page,
  }) => {
    const fleet = mixedFleet();
    const { requests } = await mockTurbines(page, fleet);
    // A fulfilled stream ends, so the browser reconnects by itself (retry: 500 ms) and each open
    // fetches the page again. Its event for A01 is not on the page, so it is dropped.
    const reading = mockReading("A01", "FARM01", 0, 1234);
    await openTurbines(page, (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: `retry: 500\n\nevent: telemetry.received\nid: 1-0\ndata: ${JSON.stringify(reading)}\n\n`,
      }),
    );
    const a01 = page.locator('tr[data-turbine-id="A01"]');
    await expect(count(page)).toHaveText(MIXED_COUNT);
    await expect(a01).toHaveCount(0);
    const before = requests.length;

    // The server now has A01's reading; the next fetch (the next open) shows it.
    fleet.find((t) => t.id === "A01")!.latest = reading;

    await expect(rows(page).first()).toHaveAttribute("data-turbine-id", "A01", {
      timeout: 15_000,
    });
    await expect(a01.getByTestId("staleness")).toHaveText("Reporting");
    await expect(count(page)).toHaveText("7 of 7 turbines");
    expect(requests.length).toBeGreaterThan(before);
  });

  test("at 360px the filter row stays on screen and the page does not scroll sideways", async ({
    page,
  }) => {
    await mockTurbines(page, mixedFleet());
    await openTurbines(page);
    await page.setViewportSize({ width: 360, height: 740 });

    await expect(count(page)).toHaveText(MIXED_COUNT);
    const onScreen = [
      search(page),
      page.getByTestId("status-filter"),
      page.getByTestId("commissioned-filter"),
      hideNoData(page),
      count(page),
    ];
    for (const element of onScreen) await expectWithinPhoneWidth(page, element);
    await expectNoSidewaysScroll(page);

    // The longest message, which has to wrap.
    await search(page).fill("A01");
    const message = page.getByTestId("no-matches").locator("div");
    await expect(message).toContainText(
      "Turbines with no readings yet are hidden",
    );
    await expectWithinPhoneWidth(page, message);
    await expectNoSidewaysScroll(page);
  });
});
