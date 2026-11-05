import { expect, test } from "@playwright/test";
import { mainNav } from "../support/fleet.js";
import {
  API_URL,
  apiToken,
  signIn,
  userEmail,
  type Role,
} from "../support/session.js";

// Plan 2: what each role sees in the side nav and which routes its guards let through
// (viewer < owner < admin). The API hides too-low roles as 404s (2.7). Read-only.

const NAV: Record<Role, string[]> = {
  viewer: ["Farms", "Turbines", "Alerting", "Settings"],
  owner: [
    "Farms",
    "Turbines",
    "Alerting",
    "Unallocated",
    "Reporting",
    "Settings",
  ],
  admin: [
    "Farms",
    "Turbines",
    "Alerting",
    "Unallocated",
    "Reporting",
    "Settings",
  ],
};
const LABEL: Record<Role, string> = {
  viewer: "Viewer",
  owner: "Owner",
  admin: "Admin",
};

for (const role of ["viewer", "owner", "admin"] as const) {
  test.describe(`As ${role}`, () => {
    test(`the nav shows ${NAV[role].join(", ")} and the role`, async ({
      page,
    }) => {
      await signIn(page, role);
      await expect(mainNav(page).getByRole("link")).toHaveText(NAV[role]);
      await expect(page.getByTestId("current-user-email")).toHaveText(
        userEmail(role),
      );
      await expect(page.getByTestId("current-user-role")).toHaveText(
        LABEL[role],
      );
    });

    test(`the Rules page ${role === "viewer" ? "has no" : "has"} Add, Edit and Delete`, async ({
      page,
    }) => {
      await signIn(page, role);
      const rules = page.waitForResponse((r) =>
        /\/api\/alert-configs$/.test(r.url()),
      );
      await page.goto("/alerting/rules");
      const list = (await (await rules).json()) as unknown[];
      await expect(page.getByTestId("rules-loading")).toHaveCount(0);

      const canEdit = role !== "viewer";
      await expect(page.getByRole("button", { name: "Add rule" })).toHaveCount(
        canEdit ? 1 : 0,
      );
      if (list.length) {
        await expect(page.getByTestId("rule")).toHaveCount(
          Math.min(list.length, 25),
        );
        await expect(page.getByTestId("edit-rule")).toHaveCount(
          canEdit ? Math.min(list.length, 25) : 0,
        );
        await expect(page.getByTestId("delete-rule")).toHaveCount(
          canEdit ? Math.min(list.length, 25) : 0,
        );
      } else {
        await expect(page.getByTestId("no-rules")).toContainText(
          canEdit ? "Add one, for example" : "An owner or admin can add them.",
        );
      }
    });
  });
}

test.describe("Route guards", () => {
  test("a viewer opening /reporting or /unallocated lands on /farms without a report request", async ({
    page,
  }) => {
    const reports: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/reports")) reports.push(r.url());
    });
    await signIn(page, "viewer");
    for (const path of ["/reporting", "/unallocated", "/unallocated/pending"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/farms$/);
      await expect(
        page.getByRole("heading", { name: "Fleet overview" }),
      ).toBeVisible();
    }
    expect(reports).toEqual([]);
  });

  test("an owner opens Reporting from the nav", async ({ page }) => {
    await signIn(page, "owner");
    await mainNav(page).getByRole("link", { name: "Reporting" }).click();
    await expect(page).toHaveURL(/\/reporting$/);
    await expect(page).toHaveTitle("Reporting · Nextera");
    await expect(
      page.getByRole("heading", { name: "Reporting" }),
    ).toBeVisible();
  });

  test("the API answers a viewer’s rule write 404 and creates nothing", async ({
    request,
  }) => {
    const token = await apiToken(request, "viewer");
    const before = await request.get(`${API_URL}/alert-configs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const response = await request.post(`${API_URL}/alert-configs`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        measurementMetric: "windSpeedMs",
        comparison: "above",
        valueMetric: 99,
        alertLevel: "info",
      },
    });
    expect(response.status()).toBe(404);
    const after = await request.get(`${API_URL}/alert-configs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await after.json()).toEqual(await before.json());
  });

  test("unknown URLs and / go to /farms", async ({ page }) => {
    await signIn(page, "viewer");
    for (const path of ["/nope/xyz", "/"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/farms$/);
    }
  });
});

test.describe("Navigation", () => {
  test("nav links open each section and mark it current, also on deep pages", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const nav = mainNav(page);
    const cases: [string, RegExp, string][] = [
      ["Turbines", /\/turbines$/, "Turbines · Nextera"],
      ["Alerting", /\/alerting\/history$/, "Alert history · Nextera"],
      [
        "Unallocated",
        /\/unallocated\/pending$/,
        "Unallocated turbines · Nextera",
      ],
      ["Reporting", /\/reporting$/, "Reporting · Nextera"],
      ["Settings", /\/settings$/, "Settings · Nextera"],
      ["Farms", /\/farms$/, "Fleet overview · Nextera"],
    ];
    for (const [name, url, title] of cases) {
      await nav.getByRole("link", { name }).click();
      await expect(page).toHaveURL(url);
      await expect(page).toHaveTitle(title);
      await expect(nav.getByRole("link", { name })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    }

    // Deep pages keep their section current.
    await page.goto("/farms/FARM01/turbines/TURB001");
    await expect(page).toHaveTitle("Turbine · Nextera");
    await expect(nav.getByRole("link", { name: "Farms" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await nav.getByRole("link", { name: "Alerting" }).click();
    await page
      .getByRole("tablist", { name: "Alerting" })
      .getByRole("tab", { name: "Rules" })
      .click();
    await expect(page).toHaveURL(/\/alerting\/rules$/);
    await expect(page).toHaveTitle("Alert rules · Nextera");
    await expect(nav.getByRole("link", { name: "Alerting" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("back and forward restore farm → turbine without a reload", async ({
    page,
  }) => {
    await signIn(page, "admin");
    await page.evaluate(
      () => ((window as { e2eNoReload?: boolean }).e2eNoReload = true),
    );
    await page
      .getByTestId("farms")
      .getByRole("link", { name: "Prairie Ridge" })
      .click();
    await expect(page).toHaveURL(/\/farms\/FARM01$/);
    await page
      .getByTestId("turbines")
      .getByRole("link", { name: "TURB001", exact: true })
      .click();
    await expect(page).toHaveURL(/\/farms\/FARM01\/turbines\/TURB001$/);

    await page.goBack();
    await expect(page).toHaveURL(/\/farms\/FARM01$/);
    await expect(page.getByTestId("farm-power")).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/farms$/);
    await expect(
      page.getByRole("heading", { name: "Fleet overview" }),
    ).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(/\/farms\/FARM01$/);
    expect(
      await page.evaluate(
        () => (window as { e2eNoReload?: boolean }).e2eNoReload,
      ),
    ).toBe(true);
  });

  test("on a phone the menu toggle opens the nav and closes it after navigating", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 700 });
    await signIn(page, "viewer");
    const toggle = page.getByTestId("nav-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(mainNav(page)).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await mainNav(page).getByRole("link", { name: "Turbines" }).click();
    await expect(page).toHaveURL(/\/turbines$/);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(mainNav(page)).toBeHidden();

    // No page-level horizontal scrolling on a phone.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(toggle).toBeHidden();
    await expect(mainNav(page)).toBeVisible();
  });
});
