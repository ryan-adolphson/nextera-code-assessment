import { expect, type APIRequestContext } from "@playwright/test";
import { API_URL } from "./session.js";

/** The fields of an /api/unallocated-turbines entry the tests need. */
export interface UnallocatedEntry {
  id: string;
  turbineId: string;
  reportedFarmId: string;
  kind: "unknown_turbine" | "farm_mismatch";
  status: "pending" | "blocked";
  heldCount: number;
}

export async function listUnallocated(
  request: APIRequestContext,
  token: string,
  status: "pending" | "blocked",
): Promise<UnallocatedEntry[]> {
  const response = await request.get(`${API_URL}/unallocated-turbines`, {
    params: { status },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(200);
  return response.json();
}

/**
 * Removes every entry (pending or blocked) that matches `match`, through the API: a pending entry
 * is blocked first (which deletes its held readings), then unblocked (which deletes the entry).
 * Leaves nothing behind in unallocated_turbines / held_telemetry.
 */
export async function removeUnallocated(
  request: APIRequestContext,
  token: string,
  match: (entry: UnallocatedEntry) => boolean,
): Promise<void> {
  const headers = { Authorization: `Bearer ${token}` };
  for (const entry of (await listUnallocated(request, token, "pending")).filter(
    match,
  )) {
    const blocked = await request.post(
      `${API_URL}/unallocated-turbines/${entry.id}/block`,
      {
        headers,
      },
    );
    expect([200, 404]).toContain(blocked.status());
  }
  for (const entry of (await listUnallocated(request, token, "blocked")).filter(
    match,
  )) {
    const unblocked = await request.post(
      `${API_URL}/unallocated-turbines/${entry.id}/unblock`,
      {
        headers,
      },
    );
    expect([204, 404]).toContain(unblocked.status());
  }
}
