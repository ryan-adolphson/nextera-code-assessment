import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Subject, map, of, throwError } from 'rxjs';
import { TurbinePageResponse } from './fleet.model';
import { largeFleetFixture, mixedFleetFixture, openFleet, settle } from './testing';

/**
 * The turbines table's own states (count, loading, error, sort availability) on /turbines and a
 * farm page, with the mixed fleet at 2026-01-03T00:00Z. Sorting, filtering, paging and live
 * updates are in turbine-list, farm-page, turbine-table-live and turbine-table-commissioned.
 */
describe('TurbineTable states', () => {
  const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
  let app: Awaited<ReturnType<typeof openFleet>>;

  type FakeApi = Awaited<ReturnType<typeof openFleet>>['api'];
  const emptyPage = (overrides: Partial<TurbinePageResponse> = {}): TurbinePageResponse => ({
    items: [],
    nextCursor: null,
    prevCursor: null,
    total: 0,
    totalCapped: false,
    ...overrides,
  });

  /** Opens `url`; `before` sets the fake API's answer for the page request. */
  async function open(
    url: string,
    before?: (api: FakeApi) => void,
    farms = mixedFleetFixture(),
    role: 'viewer' | 'admin' = 'viewer',
  ) {
    app = await openFleet(
      url,
      () => CLOCK,
      farms,
      ({ api }) => before?.(api),
      role,
    );
  }
  afterEach(() => app.http.verify());

  const q = (id: string) => app.root().querySelector<HTMLElement>(`[data-testid=${id}]`);
  const count = () => app.text(q('turbine-count'));

  describe('while the first page loads', () => {
    it('says "Loading turbines…" in the count and the table, then the page replaces both', async () => {
      const first = new Subject<TurbinePageResponse>();
      let held!: FakeApi;
      // The page request is a pending task, so the harness cannot become stable until it is
      // answered: look at the page from the document meanwhile.
      const opening = open('/turbines', (api) => {
        held = api;
        api.turbines.mockReturnValue(first);
      });
      await vi.waitFor(() => expect(held?.turbines).toHaveBeenCalled());
      const inDocument = (id: string) =>
        document
          .querySelector<HTMLElement>(`[data-testid=${id}]`)
          ?.textContent?.replace(/\s+/g, ' ')
          .trim();

      expect(inDocument('turbine-count')).toBe('Loading turbines…');
      expect(inDocument('turbines-loading')).toBe('Loading turbines…');
      expect(document.querySelector('[data-testid=turbines]')!.getAttribute('aria-busy')).toBe(
        'true',
      );
      expect(document.querySelector('[data-testid=turbines-error]')).toBeNull();

      first.next(emptyPage({ total: 0 }));
      first.complete();
      await opening;
      await settle(app.harness.fixture);

      expect(count()).toBe('0 of 0 turbines');
      expect(q('turbines-loading')).toBeNull();
      expect(q('no-matches')!.textContent).toContain('No turbines match the filters.');
    });
  });

  describe('the count', () => {
    it('reads "N of total turbines" with the rows on the page and the server\'s total', async () => {
      await open('/turbines', undefined, largeFleetFixture(30));
      await settle(app.harness.fixture);

      expect(count()).toBe('25 of 30 turbines');
      expect(q('turbine-count')!.getAttribute('role')).toBe('status');
    });

    it('says "10,000+" when the server counted only up to its cap', async () => {
      await open(
        '/turbines',
        (api) => {
          const original = api.turbines.getMockImplementation()!;
          api.turbines.mockImplementation((query) =>
            original(query).pipe(map((page) => ({ ...page, total: 10_001, totalCapped: true }))),
          );
        },
        largeFleetFixture(30),
      );
      await settle(app.harness.fixture);

      expect(count()).toBe('25 of 10,000+ turbines');
      expect(app.text(app.root().querySelector('.mat-mdc-paginator-range-label'))).toBe(
        '1 – 25 of 10,000+',
      );
    });

    it('says "Turbines unavailable" when the first page failed', async () => {
      await open('/turbines', (api) =>
        api.turbines.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 500 }))),
      );
      await settle(app.harness.fixture);

      expect(count()).toBe('Turbines unavailable');
    });
  });

  describe('the empty table', () => {
    it('says why no turbine matches, only once a page has answered', async () => {
      await open('/turbines', (api) => api.turbines.mockReturnValue(of(emptyPage())));
      await settle(app.harness.fixture);

      expect(q('turbines-loading')).toBeNull();
      expect(app.text(q('no-matches'))).toBe(
        'No turbines match the filters. Turbines with no readings yet are hidden: turn off “Hide turbines with no data” to show them.',
      );
    });
  });

  describe('when the page cannot be loaded', () => {
    it('shows an alert with Retry, no empty message, and loads again on Retry', async () => {
      await open('/turbines', (api) =>
        api.turbines.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 500 }))),
      );
      await settle(app.harness.fixture);

      const error = q('turbines-error')!;
      expect(error.getAttribute('role')).toBe('alert');
      expect(app.text(error)).toContain('The turbines could not be loaded.');
      expect(q('turbines-loading')).toBeNull(); // not "loading", not "no matches"
      expect(
        app.root().querySelector('[data-testid=turbines] tbody tr[data-turbine-id]'),
      ).toBeNull();
      expect(q('no-matches')!.textContent!.trim()).toBe('');

      app.api.turbines.mockReset();
      app.api.turbines.mockReturnValue(of(emptyPage({ total: 0 })));
      q('turbines-retry')!.click();
      await settle(app.harness.fixture);

      expect(app.api.turbines).toHaveBeenCalledOnce();
      expect(q('turbines-error')).toBeNull();
      expect(count()).toBe('0 of 0 turbines');
    });

    it('keeps the rows it has when a later request fails', async () => {
      await open('/turbines');
      await settle(app.harness.fixture);
      const rows = () =>
        app.root().querySelectorAll('[data-testid=turbines] tbody tr[data-turbine-id]');
      expect(rows()).toHaveLength(6);

      app.api.turbines.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 503 })));
      app.sse.status('open'); // the page is fetched again
      await settle(app.harness.fixture);

      expect(q('turbines-error')).not.toBeNull();
      expect(rows()).toHaveLength(6);
      expect(count()).toBe('6 of 6 turbines');
    });
  });

  describe('sorting by power, wind and gearbox', () => {
    const metrics = ['power', 'wind', 'gearbox'];
    const header = (key: string) => q(`sort-${key}`)!;

    it('is disabled across the whole fleet, with the reason for everyone', async () => {
      await open('/turbines');
      await settle(app.harness.fixture);

      for (const key of metrics) {
        expect(header(key).classList).toContain('mat-sort-header-disabled');
        expect(header(key).getAttribute('title')).toBe('Open a farm to sort by this value');
        expect(header(key).querySelector('.sr-only')!.textContent).toBe(
          ', sorting is not available across the whole fleet; open a farm',
        );
      }
      expect(app.text(q('metric-sort-hint'))).toBe(
        "Power, wind and gearbox can be sorted on a farm's page. Here the list sorts by turbine, farm, commissioning or last reading.",
      );
      // Turbine, farm, commissioned and last reading stay sortable.
      for (const key of ['id', 'farm', 'commissioned', 'time']) {
        expect(header(key).classList).not.toContain('mat-sort-header-disabled');
      }
    });

    it('is enabled on a farm page, which has no hint and no extra header text', async () => {
      await open('/farms/FARM02');
      await settle(app.harness.fixture);

      for (const key of metrics) {
        expect(header(key).classList).not.toContain('mat-sort-header-disabled');
        expect(header(key).hasAttribute('title')).toBe(false);
        expect(header(key).querySelector('.sr-only')).toBeNull();
      }
      expect(q('metric-sort-hint')).toBeNull();
    });

    it('does not sort when a disabled header is clicked', async () => {
      await open('/turbines');
      await settle(app.harness.fixture);
      const sent = app.api.turbines.mock.calls.length;

      header('power').click();
      await settle(app.harness.fixture);

      expect(app.api.turbines.mock.calls.length).toBe(sent);
      expect(header('time').getAttribute('aria-sort')).toBe('descending');
    });
  });
});
