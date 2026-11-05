import {
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { API_URL } from "./session.js";

/**
 * Alert rule helpers for [DATA] tests (GET/POST/PATCH/DELETE /api/alert-configs; writes need an
 * owner). A rule is unique per (metric, comparison, level), and a rule that readings triggered
 * can't be deleted (409: telemetry_alerts restricts it), only disabled.
 */

export type Metric =
  | "powerOutputKw"
  | "windSpeedMs"
  | "rotorRpm"
  | "bladePitchDeg"
  | "gearboxTempC";
export type Level = "info" | "warn" | "error";

export interface Rule {
  id: string;
  measurementMetric: Metric;
  comparison: "above" | "below";
  valueMetric: number;
  alertLevel: Level;
  enabled: boolean;
}

export type RuleInput = Omit<Rule, "id" | "enabled">;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const sameKey = (a: RuleInput, b: RuleInput) =>
  a.measurementMetric === b.measurementMetric &&
  a.comparison === b.comparison &&
  a.alertLevel === b.alertLevel;

export async function listRules(
  request: APIRequestContext,
  token: string,
): Promise<Rule[]> {
  const response = await request.get(`${API_URL}/alert-configs`, {
    headers: auth(token),
  });
  expect(response.status(), "GET /api/alert-configs").toBe(200);
  return response.json();
}

export async function findRule(
  request: APIRequestContext,
  token: string,
  key: RuleInput,
): Promise<Rule | undefined> {
  return (await listRules(request, token)).find((r) => sameKey(r, key));
}

export async function createRule(
  request: APIRequestContext,
  token: string,
  rule: RuleInput,
): Promise<Rule> {
  const response = await request.post(`${API_URL}/alert-configs`, {
    data: rule,
    headers: auth(token),
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json();
}

export async function updateRule(
  request: APIRequestContext,
  token: string,
  id: string,
  patch: Partial<Omit<Rule, "id">>,
): Promise<void> {
  const response = await request.patch(`${API_URL}/alert-configs/${id}`, {
    data: patch,
    headers: auth(token),
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** DELETE; resolves the status (204, 404 when gone, 409 when readings triggered it). */
export async function deleteRule(
  request: APIRequestContext,
  token: string,
  id: string,
): Promise<number> {
  const response = await request.delete(`${API_URL}/alert-configs/${id}`, {
    headers: auth(token),
  });
  expect([204, 404, 409], await response.text()).toContain(response.status());
  return response.status();
}

/**
 * Makes `rule` exist and be enabled (creating it, or enabling and re-valuing the rule with its key
 * an earlier run left disabled). Resolves the rule and its cleanup: delete it, or disable it when
 * readings triggered it (409), so later runs find it again here.
 */
export async function ensureRule(
  request: APIRequestContext,
  token: string,
  rule: RuleInput,
): Promise<{
  rule: Rule;
  cleanup: (request: APIRequestContext) => Promise<void>;
}> {
  const existing = await findRule(request, token, rule);
  let id: string;
  if (existing) {
    await updateRule(request, token, existing.id, {
      valueMetric: rule.valueMetric,
      enabled: true,
    });
    id = existing.id;
  } else {
    id = (await createRule(request, token, rule)).id;
  }
  return {
    rule: { ...rule, id, enabled: true },
    // Takes its own request context: a beforeAll's can't be reused in afterAll.
    cleanup: async (cleanupRequest) => {
      if ((await deleteRule(cleanupRequest, token, id)) === 409)
        await updateRule(cleanupRequest, token, id, { enabled: false });
    },
  };
}

/** Deletes every rule with this key (setup/cleanup of rules a test creates through the UI). */
export async function removeRules(
  request: APIRequestContext,
  token: string,
  key: RuleInput,
): Promise<void> {
  for (const rule of (await listRules(request, token)).filter((r) =>
    sameKey(r, key),
  ))
    await deleteRule(request, token, rule.id);
}

// --- The Rules page (/alerting/rules) -------------------------------------------------------

/** A rule's row (`data-enabled` is the state it shows, optimistic while a toggle is pending). */
export const ruleRow = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="rule"][data-rule-id="${id}"]`);

/**
 * A row's Enabled switch (owners and admins): the `button[role=switch]` inside the
 * `rule-enabled-toggle`, named by what switching does ("Disable <rule>" / "Enable <rule>").
 */
export const ruleSwitch = (row: Locator): Locator =>
  row.getByTestId("rule-enabled-toggle").getByRole("switch");

/** Asserts a row shows the rule as enabled or disabled: switch, name, pill and `data-enabled`. */
export async function expectRuleState(
  row: Locator,
  describe: string,
  enabled: boolean,
): Promise<void> {
  await expect(row).toHaveAttribute("data-enabled", String(enabled));
  const toggle = ruleSwitch(row);
  await expect(toggle).toHaveAttribute("aria-checked", String(enabled));
  await expect(toggle).toHaveAccessibleName(
    `${enabled ? "Disable" : "Enable"} ${describe}`,
  );
  await expect(row.getByTestId("rule-disabled")).toHaveCount(enabled ? 0 : 1);
  if (!enabled)
    await expect(row.getByTestId("rule-disabled")).toHaveText("Disabled");
}

/** The theme's muted text colour (`--muted`) as the browser computes it (rgb(…)). */
export async function mutedColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--muted)";
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
}
