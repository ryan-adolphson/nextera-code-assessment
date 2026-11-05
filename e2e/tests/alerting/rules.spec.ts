import { expect, test, type Page } from "@playwright/test";
import { SEED_NOW, logIn } from "../support/session.js";

// Plan 7.1, 7.3, 7.10: the Rules page and its editor dialog without writing anything (the
// create/edit/delete flows are [DATA]: tests/data/rules.spec.ts). Viewer access: roles.spec.ts.

const isRules = (url: string) =>
  /\/api\/alert-configs(\/[^/]+)?$/.test(new URL(url).pathname);

async function openRules(page: Page): Promise<void> {
  await page.clock.setFixedTime(SEED_NOW);
  await page.route("**/api/events**", (route) => route.abort());
  await logIn(page, "owner");
  await page.goto("/alerting/rules");
  await expect(page).toHaveTitle("Alert rules · Nextera");
}

test.describe("Alert rules (no writes)", () => {
  test("the editor validates the threshold and Cancel creates nothing", async ({
    page,
  }) => {
    await openRules(page);
    const writes: string[] = [];
    page.on("request", (r) => {
      if (isRules(r.url()) && r.method() !== "GET")
        writes.push(`${r.method()} ${r.url()}`);
    });
    await page.getByRole("button", { name: "Add rule" }).click();
    const dialog = page.getByRole("dialog", { name: "Add alert rule" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Metric")).toBeVisible();

    // The threshold's unit follows the metric.
    await dialog
      .getByLabel("Metric")
      .selectOption({ label: "Gearbox temperature (°C)" });
    await expect(dialog.locator("#rule-value-unit")).toHaveText("°C");
    await dialog
      .getByLabel("Metric")
      .selectOption({ label: "Wind speed (m/s)" });
    await expect(dialog.locator("#rule-value-unit")).toHaveText("m/s");

    await dialog.getByLabel("Threshold").fill("");
    await dialog.getByRole("button", { name: "Add rule" }).click();
    await expect(dialog.getByTestId("rule-value-error")).toHaveText(
      "Enter a threshold value.",
    );
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("rules-notice")).toHaveText("");
    expect(writes).toEqual([]);
  });

  test("an unreachable API keeps the dialog open with a message and Add rule enabled", async ({
    page,
  }) => {
    await openRules(page);
    await page.route(
      (url) => isRules(url.toString()),
      (route) =>
        route.request().method() === "POST"
          ? route.abort("connectionrefused")
          : route.fallback(),
    );
    await page.getByRole("button", { name: "Add rule" }).click();
    const dialog = page.getByRole("dialog", { name: "Add alert rule" });
    await dialog
      .getByLabel("Metric")
      .selectOption({ label: "Wind speed (m/s)" });
    await dialog.getByLabel("Threshold").fill("77");
    await dialog.getByRole("button", { name: "Add rule" }).click();
    await expect(dialog.getByTestId("rule-error")).toHaveText(
      "Could not reach the API. Check your connection and try again.",
    );
    await expect(
      dialog.getByRole("button", { name: "Add rule" }),
    ).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });

  test("a failed load shows the error; Retry loads the rules", async ({
    page,
  }) => {
    let fail = true;
    await page.route(
      (url) => isRules(url.toString()),
      (route) =>
        fail && route.request().method() === "GET"
          ? route.fulfill({
              status: 500,
              json: { statusCode: 500, message: "Internal server error" },
            })
          : route.fallback(),
    );
    await openRules(page);
    await expect(page.getByTestId("rules-load-error")).toContainText(
      "Could not load the alert rules.",
    );

    fail = false;
    await page
      .getByTestId("rules-load-error")
      .getByRole("button", { name: "Retry" })
      .click();
    await expect(page.getByTestId("rules-load-error")).toHaveCount(0);
    await expect(
      page.getByTestId("rules").or(page.getByTestId("no-rules")),
    ).toBeVisible();
  });
});
