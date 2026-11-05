import { expect, test, type Page } from "@playwright/test";
import { SEED_NOW, userEmail } from "../support/session.js";

// Plan 1.1–1.5, 1.10: the /login page against the real API (each test starts in a fresh,
// signed-out context). Passwords come from SEED_USER_PASSWORD (repo .env), never from the spec.

const password = () => {
  const value = process.env.SEED_USER_PASSWORD;
  if (!value)
    throw new Error(
      "Set SEED_USER_PASSWORD (repo .env) and run npm run db:seed",
    );
  return value;
};

/** Counts POST /api/auth/login requests from now on. */
function loginRequests(page: Page): { count: () => number } {
  let count = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/auth/login")) count++;
  });
  return { count: () => count };
}

async function openLogin(page: Page): Promise<void> {
  await page.clock.setFixedTime(SEED_NOW);
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
}

const submit = (page: Page) =>
  page.getByRole("button", { name: "Sign in" }).click();

test.describe("Login", () => {
  test("renders an empty form without the app shell", async ({ page }) => {
    await openLogin(page);
    await expect(page).toHaveTitle("Sign in · Nextera");
    await expect(page.getByTestId("brand")).toHaveText("Nextera Wind fleet");
    await expect(page.getByLabel("Email")).toHaveValue("");
    await expect(page.getByLabel("Password")).toHaveValue("");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
    await expect(page.getByTestId("live-status")).toHaveCount(0);
  });

  test("required and email-format errors show without calling the API", async ({
    page,
  }) => {
    await openLogin(page);
    const requests = loginRequests(page);

    await submit(page);
    await expect(page.getByTestId("login-email-error")).toHaveText(
      "Enter your email address.",
    );
    await expect(page.getByTestId("login-password-error")).toHaveText(
      "Enter your password.",
    );

    await page.getByLabel("Email").fill("not-an-email");
    await page.getByLabel("Password").fill("anything");
    await submit(page);
    await expect(page.getByTestId("login-email-error")).toHaveText(
      "Enter a valid email address.",
    );
    await expect(page.getByTestId("login-password-error")).toHaveCount(0);

    expect(requests.count()).toBe(0);
    await expect(page).toHaveURL(/\/login$/);
  });

  test("a wrong password and an unknown email get the same message, and nothing is stored", async ({
    page,
  }) => {
    await openLogin(page);

    await page.getByLabel("Email").fill(userEmail("admin"));
    await page.getByLabel("Password").fill("definitely-not-the-password");
    const first = page.waitForResponse((r) =>
      r.url().endsWith("/api/auth/login"),
    );
    await submit(page);
    expect((await first).status()).toBe(401);
    await expect(page.getByTestId("login-error")).toHaveText(
      "Invalid email or password.",
    );
    // The email is kept, the password cleared for the next attempt.
    await expect(page.getByLabel("Email")).toHaveValue(userEmail("admin"));
    await expect(page.getByLabel("Password")).toHaveValue("");

    await page.getByLabel("Email").fill("nobody@nextera.local");
    await page.getByLabel("Password").fill("definitely-not-the-password");
    const second = page.waitForResponse((r) =>
      r.url().endsWith("/api/auth/login"),
    );
    await submit(page);
    expect((await second).status()).toBe(401);
    await expect(page.getByTestId("login-error")).toHaveText(
      "Invalid email or password.",
    );

    await expect(page).toHaveURL(/\/login$/);
    expect(
      await page.evaluate(() => localStorage.getItem("nextera.session")),
    ).toBeNull();
  });

  test("an unreachable API and rate limiting have their own messages", async ({
    page,
  }) => {
    await openLogin(page);
    let answer: "abort" | 429 = "abort";
    await page.route("**/api/auth/login", (route) =>
      answer === "abort"
        ? route.abort("connectionrefused")
        : route.fulfill({
            status: 429,
            json: { statusCode: 429, message: "Too Many Requests" },
          }),
    );

    await page.getByLabel("Email").fill(userEmail("admin"));
    await page.getByLabel("Password").fill("whatever");
    await submit(page);
    await expect(page.getByTestId("login-error")).toHaveText(
      "Could not reach the API. Check your connection and try again.",
    );

    answer = 429;
    await page.getByLabel("Password").fill("whatever");
    await submit(page);
    await expect(page.getByTestId("login-error")).toHaveText(
      "Too many attempts. Wait a few minutes and try again.",
    );
  });

  test("signing in lands on /farms with the user, goes Live, and survives a reload", async ({
    page,
  }) => {
    await openLogin(page);
    // Typed with stray case and spaces: the API normalises the email (trim, lower-case).
    await page
      .getByLabel("Email")
      .fill(`  ${userEmail("admin").toUpperCase()} `);
    await page.getByLabel("Password").fill(password());
    await submit(page);

    await expect(page).toHaveURL(/\/farms$/);
    await expect(page).toHaveTitle("Fleet overview · Nextera");
    await expect(page.getByTestId("current-user-email")).toHaveText(
      userEmail("admin"),
    );
    await expect(page.getByTestId("current-user-role")).toHaveText("Admin");
    await expect(page.getByTestId("live-status")).toHaveText("Live");

    await page.reload();
    await expect(page).toHaveURL(/\/farms$/);
    await expect(page.getByTestId("current-user-email")).toHaveText(
      userEmail("admin"),
    );
  });
});
