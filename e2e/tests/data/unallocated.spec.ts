import { expect, test, type Locator, type Page } from "@playwright/test";
import { API_URL, apiToken, signIn } from "../support/session.js";
import { turbineTelemetry, uploadTelemetry } from "../support/telemetry.js";
import {
  listUnallocated,
  removeUnallocated,
  type UnallocatedEntry,
} from "../support/unallocated.js";

/**
 * [DATA] Unallocated turbines (plan section 11): readings of unknown turbines and farm mismatches
 * uploaded through the ingestion worker's CSV endpoint are held, show up live under
 * /unallocated/pending, and an owner assigns, keeps, blocks and unblocks them.
 *
 * Re-runnable on the same database:
 * - Unknown turbine ids are unique per run (`E2E-<run>-…`; the ingestion DTO allows 1–64
 *   characters of free text), so a held id never collides with a turbine an earlier run created.
 * - The farm mismatch uses TURB001 reporting FARM02 at a unique timestamp in 2020, so Keep always
 *   imports exactly one new reading, far outside every window the app shows for the Jan 2026
 *   fixture.
 * - afterAll removes every entry these tests held (block deletes the held readings, unblock the
 *   entry), also when a test failed half-way.
 *
 * Left behind, because there is no turbine or telemetry delete API: two turbines per run
 * (`E2E-<run>-NEW` on FARM01 and `E2E-<run>-MOV` on FARM03, not commissioned, each with 2 readings
 * on Jan 2 23:50–23:55) and one TURB001 reading per run in 2020. A fresh `docker compose down -v` + `db:seed` clears them.
 *
 * Timestamps: ingestion checks them against the real server clock (not in the future, from
 * 2000-01-01), while the browser clock is fixed at SEED_NOW (2026-01-03T00:00Z). Readings of the
 * unknown turbines are on Jan 2 23:45–23:55, so the UI shows them as "Reporting".
 */

const RUN = Date.now().toString(36).toUpperCase();
const id = (suffix: string) => `E2E-${RUN}-${suffix}`;
const ours = (entry: UnallocatedEntry) =>
  entry.turbineId.startsWith(`E2E-${RUN}-`) ||
  (entry.turbineId === "TURB001" && entry.reportedFarmId === "FARM02") ||
  (entry.turbineId === "TURB002" &&
    ["FARM01", "FARM07", "FARM99"].includes(entry.reportedFarmId));

/** A unique, whole-second measurement time in 2020 for this run. */
const MISMATCH_AT = new Date(
  Date.UTC(2020, 0, 1) +
    Math.floor((Date.now() % (365 * 86_400_000)) / 1000) * 1000,
).toISOString();

/**
 * TURB002's farm mismatches for the row-action checks: FARM01 exists (Move enabled), FARM99 doesn't
 * (Move disabled with a reason). Held only, never imported (afterAll blocks and unblocks them), at
 * unique 2020 times like MISMATCH_AT.
 */
const ROW_MISMATCH_AT = new Date(Date.parse(MISMATCH_AT) + 1000).toISOString();

function pendingRow(page: Page, turbineId: string, reportedFarmId?: string) {
  const row = page.locator(
    `[data-testid="unallocated-row"][data-turbine-id="${turbineId}"]`,
  );
  return reportedFarmId
    ? row.filter({
        // "Prairie Ridge FARM01" (the id in a pill), or "Unknown farm FARM99" when the farm doesn't exist.
        has: page
          .getByTestId("reported-farm")
          .filter({ hasText: new RegExp(`\\b${reportedFarmId}\\b`) }),
      })
    : row;
}

/** Widths of a table and of the scrolling wrapper it sits in (the table's parent element). */
interface TableFit {
  viewport: number;
  frame: number;
  table: number;
  scrollWidth: number;
}

async function tableFit(page: Page, tableTestId: string): Promise<TableFit> {
  // The wrapper has no test id of its own; it is the table's parent (`overflow-x-auto`).
  return page
    .getByTestId(tableTestId)
    .locator("xpath=..")
    .evaluate((frame) => ({
      viewport: window.innerWidth,
      frame: frame.clientWidth,
      table: frame.querySelector("table")!.getBoundingClientRect().width,
      scrollWidth: frame.scrollWidth,
    }));
}

/** The action cell (`td`) of a row, holding the given button test id. */
function actionCell(row: Locator, buttonTestId: string): Locator {
  return row
    .locator("td")
    .filter({ has: row.page().getByTestId(buttonTestId) });
}

/** Opens a Pending row's "More actions" menu with a click; returns its trigger and the open menu. */
async function openMoreActions(page: Page, row: Locator, turbineId: string) {
  const trigger = row.getByRole("button", {
    name: `More actions for ${turbineId}`,
  });
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return { trigger, menu };
}

/** Signs in as the owner and opens Unallocated from the side nav; waits for the list and Live. */
async function openPending(page: Page): Promise<void> {
  await signIn(page, "owner");
  const listed = page.waitForResponse(
    (r) =>
      r.url().includes("/api/unallocated-turbines?status=pending") && r.ok(),
  );
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Unallocated" })
    .click();
  await expect(page).toHaveURL(/\/unallocated\/pending$/);
  await listed;
  await expect(page.getByTestId("live-status")).toHaveText("Live");
}

test.describe("[DATA] Unallocated turbines", () => {
  test.beforeAll(async ({ request }) => {
    // A TURB001/FARM02 entry left by an interrupted earlier run would add its readings to Keep.
    await removeUnallocated(request, await apiToken(request, "owner"), ours);
  });

  test.afterAll(async ({ request }) => {
    const token = await apiToken(request, "owner");
    await removeUnallocated(request, token, ours);
    const left = [
      ...(await listUnallocated(request, token, "pending")),
      ...(await listUnallocated(request, token, "blocked")),
    ].filter(ours);
    expect(left, "entries left behind").toEqual([]);
  });

  test("[DATA] an unknown turbine appears under Pending live and expands to its held readings", async ({
    page,
    request,
  }) => {
    const turbineId = id("LIVE");
    await openPending(page);
    await expect(pendingRow(page, turbineId)).toHaveCount(0);
    // Marks this document: it must survive until the row appears (no reload, only SSE).
    await page.evaluate(
      () => ((window as { e2eNoReload?: boolean }).e2eNoReload = true),
    );

    const result = await uploadTelemetry(request, [
      {
        turbineId,
        farmId: "FARM01",
        timestamp: "2026-01-02T23:45:00Z",
        powerOutputKw: 1400,
      },
      {
        turbineId,
        farmId: "FARM01",
        timestamp: "2026-01-02T23:50:00Z",
        powerOutputKw: 1450,
      },
      {
        turbineId,
        farmId: "FARM01",
        timestamp: "2026-01-02T23:55:00Z",
        powerOutputKw: 1520,
        windSpeedMs: 8.2,
        gearboxTempC: 71.5,
      },
    ]);
    expect(result).toMatchObject({ rows: 3, inserted: 0, held: 3, blocked: 0 });

    const row = pendingRow(page, turbineId);
    await expect(row).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as { e2eNoReload?: boolean }).e2eNoReload,
      ),
    ).toBe(true);
    await expect(row.getByTestId("kind")).toHaveText("Unknown turbine");
    await expect(row.getByTestId("reported-farm")).toHaveText(
      "Prairie Ridge FARM01",
    );
    await expect(row.getByTestId("current-farm")).toHaveText(
      "Not in the fleet",
    );
    await expect(row.getByTestId("held")).toHaveText("3");
    // The row has no latest values: the newest held reading (expanded below) carries them.
    // The newest held reading (23:55) is 5 min before the browser clock.
    await expect(row.getByTestId("staleness")).toHaveText("Reporting");
    await expect(
      row.getByRole("button", { name: `Assign ${turbineId} to farm…` }),
    ).toBeVisible();

    const expand = row.getByRole("button", {
      name: `Show held readings for ${turbineId}`,
    });
    await expand.click();
    await expect(
      row.getByRole("button", { name: `Hide held readings for ${turbineId}` }),
    ).toHaveAttribute("aria-expanded", "true");
    const held = page.getByRole("table", {
      name: `Held readings for ${turbineId}`,
    });
    await expect(page.getByTestId("held-readings-count")).toHaveText(
      "3 held readings, newest first.",
    );
    const readings = held.getByTestId("held-reading");
    await expect(readings).toHaveCount(3);
    await expect(readings.nth(0)).toContainText("Jan 2, 23:55");
    await expect(readings.nth(0)).toContainText("1,520");
    await expect(readings.nth(0)).toContainText("8.2");
    await expect(readings.nth(0)).toContainText("71.5");
    await expect(readings.nth(2)).toContainText("Jan 2, 23:45");
    await expect(readings.nth(2)).toContainText("1,400");
  });

  test("[DATA] assigning an unknown turbine to FARM01 adds it to the fleet with its readings", async ({
    page,
    request,
  }) => {
    const turbineId = id("NEW");
    const result = await uploadTelemetry(request, [
      {
        turbineId,
        farmId: "FARM01",
        timestamp: "2026-01-02T23:50:00Z",
        powerOutputKw: 1610,
      },
      {
        turbineId,
        farmId: "FARM01",
        timestamp: "2026-01-02T23:55:00Z",
        powerOutputKw: 1640,
      },
    ]);
    expect(result).toMatchObject({ held: 2, inserted: 0 });

    await openPending(page);
    const row = pendingRow(page, turbineId);
    await row
      .getByRole("button", { name: `Assign ${turbineId} to farm…` })
      .click();

    const dialog = page.getByRole("dialog", {
      name: `Assign ${turbineId} to a farm`,
    });
    await expect(dialog).toBeVisible();
    // The reported farm exists, so it is preselected.
    await expect(dialog.getByLabel("Farm")).toHaveValue(
      "Prairie Ridge (FARM01)",
    );
    await dialog.getByRole("button", { name: "Assign", exact: true }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("unallocated-notice")).toHaveText(
      `${turbineId} assigned to Prairie Ridge (FARM01): 2 readings imported.`,
    );
    await expect(row).toHaveCount(0);

    // The shell's fleet now has the turbine, without reloading the app.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Turbines" })
      .click();
    await page.getByTestId("turbine-filter").fill(turbineId);
    const turbineRow = page
      .getByTestId("turbines")
      .locator(`[data-turbine-id="${turbineId}"]`);
    await expect(turbineRow).toContainText("Prairie Ridge");
    await expect(turbineRow.getByTestId("staleness")).toHaveText("Reporting");
    await expect(turbineRow).toContainText("Jan 2, 23:55");
    // An owner gets the switch instead of the icon: a new turbine isn't commissioned.
    await expect(
      turbineRow.getByRole("switch", {
        name: `Mark ${turbineId} as commissioned`,
      }),
    ).not.toBeChecked();

    // Its imported readings are on the turbine page.
    await turbineRow.getByRole("link", { name: turbineId }).click();
    await expect(page).toHaveURL(
      new RegExp(`/farms/FARM01/turbines/${turbineId}$`),
    );
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      `${turbineId} Prairie Ridge`,
    );
    await expect(page.getByTestId("not-commissioned")).toBeVisible();
    const history = page.getByTestId("history");
    await expect(
      history.getByRole("row", { name: /Jan 2, 23:55/ }),
    ).toContainText("1,640.0");
    await expect(
      history.getByRole("row", { name: /Jan 2, 23:50/ }),
    ).toContainText("1,610.0");

    // And it is listed on its farm's page.
    await page
      .getByTestId("breadcrumb")
      .getByRole("link", { name: "Prairie Ridge" })
      .click();
    await expect(page).toHaveURL(/\/farms\/FARM01$/);
    await expect(
      page.getByTestId("turbines").locator(`[data-turbine-id="${turbineId}"]`),
    ).toBeVisible();
  });

  test("[DATA] Keep imports a farm mismatch under the turbine’s own farm", async ({
    page,
    request,
  }) => {
    const result = await uploadTelemetry(request, [
      {
        turbineId: "TURB001",
        farmId: "FARM02",
        timestamp: MISMATCH_AT,
        powerOutputKw: 1234.5,
      },
    ]);
    expect(result).toMatchObject({ held: 1, inserted: 0 });

    await openPending(page);
    const row = pendingRow(page, "TURB001");
    await expect(row.getByTestId("kind")).toHaveText("Farm mismatch");
    await expect(row.getByTestId("reported-farm")).toHaveText(
      "High Plains FARM02",
    );
    await expect(row.getByTestId("current-farm")).toHaveText(
      "Prairie Ridge FARM01",
    );
    // Keep is the row's button; Move is in its "More actions" menu, enabled (FARM02 exists).
    const { trigger, menu } = await openMoreActions(page, row, "TURB001");
    await expect(
      menu.getByRole("menuitem", { name: "Move TURB001 to FARM02…" }),
    ).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();

    await row.getByRole("button", { name: "Keep TURB001 in FARM01" }).click();
    await expect(page.getByTestId("unallocated-notice")).toHaveText(
      "TURB001 kept in Prairie Ridge (FARM01): 1 reading imported.",
    );
    await expect(row).toHaveCount(0);

    // The held reading is now TURB001's, under FARM01 (it is far outside the app's windows).
    const token = await apiToken(request, "owner");
    const to = new Date(Date.parse(MISMATCH_AT) + 1000).toISOString();
    const stored = await turbineTelemetry(
      request,
      token,
      "TURB001",
      MISMATCH_AT,
      to,
    );
    expect(stored).toEqual([
      expect.objectContaining({
        farmId: "FARM01",
        timestamp: MISMATCH_AT,
        powerOutputKw: 1234.5,
      }),
    ]);
  });

  test("[DATA] Move takes a mismatched turbine and its history to the reported farm", async ({
    page,
    request,
  }) => {
    // A turbine of this run on FARM01 (held, then assigned through the API) that reports FARM03.
    const turbineId = id("MOV");
    const token = await apiToken(request, "owner");
    await uploadTelemetry(request, [
      {
        turbineId,
        farmId: "FARM01",
        timestamp: "2026-01-02T23:50:00Z",
        powerOutputKw: 900,
      },
    ]);
    const [held] = (await listUnallocated(request, token, "pending")).filter(
      (e) => e.turbineId === turbineId,
    );
    const assigned = await request.post(
      `${API_URL}/unallocated-turbines/${held.id}/assign`,
      {
        data: { farmId: "FARM01" },
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(assigned.status()).toBe(200);
    expect(
      await uploadTelemetry(request, [
        {
          turbineId,
          farmId: "FARM03",
          timestamp: "2026-01-02T23:55:00Z",
          powerOutputKw: 950,
        },
      ]),
    ).toMatchObject({ held: 1, inserted: 0 });

    await openPending(page);
    const row = pendingRow(page, turbineId);
    await expect(row.getByTestId("kind")).toHaveText("Farm mismatch");
    await expect(row.getByTestId("current-farm")).toHaveText(
      "Prairie Ridge FARM01",
    );
    const { menu } = await openMoreActions(page, row, turbineId);
    await menu
      .getByRole("menuitem", { name: `Move ${turbineId} to FARM03…` })
      .click();

    const dialog = page.getByRole("dialog", {
      name: `Move ${turbineId} to FARM03?`,
    });
    await expect(dialog.getByTestId("confirm-text")).toContainText(
      `${turbineId} and all its readings will move to Red Canyon (FARM03)`,
    );
    await dialog.getByRole("button", { name: "Move turbine" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("unallocated-notice")).toHaveText(
      `${turbineId} moved to Red Canyon (FARM03): 1 reading imported.`,
    );
    await expect(row).toHaveCount(0);

    // Its earlier FARM01 reading moved with it.
    const stored = await turbineTelemetry(
      request,
      token,
      turbineId,
      "2026-01-02T00:00:00Z",
      "2026-01-03T00:00:00Z",
    );
    expect(stored.map((r) => [r.timestamp, r.farmId])).toEqual([
      ["2026-01-02T23:55:00.000Z", "FARM03"],
      ["2026-01-02T23:50:00.000Z", "FARM03"],
    ]);

    // Without reload, the fleet has it on FARM03 and no longer on FARM01.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Turbines" })
      .click();
    await page.getByTestId("turbine-filter").fill(turbineId);
    const turbineRow = page
      .getByTestId("turbines")
      .locator(`[data-turbine-id="${turbineId}"]`);
    await expect(turbineRow).toContainText("Red Canyon");
    await expect(turbineRow).toContainText("Jan 2, 23:55");
  });

  test("[DATA] a blocked turbine’s readings are dropped until it is unblocked", async ({
    page,
    request,
  }) => {
    const turbineId = id("BLK");
    expect(
      await uploadTelemetry(request, [
        { turbineId, farmId: "FARM05", timestamp: "2026-01-02T22:00:00Z" },
      ]),
    ).toMatchObject({ held: 1, blocked: 0 });

    await openPending(page);
    const row = pendingRow(page, turbineId);
    const blockItem = page.getByRole("menuitem", {
      name: `Block ${turbineId} from FARM05…`,
      exact: true,
    });
    // Cancel first: the dialog hands focus back to the menu trigger (the menu item is gone by then).
    const { trigger } = await openMoreActions(page, row, turbineId);
    await blockItem.click();
    const dialog = page.getByRole("dialog", {
      name: `Block ${turbineId} from FARM05?`,
    });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    await openMoreActions(page, row, turbineId);
    await blockItem.click();
    await expect(dialog.getByTestId("confirm-text")).toContainText(
      `Readings for ${turbineId} that report FARM05 will be dropped until you unblock it`,
    );
    await dialog.getByRole("button", { name: "Block", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("unallocated-notice")).toHaveText(
      `Readings for ${turbineId} from FARM05 are now blocked.`,
    );
    await expect(row).toHaveCount(0);

    // A later reading of the blocked pair is dropped, not held.
    expect(
      await uploadTelemetry(request, [
        { turbineId, farmId: "FARM05", timestamp: "2026-01-02T22:05:00Z" },
      ]),
    ).toMatchObject({ rows: 1, inserted: 0, held: 0, blocked: 1 });

    await page
      .getByTestId("unallocated-tabs")
      .getByRole("tab", { name: "Blocked" })
      .click();
    await expect(page).toHaveURL(/\/unallocated\/blocked$/);
    const blocked = page.locator(
      `[data-testid="blocked-row"][data-turbine-id="${turbineId}"]`,
    );
    await expect(blocked.getByTestId("reported-farm")).toHaveText(
      "Blue Sky FARM05",
    );
    await expect(blocked.getByTestId("kind")).toHaveText("Unknown turbine");
    await expect(blocked.getByTestId("blocked-by")).toHaveText(
      "owner@nextera.local",
    );
    await expect(blocked.getByTestId("blocked-at")).not.toHaveText("–");

    await blocked
      .getByRole("button", { name: `Unblock ${turbineId} from FARM05` })
      .click();
    await expect(page.getByTestId("unallocated-notice")).toHaveText(
      `${turbineId} from FARM05 unblocked: its next reading will show under Pending.`,
    );
    await expect(blocked).toHaveCount(0);

    // Unblock deletes the entry: nothing is left in either list.
    const token = await apiToken(request, "owner");
    const all = [
      ...(await listUnallocated(request, token, "pending")),
      ...(await listUnallocated(request, token, "blocked")),
    ];
    expect(all.filter((e) => e.turbineId === turbineId)).toEqual([]);
  });

  test("[DATA] Pending and Blocked show each farm id in a pill, for known and unknown farms", async ({
    page,
    request,
  }) => {
    const unknownFarm = id("PILLU");
    const knownFarm = id("PILLK");
    const blockedKnown = id("PILLBK");
    const blockedUnknown = id("PILLBU");
    const at = "2026-01-02T23:30:00Z";
    await uploadTelemetry(request, [
      { turbineId: unknownFarm, farmId: "FARM99", timestamp: at },
      { turbineId: knownFarm, farmId: "FARM06", timestamp: at },
      { turbineId: "TURB002", farmId: "FARM07", timestamp: ROW_MISMATCH_AT },
      { turbineId: blockedKnown, farmId: "FARM05", timestamp: at },
      { turbineId: blockedUnknown, farmId: "FARM98", timestamp: at },
    ]);
    const token = await apiToken(request, "owner");
    for (const entry of (
      await listUnallocated(request, token, "pending")
    ).filter((e) => [blockedKnown, blockedUnknown].includes(e.turbineId))) {
      const blocked = await request.post(
        `${API_URL}/unallocated-turbines/${entry.id}/block`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(blocked.status()).toBe(200);
    }

    await openPending(page);
    // An unknown farm: the id is in a pill after the words, marked as not existing.
    const unknown = pendingRow(page, unknownFarm).getByTestId("reported-farm");
    await expect(unknown).toHaveText("Unknown farm FARM99");
    await expect(unknown).toHaveAttribute("data-exists", "false");
    await expect(unknown.getByTestId("farm-pill")).toHaveText("FARM99");
    // An unknown turbine has no current farm, so no pill there.
    const notInFleet = pendingRow(page, unknownFarm).getByTestId(
      "current-farm",
    );
    await expect(notInFleet).toHaveText("Not in the fleet");
    await expect(notInFleet.getByTestId("farm-pill")).toHaveCount(0);

    const known = pendingRow(page, knownFarm).getByTestId("reported-farm");
    await expect(known).toHaveText("Cedar Valley FARM06");
    await expect(known).toHaveAttribute("data-exists", "true");
    await expect(known.getByTestId("farm-pill")).toHaveText("FARM06");

    // A farm mismatch has both, each in its own pill.
    const mismatch = pendingRow(page, "TURB002", "FARM07");
    await expect(
      mismatch.getByTestId("reported-farm").getByTestId("farm-pill"),
    ).toHaveText("FARM07");
    await expect(mismatch.getByTestId("current-farm")).toHaveText(
      "High Plains FARM02",
    );
    await expect(
      mismatch.getByTestId("current-farm").getByTestId("farm-pill"),
    ).toHaveText("FARM02");

    await page
      .getByTestId("unallocated-tabs")
      .getByRole("tab", { name: "Blocked" })
      .click();
    const blockedRow = (turbineId: string) =>
      page.locator(
        `[data-testid="blocked-row"][data-turbine-id="${turbineId}"]`,
      );
    const blockedFarm = blockedRow(blockedKnown).getByTestId("reported-farm");
    await expect(blockedFarm).toHaveText("Blue Sky FARM05");
    await expect(blockedFarm).toHaveAttribute("data-exists", "true");
    await expect(blockedFarm.getByTestId("farm-pill")).toHaveText("FARM05");
    const blockedNoFarm =
      blockedRow(blockedUnknown).getByTestId("reported-farm");
    await expect(blockedNoFarm).toHaveText("Unknown farm FARM98");
    await expect(blockedNoFarm).toHaveAttribute("data-exists", "false");
    await expect(blockedNoFarm.getByTestId("farm-pill")).toHaveText("FARM98");
  });

  test.describe("row actions in a real browser (layout, keyboard)", () => {
    /**
     * Holds one row of each action layout: an unknown turbine (Assign), TURB002 reporting FARM01
     * (Keep, Move enabled) and TURB002 reporting FARM99 (Keep, Move disabled: no such farm).
     * Idempotent: a repeated upload of the same (pair, timestamp) holds nothing new.
     */
    test.beforeEach(async ({ request }) => {
      const result = await uploadTelemetry(request, [
        {
          turbineId: id("ROW"),
          farmId: "FARM01",
          timestamp: "2026-01-02T23:40:00Z",
        },
        { turbineId: "TURB002", farmId: "FARM01", timestamp: ROW_MISMATCH_AT },
        { turbineId: "TURB002", farmId: "FARM99", timestamp: ROW_MISMATCH_AT },
      ]);
      expect(result).toMatchObject({ rows: 3, inserted: 0, blocked: 0 });
    });

    test("[DATA] at desktop width every action cell is one line and every row is the same height", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openPending(page);
      await expect(
        pendingRow(page, id("ROW")).getByTestId("assign"),
      ).toBeVisible();
      await expect(
        pendingRow(page, "TURB002", "FARM01").getByTestId("keep"),
      ).toBeVisible();
      await expect(
        pendingRow(page, "TURB002", "FARM99").getByTestId("keep"),
      ).toBeVisible();

      const rows = page.getByTestId("unallocated-row");
      const layout = await rows.evaluateAll((trs) =>
        trs.map((tr) => {
          const cell = tr
            .querySelector('[data-testid="more-actions"]')!
            .closest("td")!;
          const buttons = [...cell.querySelectorAll("button")].map((b) =>
            b.getBoundingClientRect(),
          );
          // Lines of each button's visible label: one client rect per line of a text node.
          // Visually hidden text (a 1px box) doesn't count.
          const labelLines = [...cell.querySelectorAll("button")].map((b) => {
            const tops = new Set<number>();
            const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if (
                !node.textContent?.trim() ||
                node.parentElement!.getBoundingClientRect().width <= 1
              )
                continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              for (const r of range.getClientRects())
                if (r.width > 0) tops.add(Math.round(r.top));
            }
            return tops.size;
          });
          return {
            turbine: tr.getAttribute("data-turbine-id"),
            rowHeight: tr.getBoundingClientRect().height,
            buttonCenters: buttons.map((r) => r.top + r.height / 2),
            labelLines,
            overflows: cell.scrollWidth > cell.clientWidth,
          };
        }),
      );
      expect(layout.length).toBeGreaterThanOrEqual(3);
      for (const row of layout) {
        // The primary button and the menu trigger sit side by side, not stacked.
        expect(
          row.buttonCenters,
          `${row.turbine}: buttons on one line`,
        ).toHaveLength(2);
        expect(
          Math.abs(row.buttonCenters[0] - row.buttonCenters[1]),
          `${row.turbine}: buttons on one line`,
        ).toBeLessThanOrEqual(1);
        // The primary label doesn't wrap (the icon button has no text: 0 or 1 line box).
        expect(row.labelLines[0], `${row.turbine}: primary label lines`).toBe(
          1,
        );
        expect(row.overflows, `${row.turbine}: action cell overflows`).toBe(
          false,
        );
      }
      const heights = layout.map((r) => r.rowHeight);
      test
        .info()
        .annotations.push({
          type: "row-heights",
          description: heights.join(", "),
        });
      expect(
        Math.max(...heights) - Math.min(...heights),
        `row heights ${heights}`,
      ).toBeLessThanOrEqual(0.5);
    });

    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      test(`[DATA] at ${viewport.width}×${viewport.height} the Pending table fits without scrolling sideways`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await openPending(page);
        // The longest id of the fixture rows (E2E-<run>-ROW) is the widest turbine cell.
        const row = pendingRow(page, id("ROW"));
        await expect(row.getByTestId("assign")).toBeVisible();

        const fit = await tableFit(page, "unallocated");
        test
          .info()
          .annotations.push({
            type: "pending-fit",
            description: JSON.stringify(fit),
          });
        expect(
          fit.scrollWidth,
          `table ${fit.table} px in a ${fit.frame} px frame`,
        ).toBeLessThanOrEqual(fit.frame);
        // Every row's action cell is wholly on screen (not clipped by the frame or the window).
        for (const tr of await page.getByTestId("unallocated-row").all()) {
          await expect(actionCell(tr, "more-actions")).toBeInViewport({
            ratio: 1,
          });
        }
      });
    }

    test("[DATA] at 1000 px wide the actions stay pinned on an opaque background while the table scrolls", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1000, height: 800 });
      await openPending(page);
      const row = pendingRow(page, id("ROW"));
      await expect(row.getByTestId("assign")).toBeVisible();

      const fit = await tableFit(page, "unallocated");
      test
        .info()
        .annotations.push({
          type: "pending-fit",
          description: JSON.stringify(fit),
        });
      // The side nav leaves the frame narrower than the table's two-line minimum here.
      expect(
        fit.scrollWidth,
        `table ${fit.table} px in a ${fit.frame} px frame`,
      ).toBeGreaterThan(fit.frame);

      const frame = page.getByTestId("unallocated").locator("xpath=..");
      const cell = actionCell(row, "assign");
      // Scrolled fully left the actions column would sit past the frame's right edge if it
      // weren't pinned; scrolled fully right it is there anyway.
      for (const scrollLeft of [0, fit.scrollWidth]) {
        await frame.evaluate((el, left) => (el.scrollLeft = left), scrollLeft);
        await expect(cell, `scrollLeft ${scrollLeft}`).toBeInViewport({
          ratio: 1,
        });
      }
      await frame.evaluate((el) => (el.scrollLeft = 0));
      await expect(cell).toBeInViewport({ ratio: 1 });

      // Opaque, so the cells scrolling underneath don't show through. The computed colour may be
      // any CSS syntax (rgb, oklch, color-mix…): paint it on a canvas and read its alpha.
      const background = await cell.evaluate((td) => {
        const color = getComputedStyle(td).backgroundColor;
        const ctx = document.createElement("canvas").getContext("2d")!;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        return { color, alpha: ctx.getImageData(0, 0, 1, 1).data[3] };
      });
      test
        .info()
        .annotations.push({
          type: "pinned-background",
          description: background.color,
        });
      expect(
        background.alpha,
        `pinned cell background ${background.color}`,
      ).toBe(255);
    });

    test("[DATA] at 1280 px wide the Blocked table fits without scrolling sideways", async ({
      page,
      request,
    }) => {
      // A blocked entry of this run with the long id (afterAll unblocks it).
      const turbineId = id("ROWBLK");
      await uploadTelemetry(request, [
        { turbineId, farmId: "FARM05", timestamp: "2026-01-02T23:40:00Z" },
      ]);
      const token = await apiToken(request, "owner");
      const pending = (await listUnallocated(request, token, "pending")).find(
        (e) => e.turbineId === turbineId,
      );
      // Already blocked when this file repeats in one worker (same run id): the upload was dropped.
      if (pending) {
        const blocked = await request.post(
          `${API_URL}/unallocated-turbines/${pending.id}/block`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        expect(blocked.status()).toBe(200);
      }

      await page.setViewportSize({ width: 1280, height: 800 });
      await openPending(page);
      await page
        .getByTestId("unallocated-tabs")
        .getByRole("tab", { name: "Blocked" })
        .click();
      const row = page.locator(
        `[data-testid="blocked-row"][data-turbine-id="${turbineId}"]`,
      );
      await expect(row.getByTestId("unblock")).toBeVisible();

      const fit = await tableFit(page, "blocked");
      test
        .info()
        .annotations.push({
          type: "blocked-fit",
          description: JSON.stringify(fit),
        });
      expect(
        fit.scrollWidth,
        `table ${fit.table} px in a ${fit.frame} px frame`,
      ).toBeLessThanOrEqual(fit.frame);
      for (const tr of await page.getByTestId("blocked-row").all()) {
        await expect(actionCell(tr, "unblock")).toBeInViewport({ ratio: 1 });
      }
    });

    test("[DATA] the More actions menu works from the keyboard and Escape returns focus", async ({
      page,
    }) => {
      await openPending(page);
      const row = pendingRow(page, "TURB002", "FARM99");
      const trigger = row.getByRole("button", {
        name: "More actions for TURB002",
      });
      await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
      await expect(trigger).toHaveAttribute("aria-expanded", "false");

      await trigger.focus();
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      const move = menu.getByRole("menuitem", {
        name: "Move TURB002 to FARM99…",
      });
      const block = menu.getByRole("menuitem", {
        name: "Block TURB002 from FARM99…",
        exact: true,
      });
      // Opened by keyboard, the first item takes focus; the disabled Move stays focusable.
      await expect(move).toBeFocused();

      await page.keyboard.press("ArrowDown");
      await expect(block).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(move).toBeFocused();
      // The list wraps.
      await page.keyboard.press("ArrowUp");
      await expect(block).toBeFocused();

      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
    });

    test("[DATA] Move to a farm that doesn’t exist is disabled and shows why", async ({
      page,
    }) => {
      await openPending(page);
      const row = pendingRow(page, "TURB002", "FARM99");
      await expect(row.getByTestId("reported-farm")).toHaveAttribute(
        "data-exists",
        "false",
      );
      const { menu } = await openMoreActions(page, row, "TURB002");

      const move = menu.getByRole("menuitem", {
        name: "Move TURB002 to FARM99…",
        exact: true,
      });
      await expect(move).toHaveAttribute("aria-disabled", "true");
      await expect(move).toHaveAccessibleDescription(
        "No farm FARM99 to move to: keep or block it.",
      );
      const reason = menu.getByTestId("move-disabled-reason");
      await expect(reason).toBeVisible();
      await expect(reason).toHaveText(
        "No farm FARM99 to move to: keep or block it.",
      );

      // Clicking it does nothing: no confirmation opens and the entry stays pending.
      await move.click({ force: true });
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(row).toBeVisible();
    });
  });
});
