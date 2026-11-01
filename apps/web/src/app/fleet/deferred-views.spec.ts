import {
  DeferBlockBehavior,
  DeferBlockFixture,
  DeferBlockState,
  TestBed,
} from '@angular/core/testing';
import { of } from 'rxjs';
import { Telemetry } from './fleet.model';
import { openFleet, reading } from './testing';

/**
 * The `@defer` blocks of the fleet pages, driven by hand (DeferBlockBehavior.Manual): the Leaflet
 * maps (overview, farm page) and the turbine page's ECharts chart group start as same-size
 * placeholders while the rest of the page (tiles, tables) is already there, then render the real
 * content; the loading and error states say so. Playthrough (the default) is covered by the page
 * specs, where the blocks render on their own.
 */
describe('Deferred views (@defer)', () => {
  const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
  let app: Awaited<ReturnType<typeof openFleet>>;

  async function open(url: string, history: Telemetry[] = []) {
    app = await openFleet(
      url,
      () => CLOCK,
      undefined,
      ({ api }) => api.telemetry.mockReturnValue(of(history)),
      'admin',
      { deferBlockBehavior: DeferBlockBehavior.Manual },
    );
    await app.stable(); // the placeholders render
  }
  /** The page's only defer block. */
  async function block(): Promise<DeferBlockFixture> {
    const blocks = await app.harness.fixture.getDeferBlocks();
    expect(blocks).toHaveLength(1);
    return blocks[0];
  }
  const q = (testId: string) => app.root().querySelector<HTMLElement>(`[data-testid=${testId}]`);
  const all = (selector: string) => [...app.root().querySelectorAll<HTMLElement>(selector)];

  describe('fleet overview map (on viewport, prefetch on idle)', () => {
    beforeEach(() => open('/farms'));

    it('keeps the map frame and legend row free until Leaflet has loaded, then shows the markers', async () => {
      const placeholder = q('map-placeholder')!;
      expect(placeholder).not.toBeNull();
      expect(placeholder.hasAttribute('data-legend')).toBe(true); // the overview has a legend
      expect(placeholder.querySelector('[role]')).toBeNull(); // silent until it loads
      expect(all('app-map-view')).toHaveLength(0);
      expect(all('.leaflet-container')).toHaveLength(0);
      // The rest of the page doesn't wait for the map.
      expect(all('[data-testid=farms] tbody tr')).toHaveLength(3);

      await (await block()).render(DeferBlockState.Complete);
      await app.stable();

      expect(q('map-placeholder')).toBeNull();
      expect(all('app-map-view')).toHaveLength(1);
      expect(all('.map-marker')).toHaveLength(3);
      expect(q('legend')).not.toBeNull();
    });

    it('says the map is loading, and asks for a reload if its chunk fails', async () => {
      const map = await block();

      await map.render(DeferBlockState.Loading);
      await app.stable();
      const loading = q('map-loading')!;
      expect(app.text(loading)).toBe('Loading map…');
      expect(loading.querySelector('[role=status]')).not.toBeNull();

      await map.render(DeferBlockState.Error);
      await app.stable();
      const error = q('map-load-error')!;
      expect(app.text(error)).toBe('The map could not be loaded. Reload the page to try again.');
      expect(error.querySelector('[role=alert]')).not.toBeNull();
      expect(all('[data-testid=farms] tbody tr')).toHaveLength(3); // the table is still the way in
    });
  });

  describe('farm page map (on viewport, prefetch on idle)', () => {
    it("reserves the map and its legend row, then shows the farm's turbines", async () => {
      await open('/farms/FARM01');
      expect(q('map-placeholder')!.hasAttribute('data-legend')).toBe(true);
      expect(all('.leaflet-container')).toHaveLength(0);
      expect(q('turbines')).not.toBeNull(); // the turbines table is not deferred

      await (await block()).render(DeferBlockState.Complete);
      await app.stable();

      expect(q('map-placeholder')).toBeNull();
      expect(all('.map-marker').map((m) => m.getAttribute('data-marker-id'))).toEqual(['TURB001']);
    });

    it('reserves no legend row for a farm without turbines (its map has none)', async () => {
      await open('/farms/FARM03');
      expect(q('map-placeholder')!.hasAttribute('data-legend')).toBe(false);
      expect(q('no-turbines')).not.toBeNull();
    });
  });

  describe('turbine page charts (on idle, prefetch on immediate)', () => {
    const history = Array.from({ length: 3 }, (_, i) =>
      reading({
        id: `r${i}`,
        timestamp: new Date(Date.parse('2026-01-02T23:55:00Z') - i * 300_000).toISOString(),
      }),
    );
    const URL = '/farms/FARM01/turbines/TURB001';

    it('shows a card per chart at the charts’ size while ECharts loads, and the readings at once', async () => {
      await open(URL, history);

      const cards = all('[data-testid=chart-skeleton-card]');
      expect(cards.map((c) => app.text(c))).toEqual([
        'Power output',
        'Wind speed',
        'Rotor speed',
        'Blade pitch',
        'Gearbox temperature',
        'Alert rules triggered',
      ]);
      expect(q('charts-loading')).toBeNull(); // the placeholder is silent
      expect(all('app-line-chart')).toHaveLength(0);
      // Not deferred: header, range and readings table.
      expect(q('range')).not.toBeNull();
      expect(all('[data-testid=history] tbody tr')).toHaveLength(3);

      await (await block()).render(DeferBlockState.Complete);
      await app.stable();

      expect(q('chart-skeleton')).toBeNull();
      expect(all('app-line-chart').map((c) => c.getAttribute('data-metric'))).toEqual([
        'powerOutputKw',
        'windSpeedMs',
        'rotorRpm',
        'bladePitchDeg',
        'gearboxTempC',
        'alerts',
      ]);
      expect(app.text(q('weather-heading'))).toBe('Weather at Prairie Ridge');
    });

    it('announces the loading state, and the error state keeps the readings', async () => {
      await open(URL, history);
      const charts = await block();

      await charts.render(DeferBlockState.Loading);
      await app.stable();
      expect(app.text(q('charts-loading'))).toBe('Loading charts…');
      expect(q('charts-loading')!.getAttribute('role')).toBe('status');
      expect(all('[data-testid=chart-skeleton-card]')).toHaveLength(6);

      await charts.render(DeferBlockState.Error);
      await app.stable();
      expect(q('charts-load-error')!.getAttribute('role')).toBe('alert');
      expect(app.text(q('charts-load-error'))).toBe(
        'The charts could not be loaded. Reload the page to try again; the readings are below.',
      );
      expect(all('[data-testid=history] tbody tr')).toHaveLength(3);
    });

    it('shows no skeleton for an empty window (the empty-window message instead)', async () => {
      await open(URL, []);
      expect(q('empty-window')).not.toBeNull();
      expect(q('chart-skeleton')).toBeNull();

      await (await block()).render(DeferBlockState.Complete);
      await app.stable();
      expect(all('app-line-chart')).toHaveLength(0);
    });
  });
});
