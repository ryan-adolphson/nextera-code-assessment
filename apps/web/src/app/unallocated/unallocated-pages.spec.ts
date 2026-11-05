import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { TimeZoneSettings } from '../core/time-zone';
import { MatAutocompleteHarness } from '@angular/material/autocomplete/testing';
import { MatMenuHarness } from '@angular/material/menu/testing';
import { Title } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { TEST_API_BASE_URL, farmsFixture, openFleet, reading } from '../fleet/testing';
import {
  HeldReading,
  UnallocatedResolution,
  UnallocatedStatus,
  UnallocatedTurbine,
} from './unallocated.model';

const URL = `${TEST_API_BASE_URL}/unallocated-turbines`;
const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
const at = (hhmm: string) => `2026-01-02T${hhmm}:00.000Z`;

const held = (overrides: Partial<HeldReading> = {}): HeldReading => ({
  turbineId: 'TURB990',
  farmId: 'FARM01',
  timestamp: at('23:55'),
  receivedAt: at('23:56'),
  powerOutputKw: 1234.56,
  windSpeedMs: 7.25,
  rotorRpm: 12,
  bladePitchDeg: 4,
  gearboxTempC: 81.04,
  ...overrides,
});

const FARM01 = { id: 'FARM01', name: 'Prairie Ridge' };
const FARM02 = { id: 'FARM02', name: 'High Plains' };

/** An unknown turbine claiming FARM01 (which exists), still reporting. */
const unknownTurbine = (overrides: Partial<UnallocatedTurbine> = {}): UnallocatedTurbine => ({
  id: 'e-unknown',
  turbineId: 'TURB990',
  kind: 'unknown_turbine',
  status: 'pending',
  reportedFarmId: 'FARM01',
  reportedFarm: FARM01,
  currentFarm: null,
  firstSeenAt: at('21:00'),
  lastSeenAt: at('23:56'),
  heldCount: 30,
  latest: held(),
  blockedAt: null,
  blockedBy: null,
  ...overrides,
});
/** TURB001 (in FARM01) reporting FARM02; quiet for 20 min. */
const mismatch = (overrides: Partial<UnallocatedTurbine> = {}): UnallocatedTurbine =>
  unknownTurbine({
    id: 'e-mismatch',
    turbineId: 'TURB001',
    kind: 'farm_mismatch',
    reportedFarmId: 'FARM02',
    reportedFarm: FARM02,
    currentFarm: FARM01,
    heldCount: 3,
    lastSeenAt: at('23:41'),
    latest: held({ turbineId: 'TURB001', farmId: 'FARM02', timestamp: at('23:40') }),
    ...overrides,
  });
/** TURB002 (in FARM02) reporting a farm that doesn't exist. */
const orphan = (): UnallocatedTurbine =>
  mismatch({
    id: 'e-orphan',
    turbineId: 'TURB002',
    reportedFarmId: 'FARM99',
    reportedFarm: null,
    currentFarm: FARM02,
    heldCount: 1,
    latest: null,
  });
const blocked = (overrides: Partial<UnallocatedTurbine> = {}): UnallocatedTurbine =>
  unknownTurbine({
    id: 'e-blocked',
    turbineId: 'TURB999',
    status: 'blocked',
    reportedFarmId: 'FARM05',
    reportedFarm: null,
    heldCount: 0,
    latest: null,
    blockedAt: at('10:15'),
    blockedBy: 'owner@nextera.local',
    ...overrides,
  });

const resolution = (overrides: Partial<UnallocatedResolution> = {}): UnallocatedResolution => ({
  action: 'assigned',
  id: 'e-unknown',
  turbine: { id: 'TURB990', farmId: 'FARM01', latitude: 41, longitude: -96, commissioned: false },
  imported: 30,
  duplicates: 0,
  ...overrides,
});

const conflict = (message: string) => ({
  body: { statusCode: 409, message },
  opts: { status: 409, statusText: 'Conflict' },
});
const notFound = (message: string) => ({
  body: { statusCode: 404, message },
  opts: { status: 404, statusText: 'Not Found' },
});

/** /unallocated/* through the real routes, with the real UnallocatedApi on HttpTestingController. */
describe('Unallocated turbines (/unallocated)', () => {
  let app: Awaited<ReturnType<typeof openFleet>>;
  afterEach(() => app.http.verify());

  async function open(
    path: string,
    entries: UnallocatedTurbine[],
    role: 'owner' | 'admin' = 'owner',
  ) {
    app = await openFleet(path, () => CLOCK, undefined, undefined, role);
    await flushList(path.includes('blocked') ? 'blocked' : 'pending', entries);
  }
  /** Rendered, incl. MatDialog's close (a task later) and a resource's answer (a microtask). */
  async function settle() {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
    TestBed.tick();
  }
  const listUrl = (status: UnallocatedStatus) => `${URL}?status=${status}`;
  async function flushList(status: UnallocatedStatus, entries: UnallocatedTurbine[]) {
    TestBed.tick(); // the resource sends its request on change detection
    app.http.expectOne({ method: 'GET', url: listUrl(status) }).flush(entries);
    await settle();
  }
  /** This test's page, then its open dialogs (in the CDK overlay container). */
  const q = <T extends Element = HTMLElement>(testId: string, within?: Element) =>
    within
      ? within.querySelector<T & HTMLElement>(`[data-testid=${testId}]`)
      : (app.root().querySelector<T & HTMLElement>(`[data-testid=${testId}]`) ??
        document.querySelector<T & HTMLElement>(`.cdk-overlay-container [data-testid=${testId}]`));
  const rows = () => [...app.root().querySelectorAll<HTMLElement>('[data-testid=unallocated-row]')];
  const row = (turbineId: string) =>
    app
      .root()
      .querySelector<HTMLElement>(`[data-testid=unallocated-row][data-turbine-id=${turbineId}]`)!;
  const cell = (r: Element, testId: string) => app.text(q(testId, r));
  const isOpen = (testId: string) => q(testId) !== null;
  async function click(testId: string, within?: Element) {
    q(testId, within)!.click();
    await settle();
  }
  async function type(testId: string, value: string) {
    const input = q<HTMLInputElement>(testId)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  }
  async function submit(testId: string) {
    q(testId)!.closest('form')!.requestSubmit();
    await settle();
  }
  async function pressEscape() {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    Object.defineProperty(event, 'keyCode', { get: () => 27 });
    (document.activeElement ?? document.body).dispatchEvent(event);
    await settle();
  }
  const expectPost = (id: string, action: string): TestRequest =>
    app.http.expectOne({ method: 'POST', url: `${URL}/${id}/${action}` });
  const notice = () => app.text(q('unallocated-notice')) ?? '';
  /** A row's "More actions" menu (its items render in the overlay container while open). */
  const moreActions = (turbineId: string) =>
    TestbedHarnessEnvironment.loader(app.harness.fixture).getHarness(
      MatMenuHarness.with({
        selector: `[data-testid=more-actions][aria-label="More actions for ${turbineId}"]`,
      }),
    );
  /** Opens a row's menu and chooses the item with this test id (Move, Block). */
  async function chooseAction(turbineId: string, testId: 'move' | 'block') {
    const menu = await moreActions(turbineId);
    await menu.open();
    const [item] = await menu.getItems({ selector: `[data-testid=${testId}]` });
    await item.click();
    await settle();
  }

  describe('Pending', () => {
    it('lists each held turbine: problem, farms, when seen and held readings', async () => {
      await open('/unallocated', [unknownTurbine(), mismatch(), orphan()]);

      expect(TestBed.inject(Router).url).toBe('/unallocated/pending');
      expect(TestBed.inject(Title).getTitle()).toBe('Unallocated turbines · Nextera');
      expect(app.text(app.root().querySelector('h1'))).toBe('Unallocated turbines');
      expect(q('unallocated-tabs')!.getAttribute('role')).toBe('tablist');
      expect(q('unallocated-tabs')!.getAttribute('aria-label')).toBe('Unallocated');
      expect(q('unallocated-tab-pending')!.getAttribute('aria-selected')).toBe('true');
      expect(q('unallocated-tab-blocked')!.getAttribute('aria-selected')).toBe('false');
      expect(q('unallocated-tab-panel')!.contains(q('unallocated-count'))).toBe(true);
      expect(q('unallocated-tab-blocked')!.getAttribute('href')).toBe('/unallocated/blocked');
      expect(q('nav-unallocated')!.getAttribute('aria-current')).toBe('page');
      expect(app.text(q('unallocated-count'))).toBe('3 turbines pending');

      expect(rows().map((r) => r.dataset['turbineId'])).toEqual(['TURB990', 'TURB001', 'TURB002']);
      const [unknown, mis, orph] = rows();
      expect([cell(unknown, 'kind'), cell(mis, 'kind')]).toEqual([
        'Unknown turbine',
        'Farm mismatch',
      ]);
      expect(q('kind', unknown)!.dataset['kind']).toBe('unknown_turbine');
      expect(cell(unknown, 'reported-farm')).toBe('Prairie Ridge FARM01');
      expect(cell(orph, 'reported-farm')).toBe('Unknown farm FARM99');
      expect(q('reported-farm', orph)!.dataset['exists']).toBe('false');
      expect(cell(unknown, 'current-farm')).toBe('Not in the fleet');
      expect(cell(mis, 'current-farm')).toBe('Prairie Ridge FARM01');
      // Every id is a read-only Material chip; "Not in the fleet" has none.
      const pills = (row: HTMLElement) =>
        [...row.querySelectorAll('[data-testid=farm-pill]')].map((pill) => app.text(pill));
      expect(pills(unknown)).toEqual(['FARM01']);
      expect(pills(mis)).toEqual(['FARM02', 'FARM01']);
      expect(pills(orph)).toEqual(['FARM99', 'FARM02']);
      expect(q('reported-farm', orph)!.className).toContain('text-muted');
      expect(q('reported-farm', mis)!.className).not.toContain('text-muted');
      expect(cell(unknown, 'last-seen')).toBe('Last Jan 2, 23:56');
      expect(cell(unknown, 'first-seen')).toBe('First Jan 2, 21:00');
      // Staleness of the newest held reading on the client clock.
      expect([unknown, mis, orph].map((r) => q('staleness', r)!.dataset['staleness'])).toEqual([
        'ok',
        'stale-15',
        'empty',
      ]);
      expect(cell(unknown, 'held')).toBe('30');
      expect(cell(unknown, 'turbine-id')).toBe('TURB990');
      // Two-line cells under headers that name both lines; the latest values are in the detail
      // (its first held reading), not in the row.
      expect([...q('unallocated')!.querySelectorAll('th')].map((th) => app.text(th))).toEqual([
        'Expand',
        'Turbine / problem',
        'Reported / current farm',
        'Seen (UTC)',
        'Held',
        'Actions',
      ]);
      expect(q('latest', unknown)).toBeNull();
      // The actions column is pinned to the right edge when the table scrolls sideways.
      const actionsCell = q('more-actions', unknown)!.closest('td')!;
      expect(actionsCell.style.right).toBe('0px');
      // Screen readers hear which farm is which; sighted users read it from the header.
      expect(app.text(q('reported-farm', mis)!.parentElement)).toBe('Reported: High Plains FARM02');
      expect(app.text(q('current-farm', mis)!.parentElement)).toBe('Current: Prairie Ridge FARM01');

      // One primary action by kind, named with the turbine for screen readers; the rest are in
      // the row's "More actions" menu.
      expect(app.text(q('assign', unknown))).toBe('Assign TURB990 to farm…');
      expect(q('keep', unknown)).toBeNull();
      expect(app.text(q('keep', mis))).toBe('Keep TURB001 in FARM01');
      expect(q('assign', mis)).toBeNull();
      for (const r of [unknown, mis, orph]) {
        expect(q('more-actions', r)!.getAttribute('aria-haspopup')).toBe('menu');
        expect(q('move', r)).toBeNull(); // not in the row
        expect(q('block', r)).toBeNull();
      }
      const unknownMenu = await moreActions('TURB990');
      await unknownMenu.open();
      const unknownItems = await unknownMenu.getItems();
      expect(await Promise.all(unknownItems.map((i) => i.getText()))).toEqual([
        'Block TURB990 from FARM01…', // an unknown turbine has no farm to move from
      ]);
      await unknownMenu.close();
      const misMenu = await moreActions('TURB001');
      await misMenu.open();
      expect(await Promise.all((await misMenu.getItems()).map((i) => i.getText()))).toEqual([
        'Move TURB001 to FARM02…',
        'Block TURB001 from FARM02…',
      ]);
      const [, block] = await misMenu.getItems();
      expect(await (await block.host()).getAttribute('data-testid')).toBe('block');
      expect(await (await block.host()).hasClass('danger-button')).toBe(true);
      await misMenu.close();
      expect(
        app.text(q('unallocated-paginator')!.querySelector('.mat-mdc-paginator-range-label')),
      ).toBe('1 – 3 of 3');
    });

    it('shows an empty state', async () => {
      await open('/unallocated/pending', []);
      expect(rows()).toHaveLength(0);
      expect(app.text(q('no-unallocated'))).toContain('No unallocated turbines.');
    });

    it('shows a load error with a retry', async () => {
      app = await openFleet('/unallocated/pending', () => CLOCK, undefined, undefined, 'owner');
      expect(q('unallocated-loading')).not.toBeNull();
      TestBed.tick();
      app.http
        .expectOne(listUrl('pending'))
        .flush('boom', { status: 500, statusText: 'Server Error' });
      await settle();
      expect(app.text(q('unallocated-load-error'))).toContain(
        'Could not load the unallocated turbines.',
      );

      await click('unallocated-retry');
      await flushList('pending', [unknownTurbine()]);
      expect(q('unallocated-load-error')).toBeNull();
      expect(rows()).toHaveLength(1);
    });

    it('expands a row to its newest held readings, and collapses it', async () => {
      await open('/unallocated/pending', [unknownTurbine()]);
      const expand = q('unallocated-expand', row('TURB990'))!;
      expect(expand.getAttribute('aria-expanded')).toBe('false');
      expect(expand.getAttribute('aria-label')).toBe('Show held readings for TURB990');
      expect(q('unallocated-detail')!.hasAttribute('hidden')).toBe(true);

      await click('unallocated-expand', row('TURB990'));
      expect(expand.getAttribute('aria-expanded')).toBe('true');
      expect(q('held-readings-loading')).not.toBeNull();
      TestBed.tick();
      app.http
        .expectOne({ method: 'GET', url: `${URL}/e-unknown/readings?limit=24` })
        .flush([
          held(),
          held({ timestamp: at('23:50'), receivedAt: at('23:58'), powerOutputKw: 900 }),
        ]);
      await settle();

      expect(q('unallocated-detail')!.hasAttribute('hidden')).toBe(false);
      expect(app.text(q('held-readings-count'))).toBe(
        'The newest 2 of 30 held readings, newest first.',
      );
      const readings = [...app.root().querySelectorAll('[data-testid=held-reading]')];
      expect([...readings[1].querySelectorAll('td')].map((td) => app.text(td))).toEqual([
        'Jan 2, 23:50',
        'Jan 2, 23:58',
        'FARM01',
        '900',
        '7.3',
        '12',
        '4',
        '81',
      ]);

      // The row itself toggles too.
      row('TURB990').click();
      await settle();
      expect(row('TURB990').hasAttribute('data-expanded')).toBe(false);
      expect(q('unallocated-detail')!.hasAttribute('hidden')).toBe(true);
    });

    it('reloads the readings of an open row when more are held, with a retry on failure', async () => {
      await open('/unallocated/pending', [unknownTurbine({ heldCount: 1 })]);
      row('TURB990').click();
      TestBed.tick();
      app.http
        .expectOne(`${URL}/e-unknown/readings?limit=24`)
        .flush('down', { status: 503, statusText: 'Unavailable' });
      await settle();
      expect(app.text(q('held-readings-error'))).toContain('Could not load the held readings.');

      q('held-readings-error')!.querySelector('button')!.click();
      TestBed.tick();
      app.http.expectOne(`${URL}/e-unknown/readings?limit=24`).flush([held()]);
      await settle();
      expect(app.text(q('held-readings-count'))).toBe('1 held reading, newest first.');

      // A new reading was held: the list reloads (SSE) and the open row reloads its readings.
      app.sse.pushEvent('unallocated-turbine.changed', {
        action: 'held',
        id: 'e-unknown',
        turbineId: 'TURB990',
      });
      await flushList('pending', [unknownTurbine({ heldCount: 2, lastSeenAt: at('23:59') })]);
      TestBed.tick();
      app.http.expectOne(`${URL}/e-unknown/readings?limit=24`).flush([held(), held()]);
      await settle();
      expect(app.text(q('held-readings-count'))).toBe('2 held readings, newest first.');
    });

    it('reloads when another browser or ingestion changes the list (unallocated-turbine.changed)', async () => {
      await open('/unallocated/pending', []);
      app.sse.pushEvent('unallocated-turbine.changed', {
        action: 'held',
        id: 'e-unknown',
        turbineId: 'TURB990',
      });
      await flushList('pending', [unknownTurbine()]);
      expect(rows()).toHaveLength(1);
    });

    describe('Assign', () => {
      it('preselects the reported farm, posts the farm and coordinates, announces and reloads', async () => {
        await open('/unallocated/pending', [unknownTurbine()]);
        await click('assign', row('TURB990'));
        expect(isOpen('assign-dialog')).toBe(true);
        expect(app.text(q('assign-dialog')!.querySelector('h2'))).toBe('Assign TURB990 to a farm');
        expect(q<HTMLInputElement>('assign-farm')!.value).toBe('Prairie Ridge (FARM01)');
        // The grid is a div inside mat-dialog-content (Material's `display: block` on it beats `grid`).
        expect(q('assign-fields')!.parentElement!.tagName).toBe('MAT-DIALOG-CONTENT');
        expect(q('assign-farm')!.closest('mat-form-field')!.parentElement).toBe(q('assign-fields'));
        expect(row('TURB990').hasAttribute('data-expanded')).toBe(false); // the button doesn't toggle

        await type('assign-latitude', '41.27');
        await type('assign-longitude', '-96.5');
        await submit('assign-save');

        const post = expectPost('e-unknown', 'assign');
        expect(post.request.body).toEqual({ farmId: 'FARM01', latitude: 41.27, longitude: -96.5 });
        const farmLoads = app.api.farmSummaries.mock.calls.length;
        post.flush(resolution());
        await settle();

        expect(isOpen('assign-dialog')).toBe(false);
        expect(notice()).toBe('TURB990 assigned to Prairie Ridge (FARM01): 30 readings imported.');
        expect(app.api.farmSummaries.mock.calls.length).toBe(farmLoads + 1); // the fleet reloads
        await flushList('pending', []);
        expect(q('no-unallocated')).not.toBeNull();
      });

      it('chooses a farm from the autocomplete and sends no coordinates when both are empty', async () => {
        await open('/unallocated/pending', [
          unknownTurbine({ reportedFarmId: 'FARM42', reportedFarm: null }),
        ]);
        await click('assign', row('TURB990'));
        expect(q<HTMLInputElement>('assign-farm')!.value).toBe('');

        const loader = TestbedHarnessEnvironment.documentRootLoader(app.harness.fixture);
        const farm = await loader.getHarness(
          MatAutocompleteHarness.with({ selector: '[data-testid=assign-farm]' }),
        );
        await farm.enterText('high');
        expect(await Promise.all((await farm.getOptions()).map((o) => o.getText()))).toEqual([
          'High Plains (FARM02)',
        ]);
        await farm.selectOption({ text: 'High Plains (FARM02)' });
        await submit('assign-save');

        expectPost('e-unknown', 'assign').flush(
          resolution({
            turbine: { ...resolution().turbine, farmId: 'FARM02' },
            imported: 1,
            duplicates: 2,
          }),
        );
        await settle();
        expect(notice()).toBe(
          'TURB990 assigned to High Plains (FARM02): 1 reading imported, 2 already stored.',
        );
        await flushList('pending', []);
      });

      it('validates the farm and the coordinates before sending anything', async () => {
        await open('/unallocated/pending', [unknownTurbine({ reportedFarm: null })]);
        await click('assign', row('TURB990'));

        await submit('assign-save');
        expect(app.text(q('assign-farm-error'))).toBe('Choose a farm.');

        await type('assign-farm', 'Nowhere');
        await submit('assign-save');
        expect(app.text(q('assign-farm-error'))).toBe('Choose a farm from the list.');

        await type('assign-farm', '');
        await type('assign-latitude', '95');
        await submit('assign-save');
        expect(app.text(q('assign-latitude-error'))).toBe('Enter a number from -90 to 90.');
        expect(app.text(q('assign-longitude-error'))).toBe('Enter both coordinates, or neither.');

        await type('assign-latitude', '');
        await type('assign-longitude', '-200');
        await submit('assign-save');
        expect(app.text(q('assign-longitude-error'))).toBe('Enter a number from -180 to 180.');
        expect(app.text(q('assign-latitude-error'))).toBe('Enter both coordinates, or neither.');

        expect(isOpen('assign-dialog')).toBe(true);
        app.http.expectNone((r) => r.method === 'POST');
        // Esc in the farm field closes its open option panel first, then the dialog.
        q('assign-farm')!.focus();
        await pressEscape();
        await pressEscape();
        expect(isOpen('assign-dialog')).toBe(false);
        expect(notice()).toBe('');
      });

      it('shows a conflict (409) in the dialog and reloads the list behind it', async () => {
        await open('/unallocated/pending', [unknownTurbine()]);
        await click('assign', row('TURB990'));
        await submit('assign-save');
        const { body, opts } = conflict(
          'Turbine TURB990 already exists on FARM02: keep or move it instead',
        );
        expectPost('e-unknown', 'assign').flush(body, opts);
        await settle();

        expect(app.text(q('assign-error'))).toBe(
          'Turbine TURB990 already exists on FARM02: keep or move it instead.',
        );
        expect(isOpen('assign-dialog')).toBe(true);
        await flushList('pending', [mismatch({ turbineId: 'TURB990' })]);
      });

      it.each([
        ['an unknown farm (404)', notFound('Farm FARM01 not found'), 'Farm FARM01 not found.'],
        [
          'a validation error (400)',
          {
            body: { statusCode: 400, message: ['latitude must not be greater than 90'] },
            opts: { status: 400, statusText: 'Bad Request' },
          },
          'latitude must not be greater than 90.',
        ],
      ])('keeps the dialog open on %s, without reloading', async (_, { body, opts }, text) => {
        await open('/unallocated/pending', [unknownTurbine()]);
        await click('assign', row('TURB990'));
        await submit('assign-save');
        expectPost('e-unknown', 'assign').flush(body, opts);
        await settle();
        expect(app.text(q('assign-error'))).toBe(text);
        expect(isOpen('assign-dialog')).toBe(true);
        app.http.expectNone(listUrl('pending'));
      });

      it('says the API is unreachable on a network failure', async () => {
        await open('/unallocated/pending', [unknownTurbine()]);
        await click('assign', row('TURB990'));
        await submit('assign-save');
        expectPost('e-unknown', 'assign').error(new ProgressEvent('error'));
        await settle();
        expect(app.text(q('assign-error'))).toBe(
          'Could not reach the API. Check your connection and try again.',
        );
        expect(q<HTMLButtonElement>('assign-save')!.disabled).toBe(false);
      });

      it('closes and reloads when the entry was already resolved elsewhere (404)', async () => {
        await open('/unallocated/pending', [unknownTurbine()]);
        await click('assign', row('TURB990'));
        await submit('assign-save');
        const { body, opts } = notFound('Unallocated turbine e-unknown not found');
        expectPost('e-unknown', 'assign').flush(body, opts);
        await settle();

        expect(isOpen('assign-dialog')).toBe(false);
        expect(notice()).toBe('TURB990 from FARM01 was already resolved elsewhere.');
        await flushList('pending', []);
      });
    });

    describe('Keep', () => {
      it('imports under the current farm at once, announces and reloads the list and the fleet', async () => {
        await open('/unallocated/pending', [mismatch()]);
        const farmLoads = app.api.farmSummaries.mock.calls.length;
        await click('keep', row('TURB001'));
        expect(q<HTMLButtonElement>('keep', row('TURB001'))!.disabled).toBe(true);
        expect(app.text(q('keep', row('TURB001')))).toContain('Keeping…');

        const post = expectPost('e-mismatch', 'keep');
        post.flush(resolution({ action: 'kept', id: 'e-mismatch', imported: 3 }));
        await settle();

        expect(notice()).toBe('TURB001 kept in Prairie Ridge (FARM01): 3 readings imported.');
        expect(app.api.farmSummaries.mock.calls.length).toBe(farmLoads + 1);
        await flushList('pending', []);
      });

      it('shows a conflict on the page and reloads the list', async () => {
        await open('/unallocated/pending', [mismatch()]);
        await click('keep', row('TURB001'));
        const { body, opts } = conflict('TURB001 reporting FARM02 is blocked: unblock it first');
        expectPost('e-mismatch', 'keep').flush(body, opts);
        await settle();

        expect(app.text(q('unallocated-action-error'))).toBe(
          'TURB001 reporting FARM02 is blocked: unblock it first.',
        );
        expect(q<HTMLButtonElement>('keep', row('TURB001'))!.disabled).toBe(false);
        await flushList('pending', []);
      });

      it('announces an entry resolved elsewhere (404), and a network failure as an error', async () => {
        await open('/unallocated/pending', [mismatch()]);
        await click('keep', row('TURB001'));
        expectPost('e-mismatch', 'keep').error(new ProgressEvent('error'));
        await settle();
        expect(app.text(q('unallocated-action-error'))).toBe(
          'Could not reach the API. Check your connection and try again.',
        );
        app.http.expectNone(listUrl('pending'));

        await click('keep', row('TURB001'));
        expect(q('unallocated-action-error')).toBeNull(); // cleared by the next try
        const { body, opts } = notFound('Unallocated turbine e-mismatch not found');
        expectPost('e-mismatch', 'keep').flush(body, opts);
        await settle();
        expect(notice()).toBe('TURB001 from FARM02 was already resolved elsewhere.');
        await flushList('pending', []);
      });
    });

    describe('Move', () => {
      it('asks first; Esc cancels, confirming moves the turbine and its history', async () => {
        await open('/unallocated/pending', [mismatch()]);
        await chooseAction('TURB001', 'move');
        expect(isOpen('confirm-dialog')).toBe(true);
        expect(q('confirm-dialog')!.dataset['action']).toBe('move');
        expect(app.text(q('confirm-dialog')!.querySelector('h2'))).toBe('Move TURB001 to FARM02?');
        expect(app.text(q('confirm-text'))).toBe(
          'TURB001 and all its readings will move to High Plains (FARM02); Prairie Ridge (FARM01) reports will no longer include them. Its 3 held readings are imported under FARM02.',
        );
        expect(app.text(document.activeElement)).toBe('Cancel'); // the safe choice first

        await pressEscape();
        expect(isOpen('confirm-dialog')).toBe(false);
        app.http.expectNone(`${URL}/e-mismatch/move`);
        expect(notice()).toBe('');
        // Focus is back on the row's menu button.
        expect(document.activeElement).toBe(q('more-actions', row('TURB001')));

        await chooseAction('TURB001', 'move');
        await click('confirm-action');
        expect(app.text(q('confirm-action'))).toBe('Moving…');
        expectPost('e-mismatch', 'move').flush(
          resolution({
            action: 'moved',
            id: 'e-mismatch',
            turbine: { ...resolution().turbine, id: 'TURB001', farmId: 'FARM02' },
            imported: 1,
          }),
        );
        await settle();

        expect(isOpen('confirm-dialog')).toBe(false);
        expect(notice()).toBe('TURB001 moved to High Plains (FARM02): 1 reading imported.');
        await flushList('pending', []);
      });

      it('is a disabled menu item, with the reason, when the reported farm does not exist', async () => {
        await open('/unallocated/pending', [orphan()]);
        expect(q('move-disabled-reason')).toBeNull(); // no helper text in the table
        const menu = await moreActions('TURB002');
        await menu.open();
        const [moveItem, blockItem] = await menu.getItems();
        expect(await moveItem.isDisabled()).toBe(true);
        expect(await blockItem.isDisabled()).toBe(false);
        const move = q<HTMLButtonElement>('move')!;
        expect(move.getAttribute('aria-disabled')).toBe('true'); // focusable, still disabled
        expect(move.hasAttribute('disabled')).toBe(false);
        const reason = q('move-disabled-reason', move)!;
        expect(app.text(reason)).toBe('No farm FARM99 to move to: keep or block it.');
        expect(move.getAttribute('aria-describedby')).toBe(reason.id); // its description
        expect(reason.getAttribute('aria-hidden')).toBe('true'); // not part of its name

        // Clicking it does nothing, and the menu stays open.
        await moveItem.click();
        await settle();
        expect(isOpen('confirm-dialog')).toBe(false);
        expect(await menu.isOpen()).toBe(true);
        await menu.close();
        // Keep is the row's action.
        expect(app.text(q('keep', row('TURB002')))).toBe('Keep TURB002 in FARM02');
      });

      it('opens from the keyboard, moves with the arrow keys, and Esc returns focus', async () => {
        await open('/unallocated/pending', [mismatch()]);
        const trigger = q<HTMLButtonElement>('more-actions', row('TURB001'))!;
        expect(trigger.getAttribute('aria-label')).toBe('More actions for TURB001');
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        const key = (target: Element, name: string, keyCode: number) => {
          const event = new KeyboardEvent('keydown', { key: name, bubbles: true });
          Object.defineProperty(event, 'keyCode', { get: () => keyCode });
          target.dispatchEvent(event);
        };

        // Enter on the button (a browser clicks it): the menu opens on its first item.
        trigger.focus();
        key(trigger, 'Enter', 13);
        trigger.click();
        await settle();
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe(q('move'));
        key(document.activeElement!, 'ArrowDown', 40);
        await settle();
        expect(document.activeElement).toBe(q('block'));
        key(document.activeElement!, 'ArrowDown', 40); // wraps
        await settle();
        expect(document.activeElement).toBe(q('move'));

        await pressEscape();
        expect(q('move')).toBeNull();
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(trigger);
        expect(row('TURB001').hasAttribute('data-expanded')).toBe(false); // never toggles the row
      });

      it('shows a conflict (409) in the dialog and reloads; another error just shows', async () => {
        await open('/unallocated/pending', [mismatch()]);
        await chooseAction('TURB001', 'move');
        await click('confirm-action');
        const { body, opts } = conflict(
          'Farm FARM02 does not exist: keep TURB001 in FARM01 or block it',
        );
        expectPost('e-mismatch', 'move').flush(body, opts);
        await settle();
        expect(app.text(q('confirm-error'))).toBe(
          'Farm FARM02 does not exist: keep TURB001 in FARM01 or block it.',
        );
        expect(isOpen('confirm-dialog')).toBe(true);
        await flushList('pending', [mismatch()]);

        await click('confirm-action');
        expect(q('confirm-error')).toBeNull();
        expectPost('e-mismatch', 'move').flush(
          { message: 'Internal server error' },
          { status: 500, statusText: 'Server Error' },
        );
        await settle();
        expect(app.text(q('confirm-error'))).toBe('Internal server error.');
        app.http.expectNone(listUrl('pending'));
      });

      it('closes and reloads when the entry is gone (404)', async () => {
        await open('/unallocated/pending', [mismatch()]);
        await chooseAction('TURB001', 'move');
        await click('confirm-action');
        const { body, opts } = notFound('Unallocated turbine e-mismatch not found');
        expectPost('e-mismatch', 'move').flush(body, opts);
        await settle();
        expect(isOpen('confirm-dialog')).toBe(false);
        expect(notice()).toBe('TURB001 from FARM02 was already resolved elsewhere.');
        await flushList('pending', []);
      });
    });

    describe('Block', () => {
      it('explains what blocking drops, then blocks, announces and reloads', async () => {
        await open('/unallocated/pending', [unknownTurbine({ heldCount: 1 })]);
        await chooseAction('TURB990', 'block');
        expect(q('confirm-dialog')!.dataset['action']).toBe('block');
        expect(app.text(q('confirm-dialog')!.querySelector('h2'))).toBe(
          'Block TURB990 from FARM01?',
        );
        expect(app.text(q('confirm-text'))).toBe(
          'Readings for TURB990 that report FARM01 will be dropped until you unblock it, and its 1 held reading is deleted. Readings dropped while it is blocked can’t be recovered.',
        );
        expect(q('confirm-action')!.classList).toContain('danger-button');

        await click('confirm-action');
        expect(app.text(q('confirm-action'))).toBe('Blocking…');
        expectPost('e-unknown', 'block').flush(unknownTurbine({ status: 'blocked' }));
        await settle();

        expect(isOpen('confirm-dialog')).toBe(false);
        expect(notice()).toBe('Readings for TURB990 from FARM01 are now blocked.');
        expect(document.activeElement).toBe(q('more-actions', row('TURB990'))); // focus returned
        await flushList('pending', []);
      });

      it('shows that it is already blocked (409) in the dialog and reloads', async () => {
        await open('/unallocated/pending', [unknownTurbine()]);
        await chooseAction('TURB990', 'block');
        await click('confirm-action');
        const { body, opts } = conflict('TURB990 reporting FARM01 is blocked: unblock it first');
        expectPost('e-unknown', 'block').flush(body, opts);
        await settle();
        expect(app.text(q('confirm-error'))).toBe(
          'TURB990 reporting FARM01 is blocked: unblock it first.',
        );
        await flushList('pending', []);
      });
    });
  });

  it('shows Pending and Blocked times in local time when chosen in Settings', async () => {
    await open('/unallocated', [unknownTurbine()]);
    TestBed.inject(TimeZoneSettings).setMode('local'); // browser zone America/Chicago
    await settle();
    expect(cell(row('TURB990'), 'last-seen')).toBe('Last Jan 2, 17:56');
    expect(cell(row('TURB990'), 'first-seen')).toBe('First Jan 2, 15:00');
    const headers = [...app.root().querySelectorAll('thead th')].map((th) => app.text(th));
    expect(headers).toContain('Seen (local)');
    expect(app.text(app.root().querySelector('h1 ~ p'))).toContain(
      'Times are local time (America/Chicago).',
    );

    await app.harness.navigateByUrl('/unallocated/blocked');
    await flushList('blocked', [blocked()]);
    const cells = [...app.root().querySelectorAll('[data-testid=blocked-row] td')];
    expect(cells.map((td) => app.text(td))).toContain('Jan 2, 04:15');
    expect([...app.root().querySelectorAll('thead th')].map((th) => app.text(th))).toContain(
      'Blocked (local)',
    );
  });

  describe('Blocked', () => {
    it('lists the blocked turbines with when and by whom', async () => {
      await open('/unallocated/blocked', [
        blocked(),
        blocked({
          id: 'e-b2',
          turbineId: 'TURB998',
          blockedBy: null,
          blockedAt: null,
          reportedFarm: FARM01,
          reportedFarmId: 'FARM01',
        }),
      ]);
      expect(TestBed.inject(Title).getTitle()).toBe('Blocked turbines · Nextera');
      expect(q('unallocated-tab-blocked')!.getAttribute('aria-selected')).toBe('true');
      expect(q('unallocated-tab-pending')!.getAttribute('aria-selected')).toBe('false');
      expect(q('unallocated-tab-panel')!.getAttribute('aria-labelledby')).toBe(
        q('unallocated-tab-blocked')!.id,
      );
      expect(app.text(q('blocked-count'))).toBe('2 blocked turbines');
      const cells = [...app.root().querySelectorAll('[data-testid=blocked-row]')].map((r) =>
        [...r.querySelectorAll('td')].map((td) => app.text(td)),
      );
      expect(cells).toEqual([
        [
          'TURB999',
          'Unknown turbine',
          'Unknown farm FARM05',
          'Jan 2, 10:15',
          'owner@nextera.local',
          'Unblock TURB999 from FARM05',
        ],
        [
          'TURB998',
          'Unknown turbine',
          'Prairie Ridge FARM01',
          '–',
          'Unknown user',
          'Unblock TURB998 from FARM01',
        ],
      ]);
      // Unblock is pinned to the right edge when the table scrolls sideways.
      expect(q('unblock')!.closest('td')!.style.right).toBe('0px');
    });

    it('shows an empty state, and a load error with a retry', async () => {
      await open('/unallocated/blocked', []);
      expect(app.text(q('no-blocked'))).toContain('No blocked turbines.');

      app.sse.pushEvent('unallocated-turbine.changed', {
        action: 'blocked',
        id: 'x',
        turbineId: 'T',
      });
      TestBed.tick();
      app.http.expectOne(listUrl('blocked')).flush('x', { status: 500, statusText: 'Error' });
      await settle();
      expect(app.text(q('unallocated-load-error'))).toContain(
        'Could not load the blocked turbines.',
      );
      await click('unallocated-retry');
      await flushList('blocked', [blocked()]);
      expect(q('unallocated-load-error')).toBeNull();
    });

    it('unblocks, announces and reloads', async () => {
      await open('/unallocated/blocked', [blocked()], 'admin');
      await click('unblock');
      expect(app.text(q('unblock'))).toContain('Unblocking…');
      expectPost('e-blocked', 'unblock').flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      expect(notice()).toBe(
        'TURB999 from FARM05 unblocked: its next reading will show under Pending.',
      );
      await flushList('blocked', []);
      expect(q('no-blocked')).not.toBeNull();
    });

    it('shows a conflict (409) and reloads; a gone entry (404) is announced', async () => {
      await open('/unallocated/blocked', [blocked()]);
      await click('unblock');
      const { body, opts } = conflict('TURB999 reporting FARM05 is not blocked');
      expectPost('e-blocked', 'unblock').flush(body, opts);
      await settle();
      expect(app.text(q('unallocated-action-error'))).toBe(
        'TURB999 reporting FARM05 is not blocked.',
      );
      await flushList('blocked', [blocked()]);

      await click('unblock');
      const gone = notFound('Unallocated turbine e-blocked not found');
      expectPost('e-blocked', 'unblock').flush(gone.body, gone.opts);
      await settle();
      expect(notice()).toBe('TURB999 from FARM05 was already resolved elsewhere.');
      await flushList('blocked', []);
    });
  });
});
