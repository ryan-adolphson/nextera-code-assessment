import { expect, test, type Page } from "@playwright/test";
import { mainNav } from "../support/fleet.js";
import {
  mockReading,
  mockTurbine,
  mockTurbines,
  type MockTurbine,
} from "../support/mock-turbines.js";
import { SEED_NOW, logIn } from "../support/session.js";

// Plan 4.17–4.20: live updates in the turbines table, in a real browser. Real sign-in, generated
// turbines served by mockTurbines (the fixture has too few to scroll or re-order), and the SSE
// stream mocked through page.route, so a burst's readings and their timing are the test's own.
// Only the visible page updates live: its readings are applied in ONE update a second after the
// first arrives (cells, 2 s highlight, and a re-order when the sort is by a value readings change).
// The page is fetched again each time a stream opens, so the mock "server" is static unless a test
// changes it. A recorder in the page keeps every distinct row order and highlight set
// (MutationObserver) and a sample per frame (requestAnimationFrame). Windows are generous above
// (a loaded machine is late, never early) and tight below. Read-only.

const FARM = "FARM01";
const GEN = (n: number) => `GEN${String(n).padStart(2, "0")}`;
const LIVE_BATCH_MS = 1000;
const FLASH_MS = 2000;
const ROW_GLIDE_MS = 500;
/** How early a timer can look against the frame that showed its cause. */
const EARLY_MS = 50;

const reading = (
  turbineId: string,
  ageSeconds: number,
  farmId = FARM,
  powerOutputKw = 1000,
) => ({
  ...mockReading(turbineId, farmId, ageSeconds / 60, powerOutputKw),
  id: `reading-${turbineId}-${ageSeconds}`,
});

/**
 * 20 turbines, GEN01 newest (10 min old) to GEN20 oldest: the default sort (newest first) lists them
 * by id. Power runs the other way.
 */
const IDS = Array.from({ length: 20 }, (_, i) => GEN(i + 1));
const generated = (farmId: string, ids: string[]): MockTurbine[] =>
  ids.map((id, i) => {
    const turbine = mockTurbine(id, farmId, (600 + i * 60) / 60, {
      power: 2000 - i,
    });
    return { ...turbine, latest: reading(id, 600 + i * 60, farmId, 2000 - i) };
  });

/** Serves GET /api/turbines with generated turbines in the farms named here. */
async function mockFleet(
  page: Page,
  turbinesByFarm: Record<string, string[]> = { [FARM]: IDS },
): Promise<void> {
  await mockTurbines(
    page,
    Object.entries(turbinesByFarm).flatMap(([farmId, ids]) =>
      generated(farmId, ids),
    ),
  );
}

/**
 * The mocked stream. Each EventSource request waits until the test sends its readings: they arrive
 * in one body, in one go. The page reconnects the stream for the visible turbines (a new request
 * with `turbines=`, the older one closed), so a send goes to the newest request. A fulfilled body
 * ends the stream, so the browser reconnects on its own (`retry`, 200 ms), and that request
 * serves the next wave. Each open fetches the page again (from the static mock server).
 */
async function mockStream(
  page: Page,
): Promise<(readings: ReturnType<typeof reading>[]) => Promise<void>> {
  const waiting: Parameters<Parameters<Page["route"]>[1]>[0][] = [];
  let arrived = () => {};
  await page.route("**/api/events**", (route) => {
    waiting.push(route);
    arrived();
  });
  return async (readings) => {
    // The request that carries the page's turbines (after the watch debounce), not the first one.
    while (
      !waiting.some((r) =>
        new URL(r.request().url()).searchParams.has("turbines"),
      )
    )
      await new Promise<void>((resolve) => (arrived = resolve));
    const route = waiting.pop()!;
    waiting.length = 0; // earlier ones were closed by the app
    await route.fulfill({
      headers: { "content-type": "text/event-stream" },
      body:
        "retry: 200\n\n" +
        readings
          .map(
            (r) =>
              `event: telemetry.received\nid: ${r.id}\ndata: ${JSON.stringify(r)}\n\n`,
          )
          .join(""),
    });
  };
}

/** What the table looked like whenever its row order or highlighted rows changed. */
interface Snapshot {
  t: number;
  order: string[];
  updated: string[];
}

/** One animation frame. */
interface FrameSample {
  t: number;
  /** Rows with a running glide, and the glide's duration. */
  gliding: string[];
  duration: number | null;
  /** Each gliding row's current vertical offset, px. */
  offsets: Record<string, number>;
  /** The flash animation's current time, by row. */
  flash: Record<string, number>;
  /** Sticky header's top minus the scroll region's top, px. */
  headerOffset: number;
  /** The top element at the centre of each header cell is inside the header. */
  headerOnTop: boolean;
  scrollTop: number;
  /** Every row's top on the screen, px. */
  screenTops: Record<string, number>;
}

interface Recording {
  snapshots: Snapshot[];
  frames: FrameSample[];
  tableStillThere: boolean;
}

/** Starts the recorder on the table that is on the page now. */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const table = document.querySelector<HTMLTableElement>(
      '[data-testid="turbines"]',
    )!;
    const region = document.querySelector<HTMLElement>(
      '[data-testid="turbines-scroll"]',
    )!;
    const rec: Omit<Recording, "tableStillThere"> = {
      snapshots: [],
      frames: [],
    };
    const rows = () => [
      ...table.querySelectorAll<HTMLElement>("tbody tr[data-turbine-id]"),
    ];
    const idOf = (row: HTMLElement) => row.getAttribute("data-turbine-id")!;
    const snap = () => {
      const order = rows().map(idOf);
      const updated = rows()
        .filter((r) => r.hasAttribute("data-updated"))
        .map(idOf);
      const last = rec.snapshots.at(-1);
      if (
        last &&
        last.order.join() === order.join() &&
        last.updated.join() === updated.join()
      )
        return;
      rec.snapshots.push({ t: performance.now(), order, updated });
    };
    snap();
    new MutationObserver(snap).observe(table, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-updated"],
    });
    const sample = () => {
      const frame: FrameSample = {
        t: performance.now(),
        gliding: [],
        duration: null,
        offsets: {},
        flash: {},
        headerOffset:
          table.tHead!.rows[0].cells[0].getBoundingClientRect().top -
          region.getBoundingClientRect().top,
        headerOnTop: [...table.tHead!.rows[0].cells].every((cell) => {
          const r = cell.getBoundingClientRect();
          const top = document.elementFromPoint(
            r.left + r.width / 2,
            r.top + r.height / 2,
          );
          // A cell scrolled out of the region's width has nothing to hit.
          return (
            r.left + r.width / 2 > region.getBoundingClientRect().right ||
            !!top?.closest("thead")
          );
        }),
        scrollTop: region.scrollTop,
        screenTops: Object.fromEntries(
          rows().map((r) => [idOf(r), r.getBoundingClientRect().top]),
        ),
      };
      for (const row of rows()) {
        for (const animation of row.getAnimations()) {
          if ("animationName" in animation) {
            frame.flash[idOf(row)] = animation.currentTime as number;
          } else if (animation.playState === "running") {
            frame.gliding.push(idOf(row));
            frame.duration = animation.effect!.getTiming().duration as number;
            frame.offsets[idOf(row)] = new DOMMatrix(
              getComputedStyle(row).transform,
            ).m42;
          }
        }
      }
      if (frame.gliding.length || Object.keys(frame.flash).length)
        rec.frames.push(frame);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    const w = window as unknown as { e2eRecording: () => Recording };
    w.e2eRecording = () => ({ ...rec, tableStillThere: table.isConnected });
  });
}

const recording = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { e2eRecording: () => Recording }).e2eRecording(),
  );

const shownIds = (page: Page) =>
  page
    .getByTestId("turbines")
    .locator("tr[data-turbine-id]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-turbine-id")!));

const highlighted = (page: Page) =>
  page.getByTestId("turbines").locator("tr[data-updated]");

/** The distinct row orders the table went through, in order, with the time each began. */
function orders(rec: Recording): Snapshot[] {
  return rec.snapshots.filter(
    (s, i, all) => i === 0 || s.order.join() !== all[i - 1].order.join(),
  );
}

/** When a row first showed as highlighted. */
const firstHighlight = (rec: Recording, id: string) =>
  rec.snapshots.find((s) => s.updated.includes(id))!.t;

/** A fresh generated "database" for the GEN fleet, which a test may change between waves. */
const generatedServer = () => generated(FARM, IDS);

async function openTable(
  page: Page,
  server: MockTurbine[] = generatedServer(),
): Promise<(readings: ReturnType<typeof reading>[]) => Promise<void>> {
  await page.clock.setFixedTime(SEED_NOW);
  await mockTurbines(page, server);
  const send = await mockStream(page);
  await logIn(page, "viewer");
  await mainNav(page).getByRole("link", { name: "Turbines" }).click();
  await expect(page).toHaveURL(/\/turbines$/);
  await expect.poll(() => shownIds(page)).toEqual(IDS);
  await record(page);
  return send;
}

const BURST = ["GEN20", "GEN07", "GEN15", "GEN03", "GEN11"];
/** BURST's readings, newest first in the order given; every one newer than the whole fleet. */
const burstReadings = () => BURST.map((id, i) => reading(id, 60 + i * 10));
/** The order once they count: the burst first, newest first, then the rest by id. */
const AFTER_BURST = [...BURST, ...IDS.filter((id) => !BURST.includes(id))];

/** Sends `readings` and returns the page clock reading (performance.now) just before. */
async function sendTimed(
  page: Page,
  send: (readings: ReturnType<typeof reading>[]) => Promise<void>,
  readings: ReturnType<typeof reading>[],
): Promise<number> {
  const sent = await page.evaluate(() => performance.now());
  await send(readings);
  return sent;
}

test.describe("Turbines table: live updates", () => {
  test("a burst is applied in one update a second after it arrives: rows highlight together for 2 s and move once", async ({
    page,
  }) => {
    const send = await openTable(page);
    const sent = await sendTimed(page, send, burstReadings());

    await expect(highlighted(page)).toHaveCount(BURST.length);
    await expect.poll(() => shownIds(page)).toEqual(AFTER_BURST);
    await expect(highlighted(page)).toHaveCount(0);

    const rec = await recording(page);
    const lit = rec.snapshots.find((s) => s.updated.length)!;
    expect([...lit.updated].sort()).toEqual([...BURST].sort());
    // Nothing else was ever highlighted.
    expect(new Set(rec.snapshots.flatMap((s) => s.updated))).toEqual(
      new Set(BURST),
    );

    // Exactly one re-order: the old order, then the new one, a batch (1 s) after the readings.
    const seen = orders(rec);
    expect(seen.map((s) => s.order)).toEqual([IDS, AFTER_BURST]);
    const held = seen[1].t - sent;
    test
      .info()
      .annotations.push({
        type: "applied-after-ms",
        description: held.toFixed(0),
      });
    expect(held).toBeGreaterThanOrEqual(LIVE_BATCH_MS - EARLY_MS);
    expect(held).toBeLessThan(LIVE_BATCH_MS + 1500);

    // The highlight ends together, FLASH_MS after it began.
    const cleared = rec.snapshots.find(
      (s) => s.t > lit.t && !s.updated.length,
    )!;
    const flash = cleared.t - lit.t;
    test
      .info()
      .annotations.push({
        type: "highlight-ms",
        description: flash.toFixed(0),
      });
    expect(flash).toBeGreaterThanOrEqual(FLASH_MS - EARLY_MS);
    expect(flash).toBeLessThan(FLASH_MS + 1000);
  });

  test("a moved row’s highlight carries on where it was, instead of starting over", async ({
    page,
  }) => {
    const send = await openTable(page);
    await send(burstReadings());
    await expect.poll(() => shownIds(page)).toEqual(AFTER_BURST);
    await expect(highlighted(page)).toHaveCount(0);

    const { frames } = await recording(page);
    for (const id of BURST) {
      const times = frames
        .map((f) => f.flash[id])
        .filter((t) => t !== undefined);
      expect(times.length, `${id}: flash frames`).toBeGreaterThan(10);
      for (let i = 1; i < times.length; i++) {
        expect(times[i], `${id}: flash time goes on`).toBeGreaterThanOrEqual(
          times[i - 1],
        );
      }
    }
  });

  test("readings in waves are applied a second after each wave", async ({
    page,
  }) => {
    const server = generatedServer();
    const send = await openTable(page, server);
    await send([reading("GEN20", 60)]);
    await expect(highlighted(page)).toHaveCount(1);
    // The server has stored it by now: the page fetched again with the next stream open sees it.
    server.find((t) => t.id === "GEN20")!.latest = reading("GEN20", 60);
    await send([reading("GEN19", 50)]);
    await expect(highlighted(page)).toHaveCount(2);
    server.find((t) => t.id === "GEN19")!.latest = reading("GEN19", 50);

    await expect
      .poll(() => shownIds(page))
      .toEqual(["GEN19", "GEN20", ...IDS.slice(0, 18)]);
  });

  test("a reading for a turbine that is not on the page changes nothing", async ({
    page,
  }) => {
    const send = await openTable(page);
    const before = await shownIds(page);

    // GEN99 is not on the page, GEN20 is: when GEN20's update lands, GEN99's batch has too.
    await send([reading("GEN99", 30), reading("GEN20", 60)]);
    await expect(highlighted(page)).toHaveCount(1);
    await expect(page.locator('tr[data-turbine-id="GEN99"]')).toHaveCount(0);
    expect(await shownIds(page)).toHaveLength(before.length);
  });

  test("the rows glide for 500 ms under a header that stays stuck and on top", async ({
    page,
  }) => {
    // Short enough for the 20 rows to scroll under the header.
    await page.setViewportSize({ width: 1600, height: 620 });
    const send = await openTable(page);
    const region = page.getByTestId("turbines-scroll");
    await region.evaluate((el) => (el.scrollTop = 120));
    await expect.poll(() => region.evaluate((el) => el.scrollTop)).toBe(120);

    // Opaque cells: gliding rows mustn't show through the sticky header.
    const alpha = await page.getByTestId("sort-id").evaluate((th) => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.fillStyle = getComputedStyle(th).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      return ctx.getImageData(0, 0, 1, 1).data[3];
    });
    expect(alpha, "header cell background alpha").toBe(255);

    await send(burstReadings());
    await expect.poll(() => shownIds(page)).toEqual(AFTER_BURST);
    await expect(highlighted(page)).toHaveCount(0);

    const { frames } = await recording(page);
    const gliding = frames.filter((f) => f.gliding.length);
    test.info().annotations.push({
      type: "glide-frames",
      description: `${gliding.length} frames, ${(gliding.at(-1)!.t - gliding[0].t).toFixed(0)} ms, ${Math.max(...gliding.map((f) => f.gliding.length))} rows`,
    });
    expect(gliding.length, "frames sampled during the glide").toBeGreaterThan(
      3,
    );
    expect(gliding[0].duration).toBe(ROW_GLIDE_MS);
    expect(gliding.at(-1)!.t - gliding[0].t).toBeGreaterThan(ROW_GLIDE_MS / 2);
    expect(gliding.at(-1)!.t - gliding[0].t).toBeLessThan(ROW_GLIDE_MS + 250);

    // A row that went up started from below and came in steadily.
    const moved = gliding
      .map((f) => f.offsets.GEN20)
      .filter((y) => y !== undefined);
    expect(moved[0]).toBeGreaterThan(moved.at(-1)!);
    expect(moved.at(-1)!).toBeGreaterThanOrEqual(0);

    for (const frame of gliding) {
      expect(
        Math.abs(frame.headerOffset),
        "header stuck to the top of the region",
      ).toBeLessThan(1);
      expect(frame.headerOnTop, "nothing painted over the header").toBe(true);
    }
  });

  /** Each row's jump on screen between the last frame before the glide and the first of it, px. */
  function jumps(frames: FrameSample[]): Record<string, number> {
    const start = frames.findIndex((f) => f.gliding.length);
    const [before, first] = [frames[start - 1], frames[start]];
    return Object.fromEntries(
      Object.keys(first.screenTops).map((id) => [
        id,
        Math.abs(first.screenTops[id] - before.screenTops[id]),
      ]),
    );
  }

  test("at the top of the table every row glides from exactly where it was", async ({
    page,
  }) => {
    const send = await openTable(page);
    await send(burstReadings());
    await expect.poll(() => shownIds(page)).toEqual(AFTER_BURST);
    await expect(highlighted(page)).toHaveCount(0);

    const moved = jumps((await recording(page)).frames);
    expect(Object.keys(moved)).toHaveLength(IDS.length);
    for (const [id, jump] of Object.entries(moved)) {
      expect(jump, `${id}: jump at the start of the glide`).toBeLessThanOrEqual(
        1,
      );
    }
  });

  test("scrolled down, every row glides from exactly where it was", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 620 });
    const send = await openTable(page);
    const region = page.getByTestId("turbines-scroll");
    await region.evaluate((el) => (el.scrollTop = 120));
    await expect.poll(() => region.evaluate((el) => el.scrollTop)).toBe(120);

    await send(burstReadings());
    await expect.poll(() => shownIds(page)).toEqual(AFTER_BURST);
    await expect(highlighted(page)).toHaveCount(0);

    const { frames } = await recording(page);
    const moved = jumps(frames);
    test.info().annotations.push({
      type: "scrolled-glide",
      description: `scrollTop ${frames[0].scrollTop} → ${frames.at(-1)!.scrollTop}, jump ${Math.max(...Object.values(moved))} px`,
    });
    expect(
      Math.max(...Object.values(moved)),
      "largest jump at the start of the glide",
    ).toBeLessThanOrEqual(1);
  });

  test("with reduced motion the order still changes once, without a glide", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const send = await openTable(page);
    await send(burstReadings());
    await expect.poll(() => shownIds(page)).toEqual(AFTER_BURST);
    await expect(highlighted(page)).toHaveCount(0);

    const rec = await recording(page);
    expect(orders(rec).map((s) => s.order)).toEqual([IDS, AFTER_BURST]);
    expect(rec.frames.filter((f) => f.gliding.length)).toEqual([]);
  });

  test("a sort before the batch applies the server’s order at once with no glide, and the batch then leaves it", async ({
    page,
  }) => {
    const send = await openTable(page);
    await send(burstReadings());
    // Within the second before the batch: sort by turbine id, descending (the server sorts).
    await page.getByTestId("sort-id").click();
    await page.getByTestId("sort-id").click();
    await expect(page.getByTestId("sort-id")).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    const expected = [...IDS].reverse();
    await expect.poll(() => shownIds(page)).toEqual(expected);
    // The batch still updates the cells and highlights, but id order is not a live sort.
    await expect(highlighted(page)).toHaveCount(BURST.length);
    await expect(highlighted(page)).toHaveCount(0);

    const rec = await recording(page);
    expect(
      orders(rec)
        .map((s) => s.order)
        .at(-1),
    ).toEqual(expected);
    expect(rec.frames.filter((f) => f.gliding.length)).toEqual([]);
  });

  test("a filter changes the page; the batch then re-orders the rows still on it", async ({
    page,
  }) => {
    const send = await openTable(page);
    await send(burstReadings());
    await page.getByTestId("turbine-filter").fill("GEN1");
    // GEN15 and GEN11 lead once their readings are applied; the others of GEN1x keep their order.
    const expected = [
      "GEN15",
      "GEN11",
      ...IDS.filter((id) => /^GEN1/.test(id) && !BURST.includes(id)),
    ];
    await expect.poll(() => shownIds(page)).toEqual(expected);
    await expect(highlighted(page)).toHaveCount(0);
  });

  test("going to another farm shows its rows at once, with no glide and none of the other farm’s", async ({
    page,
  }) => {
    const first = ["AAA1", "AAA2", "AAA3"];
    const second = ["BBB1", "BBB2", "BBB3"];
    await page.clock.setFixedTime(SEED_NOW);
    await mockFleet(page, { FARM01: first, FARM02: second });
    const send = await mockStream(page);
    await logIn(page, "viewer");
    const farms = page.getByTestId("farms");
    // History: FARM01, the list, FARM02. Going back two pages only changes the farm in the URL.
    await farms.getByRole("link", { name: "Prairie Ridge" }).click();
    await expect(page).toHaveURL(/\/farms\/FARM01$/);
    await mainNav(page).getByRole("link", { name: "Farms" }).click();
    await farms.getByRole("link", { name: "High Plains" }).click();
    await expect(page).toHaveURL(/\/farms\/FARM02$/);
    await expect.poll(() => shownIds(page)).toEqual(second);
    await record(page);

    await send([reading("BBB3", 60, "FARM02")]);
    await expect(highlighted(page)).toHaveCount(1);
    await page.evaluate(() => history.go(-2));
    await expect(page).toHaveURL(/\/farms\/FARM01$/);
    await expect.poll(() => shownIds(page)).toEqual(first);
    await expect
      .poll(async () => (await recording(page)).snapshots.at(-1)!.updated)
      .toEqual([]);

    const rec = await recording(page);
    // The same table stayed on the page: this was its farm changing, not a new one.
    expect(rec.tableStillThere).toBe(true);
    expect(orders(rec).map((s) => s.order)).toEqual([second, first]);
    expect(rec.frames.filter((f) => f.gliding.length)).toEqual([]);
  });
});
