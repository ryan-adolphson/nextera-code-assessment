import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import {
  fetchFarms,
  mainNav,
  setCommissioned,
  turbinesOf,
} from "../support/fleet.js";
import { API_URL, apiToken, signIn, type Role } from "../support/session.js";

/**
 * [DATA] The Commissioned switch in the turbines table (plan 4.11–4.16): against the real API, which
 * stores the flag and publishes fleet.changed. Only the failure test mocks anything (PATCH 500).
 *
 * Re-runnable on the same database: every test starts with TURB001 and TURB002 off (their value in
 * the db:seed fixture) and afterAll puts back what it found, so nothing is left behind.
 */

const T1 = "TURB001";
const T2 = "TURB002";

const row = (page: Page, id: string) =>
  page.locator(`tr[data-turbine-id="${id}"]`);
const toggle = (page: Page, id: string) =>
  page.getByRole("switch", { name: `Mark ${id} as commissioned` });
const isTurbineUrl = (id: string) => (url: URL) =>
  url.pathname.endsWith(`/api/turbines/${id}`);

/** Signs in and opens /turbines from the side nav; waits for the table and the live stream. */
async function openTurbines(page: Page, role: Role): Promise<void> {
  await signIn(page, role);
  await mainNav(page).getByRole("link", { name: "Turbines" }).click();
  await expect(page).toHaveURL(/\/turbines$/);
  await expect(row(page, T1)).toBeVisible();
  await expect(page.getByTestId("live-status")).toHaveText("Live");
}

async function commissionedInApi(
  request: APIRequestContext,
  id: string,
): Promise<boolean> {
  const farms = await fetchFarms(request, await apiToken(request, "viewer"));
  return turbinesOf(farms).find((t) => t.id === id)!.commissioned;
}

test.describe("[DATA] Commissioned switch", () => {
  const original = new Map<string, boolean>();

  test.beforeAll(async ({ request }) => {
    for (const id of [T1, T2])
      original.set(id, await commissionedInApi(request, id));
  });

  test.beforeEach(async ({ request }) => {
    const token = await apiToken(request, "owner");
    for (const id of [T1, T2]) await setCommissioned(request, token, id, false);
  });

  test.afterAll(async ({ request }) => {
    const token = await apiToken(request, "owner");
    for (const [id, value] of original)
      await setCommissioned(request, token, id, value);
    for (const [id, value] of original) {
      expect(await commissionedInApi(request, id), `${id} restored`).toBe(
        value,
      );
    }
  });

  test("[DATA] an owner switches a turbine on: saved once, kept over a reload and in GET /api/farms", async ({
    page,
    request,
  }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const patches: unknown[] = [];
    await page.route(isTurbineUrl(T1), async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      patches.push(route.request().postDataJSON());
      await held;
      await route.fallback();
    });

    await openTurbines(page, "owner");
    const sw = toggle(page, T1);
    await expect(sw).not.toBeChecked();
    await expect(sw).not.toHaveAttribute("aria-disabled", "true");
    await sw.click();

    // Shown at once and waiting for the save; it keeps focus, and another click does nothing.
    await expect(sw).toBeChecked();
    await expect(sw).toHaveAttribute("aria-disabled", "true");
    await expect(sw).toBeFocused();
    await expect(
      row(page, T1).getByTestId("commissioned-cell"),
    ).toHaveAttribute("data-commissioned", "true");
    // force: Playwright itself waits for aria-disabled to clear; a user's click doesn't.
    await sw.click({ force: true });
    await expect(sw).toBeChecked();

    const saved = page.waitForResponse(
      (r) =>
        isTurbineUrl(T1)(new URL(r.url())) && r.request().method() === "PATCH",
    );
    release();
    expect((await saved).status()).toBe(200);
    await expect(sw).not.toHaveAttribute("aria-disabled", "true");
    await expect(sw).toBeChecked();
    await expect(sw).toBeFocused();
    expect(patches).toEqual([{ commissioned: true }]);
    await expect(page.getByTestId("commissioned-error")).toHaveCount(0);
    expect(await commissionedInApi(request, T1)).toBe(true);

    await page.reload();
    await expect(toggle(page, T1)).toBeChecked();
    await expect(toggle(page, T2)).not.toBeChecked();
    // The turbine page follows the same flag.
    await row(page, T1).getByRole("link", { name: T1 }).click();
    await expect(page).toHaveURL(new RegExp(`/turbines/${T1}$`));
    await expect(page.getByRole("heading", { level: 1 })).toContainText(T1);
    await expect(page.getByTestId("not-commissioned")).toHaveCount(0);
  });

  test("[DATA] the switch works from the keyboard and an admin can switch back off", async ({
    page,
    request,
  }) => {
    await setCommissioned(request, await apiToken(request, "owner"), T1, true);
    await openTurbines(page, "admin");
    const sw = toggle(page, T1);
    await expect(sw).toBeChecked();

    await sw.focus();
    const saved = page.waitForResponse(
      (r) =>
        isTurbineUrl(T1)(new URL(r.url())) && r.request().method() === "PATCH",
    );
    await page.keyboard.press("Space");
    expect((await saved).status()).toBe(200);
    await expect(sw).not.toBeChecked();
    await expect(sw).toBeFocused();
    expect(await commissionedInApi(request, T1)).toBe(false);
  });

  test("[DATA] a viewer's open page follows an owner's change live, with no switch of its own", async ({
    page,
    browser,
  }) => {
    await openTurbines(page, "viewer");
    const viewerRow = row(page, T1);
    const icon = viewerRow.getByTestId("commissioned-icon");
    await expect(icon).toHaveAttribute("data-icon", "x");
    await expect(viewerRow).toContainText("Not commissioned");
    await expect(
      page.getByRole("switch", { name: /as commissioned$/ }),
    ).toHaveCount(0);
    await expect(page.getByTestId("commissioned-toggle")).toHaveCount(0);
    await page.evaluate(
      () => ((window as { e2eNoReload?: boolean }).e2eNoReload = true),
    );

    const owner = await browser.newContext();
    try {
      const ownerPage = await owner.newPage();
      await openTurbines(ownerPage, "owner");

      await toggle(ownerPage, T1).click();
      await expect(icon).toHaveAttribute("data-icon", "check");
      await expect(viewerRow.getByTestId("commissioned-cell")).toHaveAttribute(
        "data-commissioned",
        "true",
      );
      // Not a reading, so the row doesn't flash.
      await expect(viewerRow).not.toHaveAttribute("data-updated", "");

      await toggle(ownerPage, T1).click();
      await expect(icon).toHaveAttribute("data-icon", "x");
    } finally {
      await owner.close();
    }
    expect(
      await page.evaluate(
        () => (window as { e2eNoReload?: boolean }).e2eNoReload,
      ),
    ).toBe(true);
  });

  test("[DATA] setting the value it already has publishes nothing: viewers don't reload", async ({
    page,
    request,
  }) => {
    await openTurbines(page, "viewer");
    const loads: string[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.endsWith("/api/turbines"))
        loads.push(r.url());
    });
    const token = await apiToken(request, "owner");

    // No change, then a real one: its event arrives after any the first could have published.
    await setCommissioned(request, token, T1, false);
    await setCommissioned(request, token, T1, true);
    await expect(
      row(page, T1).getByTestId("commissioned-icon"),
    ).toHaveAttribute("data-icon", "check");
    // Only the real change's fleet.changed made the page fetch its turbines again.
    expect(loads, "GET /api/turbines sent by the open page").toHaveLength(1);
  });

  test("[DATA] a failed save rolls the switch back and says why; the next change clears it", async ({
    page,
    request,
  }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const turbineUrl = isTurbineUrl(T1);
    await page.route(turbineUrl, async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      await held;
      await route.fulfill({
        status: 500,
        json: { message: "Internal server error" },
      });
    });

    await openTurbines(page, "owner");
    const sw = toggle(page, T1);
    await sw.click();
    await expect(sw).toBeChecked();
    await expect(sw).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("commissioned-error")).toHaveCount(0);

    release();
    const error = page.getByTestId("commissioned-error");
    await expect(error).toContainText(`Could not mark ${T1} as commissioned.`);
    await expect(error).toHaveRole("alert");
    await expect(sw).not.toBeChecked();
    await expect(sw).not.toHaveAttribute("aria-disabled", "true");
    await expect(
      row(page, T1).getByTestId("commissioned-cell"),
    ).toHaveAttribute("data-commissioned", "false");
    expect(await commissionedInApi(request, T1)).toBe(false);

    await page.unroute(turbineUrl);
    await sw.click();
    await expect(error).toHaveCount(0);
    await expect(sw).toBeChecked();
    await expect(sw).not.toHaveAttribute("aria-disabled", "true");
    await expect.poll(() => commissionedInApi(request, T1)).toBe(true);
  });

  test("[DATA] under a commissioning filter the row leaves the table and focus lands on the count", async ({
    page,
    request,
  }) => {
    await openTurbines(page, "owner");
    await page
      .getByTestId("commissioned-filter")
      .selectOption({ label: "Not commissioned" });
    const count = page.getByTestId("turbine-count");
    const before = await count.textContent();
    const shownBefore = Number(before!.trim().split(" ")[0]);

    await toggle(page, T1).click();
    await expect(row(page, T1)).toHaveCount(0);
    await expect(count).toBeFocused();
    await expect(count).toContainText(`${shownBefore - 1} of `);

    // Focus isn't on another row's switch, so a repeated key can't change another turbine.
    await page.keyboard.press("Space");
    await expect.poll(() => commissionedInApi(request, T1)).toBe(true);
    expect(await commissionedInApi(request, T2)).toBe(false);
    await expect(toggle(page, T2)).not.toBeChecked();
    // Still gone once the save has answered and the fleet has reloaded.
    await expect(row(page, T1)).toHaveCount(0);

    await page
      .getByTestId("commissioned-filter")
      .selectOption({ label: "Commissioned" });
    await expect(toggle(page, T1)).toBeChecked();
  });

  test("[DATA] sorted by Commissioned the row moves up and focus stays on its switch", async ({
    page,
  }) => {
    await openTurbines(page, "owner");
    await page.getByTestId("sort-commissioned").click();
    await expect(page.getByTestId("sort-commissioned")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    const position = async (id: string) =>
      (
        await page
          .locator("tr[data-turbine-id]")
          .evaluateAll((els) =>
            els.map((e) => e.getAttribute("data-turbine-id")),
          )
      ).indexOf(id);
    // All off: ties by id, so TURB001 is above TURB002.
    await expect
      .poll(async () => (await position(T1)) < (await position(T2)))
      .toBe(true);

    const sw = toggle(page, T2);
    await sw.click();
    // Commissioned first: TURB002 is now the first row, ahead of every turbine that is off.
    await expect.poll(() => position(T2)).toBe(0);
    await expect(sw).toBeFocused();
    await expect(sw).toBeChecked();
    await expect(sw).not.toHaveAttribute("aria-disabled", "true");
    await expect.poll(() => position(T2)).toBe(0);
    await expect(sw).toBeFocused();
    await expect(sw).toBeInViewport();
  });

  test("[DATA] PATCH /api/turbines/:id: owner and admin 200, viewer 404, signed out 401, bad input 400", async ({
    request,
  }) => {
    const send = (token: string | null, id: string, data: unknown) =>
      request.patch(`${API_URL}/turbines/${id}`, {
        data,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    const owner = await apiToken(request, "owner");
    const admin = await apiToken(request, "admin");
    const viewer = await apiToken(request, "viewer");

    const updated = await send(owner, T1, { commissioned: true });
    expect(updated.status()).toBe(200);
    expect(await updated.json()).toMatchObject({ id: T1, commissioned: true });
    expect((await send(admin, T1, { commissioned: false })).status()).toBe(200);

    // A too-low role gets the body of an unknown route, and changes nothing.
    const refused = await send(viewer, T1, { commissioned: true });
    expect(refused.status()).toBe(404);
    expect(await refused.text()).toContain(`Cannot PATCH /api/turbines/${T1}`);
    expect((await send(null, T1, { commissioned: true })).status()).toBe(401);
    expect(await commissionedInApi(request, T1)).toBe(false);

    expect((await send(owner, T1, { commissioned: "true" })).status()).toBe(
      400,
    );
    expect((await send(owner, T1, {})).status()).toBe(400);
    expect(
      (await send(owner, "NO-SUCH-TURBINE", { commissioned: true })).status(),
    ).toBe(404);
    expect(await commissionedInApi(request, T1)).toBe(false);
  });
});
