import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { MatPaginatorHarness } from '@angular/material/paginator/testing';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { FarmSummaryResponse, FleetSummaryResponse } from './fleet.model';
import { FarmOverview, farmsFixture, openFleet } from './testing';

/** A farm without turbines: one table row, no readings. */
const emptyFarm = (n: number): FarmOverview => ({
  id: `FARM${String(n).padStart(3, '0')}`,
  name: `Farm ${n}`,
  latitude: 40,
  longitude: -100,
  turbines: [],
});

/** The fleet overview's farm table (filter, count, pages) and its "as of" labels. */
describe('FleetOverview (/farms)', () => {
  const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
  let app: Awaited<ReturnType<typeof openFleet>>;

  async function open(farms: FarmOverview[] = farmsFixture()) {
    app = await openFleet('/farms', () => CLOCK, farms, undefined, 'viewer');
    await app.stable();
  }

  const q = (id: string) => app.root().querySelector<HTMLElement>(`[data-testid=${id}]`);
  const rowIds = () =>
    [...app.root().querySelectorAll('[data-testid=farms] tbody tr [data-testid=farm-pill]')].map(
      (pill) => pill.textContent?.trim(),
    );
  const input = () => q('farm-filter') as HTMLInputElement;
  async function filter(value: string) {
    input().value = value;
    input().dispatchEvent(new Event('input'));
    await app.stable();
  }
  const paginator = () =>
    TestbedHarnessEnvironment.loader(app.harness.fixture).getHarness(
      MatPaginatorHarness.with({ selector: '[data-testid=farms-paginator]' }),
    );

  describe('farm filter', () => {
    it('filters by name or id, case-insensitively, with the count of matches', async () => {
      await open();
      expect(app.text(q('farm-count'))).toBe('3 of 3 farms');

      await filter('high');
      expect(rowIds()).toEqual(['FARM02']);
      expect(app.text(q('farm-count'))).toBe('1 of 3 farms');

      await filter(' farm03 ');
      expect(rowIds()).toEqual(['FARM03']);

      await filter('');
      expect(rowIds()).toEqual(['FARM01', 'FARM02', 'FARM03']);
    });

    it('says which text matched nothing, and says "No farms yet." without any', async () => {
      await open();
      await filter('zzz');
      expect(app.text(q('no-farms'))).toBe('No farms match “zzz”.');
      expect(app.text(q('farm-count'))).toBe('0 of 3 farms');
      TestBed.resetTestingModule();

      await open([]);
      expect(app.text(q('no-farms'))).toBe('No farms yet.');
      expect(app.text(q('farm-count'))).toBe('0 of 0 farms');
    });

    it('has a clear button only while there is text, and it returns the focus to the field', async () => {
      await open();
      expect(q('farm-filter-clear')).toBeNull();

      await filter('prairie');
      const clear = q('farm-filter-clear') as HTMLButtonElement;
      expect(clear.getAttribute('aria-label')).toBe('Clear farm filter');
      clear.click();
      await app.stable();

      expect(input().value).toBe('');
      expect(rowIds()).toHaveLength(3);
      expect(document.activeElement).toBe(input());
      expect(q('farm-filter-clear')).toBeNull();
    });

    it('does not filter the map: it always shows every farm', async () => {
      await open();
      await filter('prairie');

      expect(app.root().querySelectorAll('.map-marker')).toHaveLength(3);
    });
  });

  describe('paging a long farm list', () => {
    const farms = () => Array.from({ length: 30 }, (_, i) => emptyFarm(i + 1));

    it('shows 25 farms a page, and no paginator when they all fit', async () => {
      await open();
      expect(q('farms-paginator')).toBeNull();
      TestBed.resetTestingModule();

      await open(farms());
      const pages = await paginator();
      expect(rowIds()).toHaveLength(25);
      expect(await pages.getRangeLabel()).toBe('1 – 25 of 30');
      await pages.goToNextPage();
      expect(rowIds()).toEqual(['FARM026', 'FARM027', 'FARM028', 'FARM029', 'FARM030']);
    });

    it('goes back to the first page when the filter changes', async () => {
      await open(farms());
      const pages = await paginator();
      await pages.goToNextPage();
      expect(await pages.getRangeLabel()).toBe('26 – 30 of 30');

      await filter('Farm'); // every farm still matches: without a reset this would stay on page two
      expect(await pages.getRangeLabel()).toBe('1 – 25 of 30');
      expect(rowIds()[0]).toBe('FARM001');
    });

    it('goes back to the first page when the filter is cleared with its button', async () => {
      await open(farms());
      await filter('Farm');
      const pages = await paginator();
      await pages.goToNextPage();
      expect(await pages.getRangeLabel()).toBe('26 – 30 of 30');

      (q('farm-filter-clear') as HTMLButtonElement).click();
      await app.stable();

      expect(await pages.getRangeLabel()).toBe('1 – 25 of 30');
    });

    it('hides the paginator once the filter leaves one page', async () => {
      await open(farms());

      await filter('Farm 2'); // Farm 2 and Farm 20-29

      expect(rowIds()).toHaveLength(11);
      expect(q('farms-paginator')).toBeNull();
    });
  });

  describe('data as of', () => {
    it('dates the fleet figures by the summary, in the zone shown', async () => {
      await open();

      expect(app.text(q('fleet-as-of'))).toBe('Jan 2, 23:55 UTC');
    });

    it('shows no time before the first summary has one', async () => {
      app = await openFleet(
        '/farms',
        () => CLOCK,
        farmsFixture(),
        ({ api }) =>
          api.fleetSummary.mockReturnValue(
            of({
              farms: 0,
              turbines: 0,
              commissioned: 0,
              reporting: 0,
              stale: 0,
              alerting: 0,
              powerOutputKw: 0,
              asOf: null,
            } satisfies FleetSummaryResponse),
          ),
      );
      await app.stable();

      expect(app.text(q('fleet-as-of'))).toBe('');
    });

    it('says the figures refresh about once a minute', async () => {
      await open();

      expect(app.text(q('fleet-refresh-note'))).toBe(
        'Fleet and farm figures refresh about once a minute. Open a farm or turbine for live readings.',
      );
    });

    it('gives each farm its own "As of" time', async () => {
      app = await openFleet(
        '/farms',
        () => CLOCK,
        farmsFixture(),
        ({ api }) =>
          api.farmSummaries.mockReturnValue(
            of([
              {
                id: 'FARM01',
                name: 'Prairie Ridge',
                latitude: 41.25,
                longitude: -96.53,
                turbineCount: 1,
                commissioned: 1,
                reporting: 1,
                stale: 0,
                alerting: 0,
                powerOutputKw: 1960.5,
                windSpeedMs: 6.7,
                asOf: '2026-01-02T23:40:00.000Z',
              },
              {
                id: 'FARM02',
                name: 'High Plains',
                latitude: 39.75,
                longitude: -101.22,
                turbineCount: 0,
                commissioned: 0,
                reporting: 0,
                stale: 0,
                alerting: 0,
                powerOutputKw: 0,
                windSpeedMs: null,
                asOf: null,
              },
            ] satisfies FarmSummaryResponse[]),
          ),
      );
      await app.stable();

      const headers = [...app.root().querySelectorAll('[data-testid=farms] thead th')].map((th) =>
        app.text(th),
      );
      expect(headers.at(-1)).toBe('As of');
      const asOf = [...app.root().querySelectorAll('[data-testid=farms] tbody tr')].map((row) =>
        app.text(row.querySelector('td:last-child')),
      );
      expect(asOf).toEqual(['23:40', '']);
    });

    it('refreshes the figures on fleet.tick, and the "as of" with them', async () => {
      await open();
      app.api.fleetSummary.mockReturnValue(
        of({
          farms: 3,
          turbines: 2,
          commissioned: 1,
          reporting: 2,
          stale: 0,
          alerting: 0,
          powerOutputKw: 4300,
          asOf: '2026-01-03T00:00:00.000Z',
        }),
      );

      app.sse.tick();
      await app.stable();

      expect(app.text(q('fleet-as-of'))).toBe('Jan 3, 00:00 UTC');
      expect(app.text(q('fleet-power'))).toBe('4.3 MW');
    });
  });
});
