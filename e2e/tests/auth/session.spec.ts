import { expect, test } from "@playwright/test";
import { SEED_NOW, logIn, signIn, userEmail } from "../support/session.js";

// Plan 1.6–1.9: the session (localStorage `nextera.session`), the route guards and the ways a
// session ends: Sign out, an invalid token (the API's 401) and the 24 h limit.

const SESSION_KEY = "nextera.session";

test.describe("Session and route guards", () => {
  test("signed out, guarded URLs go to /login without loading the fleet, then back after sign-in", async ({
    page,
  }) => {
    const apiCalls: string[] = [];
    page.on("request", (r) => {
      const path = new URL(r.url()).pathname;
      if (path.startsWith("/api/") && !path.endsWith("/auth/login"))
        apiCalls.push(path);
    });
    await page.clock.setFixedTime(SEED_NOW);

    for (const path of [
      "/farms",
      "/farms/FARM01",
      "/turbines",
      "/alerting/history",
      "/alerting/rules",
      "/reporting",
      "/unallocated/pending",
      "/settings",
    ]) {
      await page.goto(path);
      await expect(page).toHaveURL(
        new RegExp(
          `/login\\?returnUrl=${encodeURIComponent(path).replaceAll("/", "%2F")}$`,
        ),
      );
      await expect(
        page.getByRole("heading", { name: "Sign in" }),
      ).toBeVisible();
    }
    // No farms, telemetry or SSE before signing in.
    expect(apiCalls).toEqual([]);

    // Signing in returns to the page asked for.
    await page.goto("/farms/FARM01/turbines/TURB001");
    await expect(page).toHaveURL(/\/login\?returnUrl=/);
    await page.getByLabel("Email").fill(userEmail("viewer"));
    await page
      .getByLabel("Password")
      .fill(process.env.SEED_USER_PASSWORD ?? "");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/farms\/FARM01\/turbines\/TURB001$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "TURB001",
    );
  });

  test("a signed-in user opening /login is sent to /farms", async ({
    page,
  }) => {
    await signIn(page, "admin");
    await page.goto("/login");
    await expect(page).toHaveURL(/\/farms$/);
    await expect(page.getByTestId("current-user-email")).toHaveText(
      userEmail("admin"),
    );
  });

  test("Sign out forgets the session and guarded pages need a new sign-in", async ({
    page,
  }) => {
    await signIn(page, "owner");
    expect(
      await page.evaluate((k) => localStorage.getItem(k), SESSION_KEY),
    ).not.toBeNull();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(
      await page.evaluate((k) => localStorage.getItem(k), SESSION_KEY),
    ).toBeNull();

    await page.goBack();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/turbines");
    await expect(page).toHaveURL(/\/login\?returnUrl=%2Fturbines$/);
  });

  test("an invalid token is signed out on the API’s first 401", async ({
    page,
  }) => {
    await signIn(page, "admin");
    await page.evaluate((k) => {
      const session = JSON.parse(localStorage.getItem(k)!);
      localStorage.setItem(
        k,
        JSON.stringify({ ...session, accessToken: "not-a-jwt" }),
      );
    }, SESSION_KEY);

    // The request that carries the tampered token (not the landing page's own, maybe in flight).
    const rejected = page.waitForResponse(
      (r) =>
        /\/api\/farms$/.test(r.url()) &&
        r.request().headers()["authorization"] === "Bearer not-a-jwt",
    );
    await page.goto("/turbines");
    expect((await rejected).status()).toBe(401);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(
      await page.evaluate((k) => localStorage.getItem(k), SESSION_KEY),
    ).toBeNull();
  });

  test("the session ends after 24 hours and the open page returns to /login", async ({
    page,
  }) => {
    // A controllable clock (timers too): the app signs out at sign-in + 24 h.
    await page.clock.install({ time: SEED_NOW });
    await page.route("**/api/events**", (route) => route.abort());
    await logIn(page, "viewer");
    await page.goto("/turbines");
    await expect(page.getByTestId("turbine-count")).toBeVisible();

    await page.clock.fastForward("23:59:00");
    await expect(page).toHaveURL(/\/turbines$/);

    await page.clock.fastForward("01:01");
    await expect(page).toHaveURL(/\/login$/);
    expect(
      await page.evaluate((k) => localStorage.getItem(k), SESSION_KEY),
    ).toBeNull();
  });
});
