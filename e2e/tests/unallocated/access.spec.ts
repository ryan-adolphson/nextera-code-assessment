import { expect, test } from "@playwright/test";
import { API_URL, apiToken, signIn } from "../support/session.js";

// Plan 11.1: the Unallocated section is for owners and admins (read-only: nothing is changed).

test.describe("Unallocated access by role", () => {
  test("a viewer has no Unallocated nav item and /unallocated redirects to /farms", async ({
    page,
  }) => {
    await signIn(page, "viewer");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Farms" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Unallocated" })).toHaveCount(0);

    await page.goto("/unallocated");
    await expect(page).toHaveURL(/\/farms$/);
    await page.goto("/unallocated/blocked");
    await expect(page).toHaveURL(/\/farms$/);
  });

  test("the API answers a viewer 404 for the unallocated turbines", async ({
    request,
  }) => {
    const token = await apiToken(request, "viewer");
    const response = await request.get(`${API_URL}/unallocated-turbines`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status()).toBe(404);
  });

  test("an owner opens Unallocated from the nav, on the Pending tab, and switches to Blocked", async ({
    page,
  }) => {
    await signIn(page, "owner");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Unallocated" })
      .click();

    await expect(page).toHaveURL(/\/unallocated\/pending$/);
    await expect(page).toHaveTitle("Unallocated turbines · Nextera");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Unallocated turbines",
    );
    const tabs = page.getByRole("tablist", { name: "Unallocated" });
    await expect(tabs.getByRole("tab", { name: "Pending" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await tabs.getByRole("tab", { name: "Blocked" }).click();
    await expect(page).toHaveURL(/\/unallocated\/blocked$/);
    await expect(page).toHaveTitle("Blocked turbines · Nextera");
    await expect(tabs.getByRole("tab", { name: "Blocked" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
