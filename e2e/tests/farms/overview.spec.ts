import { expect, test, type Page } from "@playwright/test";
import {
  farmsResponse,
  waitForSummaries,
  type FarmSummary,
  type FleetFarm,
  type FleetSummary,
} from "../support/fleet.js";
import { SEED_NOW, logIn } from "../support/session.js";

// Plan 3.1–3.4: the fleet overview (tiles, Leaflet map, farm table) and a farm page, against
// the real GET /api/farms (expectations derived from the response the page rendered: the
// fixture in CI; demo data and earlier runs' turbines locally). Read-only; live stream aborted.

// The tiles and the farm table show the server's summaries (rebuilt about once a minute, judged on
// the server's clock), so they are checked against the summary responses the page rendered.

async function openOverview(
  page: Page,
): Promise<FleetFarm[] & { fleet: FleetSummary; summaries: FarmSummary[] }> {
  await page.clock.setFixedTime(SEED_NOW);
  await page.route("**/api/events**", (route) => route.abort());
  const summaries = waitForSummaries(page);
  const farms = farmsResponse(page);
  await logIn(page, "viewer");
  const { fleet, farms: list } = await summaries;
  return Object.assign(await farms, { fleet, summaries: list });
}

test.describe("Fleet overview", () => {
  test("tiles and the farm table show the summaries, with an As of time and a refresh note", async ({
    page,
  }) => {
    const farms = await openOverview(page);
    const { fleet, summaries } = farms;

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Fleet overview",
    );
    const summary = page.getByRole("region", { name: "Fleet summary" });
    await expect(summary.getByTestId("fleet-reporting")).toContainText(
      `${fleet.reporting} / ${fleet.turbines}`,
    );
    await expect(summary).toContainText(`Wind farms${fleet.farms}`);
    const powerMw = (fleet.powerOutputKw / 1000).toLocaleString("en-US", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    await expect(summary.getByTestId("fleet-power")).toContainText(
      `${powerMw} MW`,
    );
    await expect(summary.getByTestId("fleet-as-of")).toContainText(/UTC/);
    await expect(page.getByTestId("fleet-refresh-note")).toContainText(
      "refresh about once a minute",
    );

    const table = page.getByTestId("farms");
    await expect(table.getByRole("columnheader")).toHaveText([
      "Farm",
      "Location",
      "Turbines",
      "Reporting",
      "Output (kW)",
      "Avg wind (m/s)",
      "As of",
    ]);
    const shown = summaries.slice(0, 25);
    await expect(table.locator("tbody tr")).toHaveCount(shown.length);
    for (const [i, farm] of shown.entries()) {
      const cells = table.locator("tbody tr").nth(i).getByRole("cell");
      await expect(cells.nth(0)).toHaveText(`${farm.name} ${farm.id}`);
      await expect(cells.nth(2)).toHaveText(String(farm.turbineCount));
      await expect(cells.nth(3)).toHaveText(
        farm.turbineCount ? String(farm.reporting) : "–",
      );
    }
  });

  test("the farm filter narrows the table (not the map), shows the count, and Clear returns focus", async ({
    page,
  }) => {
    const { summaries } = await openOverview(page);
    const filter = page.getByTestId("farm-filter");
    await expect(page.getByTestId("farm-count")).toHaveText(
      `${Math.min(summaries.length, summaries.length)} of ${summaries.length} farms`,
    );

    await filter.fill("FARM02");
    const expected = summaries.filter((f) =>
      `${f.name} ${f.id}`.toLowerCase().includes("farm02"),
    );
    await expect(page.getByTestId("farm-count")).toHaveText(
      `${expected.length} of ${summaries.length} farms`,
    );
    await expect(page.getByTestId("farms").locator("tbody tr")).toHaveCount(
      expected.length,
    );

    await filter.fill("zzzz");
    await expect(page.getByTestId("no-farms")).toHaveText(
      "No farms match “zzzz”.",
    );

    await page.getByTestId("farm-filter-clear").click();
    await expect(filter).toHaveValue("");
    await expect(filter).toBeFocused();
  });

  test("the map draws one marker per farm with the legend; a marker opens its farm", async ({
    page,
  }) => {
    const farms = await openOverview(page);
    const map = page.getByRole("region", { name: "Map of wind farms" });
    await map.scrollIntoViewIfNeeded();
    const markers = page.locator("[data-marker-id]");
    await expect(markers).toHaveCount(farms.summaries.length);
    await expect(page.getByTestId("legend")).toContainText("Reporting");
    await expect(page.getByTestId("legend")).toContainText("No data in 60 min");
    await expect(page.getByRole("button", { name: "Zoom in" })).toBeVisible();

    // A real click on the vector marker (Leaflet hit-tests the SVG path; layout needed).
    await page.locator('[data-marker-id="FARM02"]').click();
    await expect(page).toHaveURL(/\/farms\/FARM02$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "High Plains",
    );
  });

  test("a farm row opens the farm page; All farms goes back", async ({
    page,
  }) => {
    await openOverview(page);
    await page
      .getByTestId("farms")
      .getByRole("row")
      .filter({ hasText: "FARM01" })
      .getByRole("cell")
      .nth(2)
      .click();
    await expect(page).toHaveURL(/\/farms\/FARM01$/);
    await expect(page).toHaveTitle(/Prairie Ridge · Nextera|Farm · Nextera/);
    await page.getByTestId("back-to-farms").click();
    await expect(page).toHaveURL(/\/farms$/);
  });
});

test.describe("Farm page", () => {
  test("lists the farm's turbines without a Farm column, with a marker each", async ({
    page,
  }) => {
    const farms = await openOverview(page);
    const farm = farms.find((f) => f.id === "FARM02")!;
    await page
      .getByTestId("farms")
      .getByRole("link", { name: farm.name })
      .click();
    await expect(page).toHaveURL(/\/farms\/FARM02$/);

    const summary = farms.summaries.find((f) => f.id === "FARM02")!;
    await expect(page.getByTestId("farm-reporting")).toContainText(
      `${summary.reporting} / ${summary.turbineCount}`,
    );
    await expect(page.getByTestId("farm-as-of")).toContainText(/UTC/);
    await expect(page.getByTestId("farm-refresh-note")).toBeVisible();
    // Never-reported turbines are hidden by default ("Hide turbines with no data"); the total is
    // the server's count of the turbines that have reported.
    const shown = farm.turbines.filter((t) => t.latest).length;
    await expect(page.getByTestId("turbine-count")).toHaveText(
      `${Math.min(shown, 25)} of ${shown} turbines`,
    );
    await expect(page.getByTestId("sort-farm")).toHaveCount(0);
    // Without the Farm column the filter searches turbine ids only.
    await expect(
      page.getByRole("searchbox", { name: "Turbine", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByTestId("turbines").locator("tr[data-turbine-id]"),
    ).toHaveCount(Math.min(shown, 25));

    await page
      .getByRole("region", { name: `Map of turbines at ${farm.name}` })
      .scrollIntoViewIfNeeded();
    await expect(page.locator("[data-marker-id]")).toHaveCount(
      summary.turbineCount,
    );
  });

  test("a farm without turbines says so", async ({ page }) => {
    // The fixture has farms without turbines; with db:seed:demo every farm has some, so then the
    // real summaries are passed on with the last farm emptied.
    await page.route(
      (url) => url.pathname.endsWith("/api/farm-summaries"),
      async (route) => {
        const farms = (await (await route.fetch()).json()) as FarmSummary[];
        if (!farms.some((f) => f.turbineCount === 0)) {
          Object.assign(farms.at(-1)!, {
            turbineCount: 0,
            reporting: 0,
            stale: 0,
            commissioned: 0,
          });
        }
        await route.fulfill({ json: farms });
      },
    );
    const farms = await openOverview(page);
    const empty = farms.summaries.find((f) => f.turbineCount === 0)!;
    await page
      .getByTestId("farms")
      .getByRole("link", { name: empty.name })
      .click();
    await expect(page).toHaveURL(new RegExp(`/farms/${empty.id}$`));
    await expect(page.getByTestId("no-turbines")).toHaveText(
      "No turbines are registered for this farm yet.",
    );
    await expect(page.getByTestId("turbines")).toHaveCount(0);
    await expect(page.getByTestId("farm-reporting")).toContainText("0 / 0");
  });
});
