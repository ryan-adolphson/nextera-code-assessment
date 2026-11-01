import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { TestRequest } from '@angular/common/http/testing';
import { DeferBlockBehavior, DeferBlockState, TestBed } from '@angular/core/testing';
import { MatDateRangeInputHarness } from '@angular/material/datepicker/testing';
import { MatPaginatorHarness } from '@angular/material/paginator/testing';
import { Title } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { TimeZoneSettings } from '../core/time-zone';
import { Telemetry } from '../fleet/fleet.model';
import { TEST_API_BASE_URL, openFleet, rangeCalendar, reading } from '../fleet/testing';
import { AlertConfig } from './alert-config.model';

const ALERTS_URL = `${TEST_API_BASE_URL}/alerts`;
const CLOCK = Date.parse('2026-01-03T00:00:30.000Z');

const rule = (overrides: Partial<AlertConfig> = {}): AlertConfig => ({
  id: 'gearbox-error',
  measurementMetric: 'gearboxTempC',
  comparison: 'above',
  valueMetric: 120,
  alertLevel: 'error',
  enabled: true,
  ...overrides,
});
const gearboxWarn = rule({ id: 'gearbox-warn', valueMetric: 90, alertLevel: 'warn' });
const lowPower = rule({
  id: 'low-power',
  measurementMetric: 'powerOutputKw',
  comparison: 'below',
  valueMetric: 100,
  alertLevel: 'info',
});

/** What GET /api/alerts returns: grouped by turbine, newest first. */
const flagged = (): Telemetry[] => [
  reading({
    id: 't1',
    timestamp: '2026-01-02T13:40:00.000Z',
    powerOutputKw: 0,
    alerts: [lowPower],
  }),
  ...['03:30', '03:25', '03:20'].map((hhmm) =>
    reading({
      id: `t2-${hhmm}`,
      turbineId: 'TURB002',
      farmId: 'FARM02',
      timestamp: `2026-01-02T${hhmm}:00.000Z`,
      gearboxTempC: 126.5,
      alerts: [rule(), gearboxWarn],
    }),
  ),
];

/** /alerting/history through the real routes, the client clock at 2026-01-03T00:00:30Z. */
describe('AlertHistoryPage (/alerting/history)', () => {
  let app: Awaited<ReturnType<typeof openFleet>>;

  const q = <T extends Element = HTMLElement>(id: string) =>
    app.root().querySelector<T>(`[data-testid=${id}]`);
  const all = (id: string) => [...app.root().querySelectorAll(`[data-testid=${id}]`)];
  /** The pending GET /api/alerts (the page's resource sends it on change detection). */
  const expectAlerts = (): TestRequest => {
    TestBed.tick();
    return app.http.expectOne((r) => r.method === 'GET' && r.url === ALERTS_URL);
  };
  async function flush(readings: Telemetry[]) {
    expectAlerts().flush(readings);
    await app.stable();
  }
  /**
   * Types days into the Material date range input (en-US, M/D/YYYY), like a user would. DOM events,
   * not `MatDateRangeInputHarness.setValue`: the harness waits for stability, which never comes
   * while the reload it triggers is pending (a loading resource is a pending task).
   */
  function setDays(start: string | null, end: string | null) {
    const type = (testId: string, value: string) => {
      const input = q<HTMLInputElement>(testId)!;
      input.value = value;
      for (const type of ['input', 'change', 'blur']) input.dispatchEvent(new Event(type));
    };
    if (start !== null) type('history-from', start);
    if (end !== null) type('history-to', end);
    TestBed.tick();
  }
  const chipTexts = (el: Element) =>
    [...el.querySelectorAll('[data-testid=alert-chip]')].map((c) => app.text(c));
  /** Each turbine's summary row: its cells (without the chips), then its chips. */
  const summaries = () =>
    all('history-turbine').map((tr) => [
      ...[...tr.querySelectorAll('td')]
        .filter((td) => !td.querySelector('[data-testid=alert-chip]'))
        .map((td) => app.text(td)),
      chipTexts(tr),
    ]);
  /** A turbine's expanded detail: each reading's time and chips. */
  const details = (turbineId: string) =>
    [
      ...app
        .root()
        .querySelectorAll(
          `[data-testid=history-detail][data-turbine-id=${turbineId}] [data-testid=history-reading]`,
        ),
    ].map((li) => [app.text(li.querySelector('span')), chipTexts(li)]);
  const expandButton = (turbineId: string) =>
    app
      .root()
      .querySelector<HTMLButtonElement>(
        `[data-testid=history-turbine][data-turbine-id=${turbineId}] [data-testid=history-expand]`,
      )!;
  const detailRow = (turbineId: string) =>
    app
      .root()
      .querySelector<HTMLElement>(`[data-testid=history-detail][data-turbine-id=${turbineId}]`)!;

  /** Esc in the focused overlay (CDK checks the legacy keyCode, which jsdom leaves at 0). */
  async function pressEscape() {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    Object.defineProperty(event, 'keyCode', { get: () => 27 });
    (document.activeElement ?? document.body).dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve)); // `closed` is emitted a task later
    await app.stable();
  }

  beforeEach(async () => {
    app = await openFleet('/alerting/history', () => CLOCK);
  });

  it('asks for yesterday and today (whole UTC days) by default, shown in the Material date range picker', async () => {
    const req = expectAlerts();
    expect(req.request.params.get('from')).toBe('2026-01-02T00:00:00.000Z');
    expect(req.request.params.get('to')).toBe('2026-01-04T00:00:00.000Z'); // the day after today
    req.flush([]);
    await app.stable();

    const range = await TestbedHarnessEnvironment.loader(app.harness.fixture).getHarness(
      MatDateRangeInputHarness,
    );
    expect(await (await range.getStartInput()).getValue()).toBe('1/2/2026');
    expect(await (await range.getEndInput()).getValue()).toBe('1/3/2026');
    expect(await range.getValue()).toBe('1/2/2026 – 1/3/2026');
    // A Material date range input with a picker toggle; no future days (max = today).
    expect(q('history-range')!.querySelector('mat-date-range-input')).not.toBeNull();
    expect(q('history-range')!.querySelector('mat-datepicker-toggle button')).not.toBeNull();
    expect(await (await range.getEndInput()).getMax()).toBe('2026-01-03'); // ISO from the harness
    expect(TestBed.inject(Title).getTitle()).toBe('Alert history · Nextera');
    expect(q('alerting-tab-history')!.getAttribute('aria-current')).toBe('page');
    expect(app.text(q('history-empty'))).toBe('No alerts in this range.');
    expect(app.text(q('history-count'))).toBe('0 flagged readings on 0 turbines');
  });

  it('shows one expandable summary row per turbine with its number of alerts (the rows expand to them)', async () => {
    await flush(flagged());

    expect(summaries()).toEqual([
      [
        '', // the expand button: named by aria-label

        'TURB001',
        'Prairie Ridge FARM01',
        'Jan 2, 13:40',
        'Info: 1',
        [], // no chips in the summary row: a pill per level
      ],
      // 3 readings × (error + warn), worst level first
      ['', 'TURB002', 'High Plains FARM02', 'Jan 2, 03:30', 'Error: 3 Warning: 3', []],
    ]);
    expect(
      all('history-turbine').map((tr) =>
        [...tr.querySelectorAll('[data-testid=level-count]')].map((p) =>
          p.getAttribute('data-level'),
        ),
      ),
    ).toEqual([['info'], ['error', 'warn']]);
    expect(app.text(q('history-count'))).toBe('4 flagged readings on 2 turbines');
    expect(all('history-turbine').map((tr) => tr.getAttribute('data-level'))).toEqual([
      'info',
      'error',
    ]);

    // Material table with multiTemplateDataRows; Alerts is a pill per level, not chips.
    expect(q('alert-history')!.classList).toContain('mat-mdc-table');
    expect([...q('alert-history')!.querySelectorAll('thead th')].map((th) => app.text(th))).toEqual(
      ['Expand', 'Turbine', 'Farm', 'Latest (UTC)', 'Alerts'],
    );
    // Collapsed: the detail rows are rendered but hidden, with no readings inside.
    expect(all('history-detail').map((tr) => tr.hasAttribute('hidden'))).toEqual([true, true]);
    expect(all('history-reading')).toHaveLength(0);
    expect(all('history-turbine')[0].querySelector('a')!.getAttribute('href')).toBe(
      '/farms/FARM01/turbines/TURB001',
    );
  });

  it('expands a turbine to its flagged readings, newest first, each with its rules as chips', async () => {
    await flush(flagged());
    const button = expandButton('TURB002');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Show readings for TURB002');
    expect(button.getAttribute('aria-controls')).toBe('history-detail-TURB002');

    button.click();
    await app.stable();

    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Hide readings for TURB002');
    expect(button.querySelector('mat-icon')!.classList).toContain('rotate-90');
    expect(detailRow('TURB002').hasAttribute('hidden')).toBe(false);
    expect(detailRow('TURB002').querySelector('td')!.id).toBe('history-detail-TURB002');
    expect(detailRow('TURB002').querySelector('td')!.getAttribute('colspan')).toBe('5');
    const gearbox = [
      'Error: Gearbox temperature 126.5 °C > 120',
      'Warning: Gearbox temperature 126.5 °C > 90',
    ];
    expect(details('TURB002')).toEqual([
      ['Jan 2, 03:30', gearbox],
      ['Jan 2, 03:25', gearbox],
      ['Jan 2, 03:20', gearbox],
    ]);
    expect(detailRow('TURB001').hasAttribute('hidden')).toBe(true); // others stay collapsed

    // Clicking the row (not just the button) toggles too; several can be open at once.
    (all('history-turbine')[0] as HTMLElement).click();
    await app.stable();
    expect(details('TURB001')).toEqual([['Jan 2, 13:40', ['Info: Power output 0 kW < 100']]]);
    expect(detailRow('TURB002').hasAttribute('hidden')).toBe(false);

    button.click();
    await app.stable();
    expect(detailRow('TURB002').hasAttribute('hidden')).toBe(true);
    expect(details('TURB002')).toEqual([]);
  });

  it('does not toggle when the turbine link is followed', async () => {
    await flush(flagged());
    all('history-turbine')[0].querySelector<HTMLAnchorElement>('a')!.click();
    await app.stable();
    expect(TestBed.inject(Router).url).toBe('/farms/FARM01/turbines/TURB001');
  });

  it('pages 25 turbines at a time', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      reading({
        id: `r${i}`,
        turbineId: `TURB${String(i + 1).padStart(3, '0')}`,
        alerts: [rule()],
      }),
    );
    await flush(many);
    const pages = await TestbedHarnessEnvironment.loader(app.harness.fixture).getHarness(
      MatPaginatorHarness.with({ selector: '[data-testid=history-paginator]' }),
    );

    expect(await pages.getRangeLabel()).toBe('1 – 25 of 30');
    expect(all('history-turbine')).toHaveLength(25);

    await pages.goToNextPage();
    expect(all('history-turbine').map((tr) => tr.getAttribute('data-turbine-id'))).toEqual([
      'TURB026',
      'TURB027',
      'TURB028',
      'TURB029',
      'TURB030',
    ]);
  });

  it('reloads when the range changes, and explains an invalid range without asking the API', async () => {
    await flush(flagged());

    setDays('1/1/2026', null); // a new start day, the same end day
    const req = expectAlerts();
    expect(req.request.params.get('from')).toBe('2026-01-01T00:00:00.000Z');
    expect(req.request.params.get('to')).toBe('2026-01-04T00:00:00.000Z');
    req.flush(flagged().slice(1));
    await app.stable();
    expect(all('history-turbine')).toHaveLength(1);

    setDays('1/5/2026', '1/3/2026');
    app.http.expectNone(ALERTS_URL);
    expect(app.text(q('history-range-error'))).toBe(
      'The end date must not be before the start date.',
    );
    expect(all('history-turbine')).toHaveLength(1); // the last results stay

    setDays('12/1/2025', '1/3/2026');
    app.http.expectNone(ALERTS_URL);
    expect(app.text(q('history-range-error'))).toBe('Choose at most 31 days.');
  });

  it('queries only a complete range picked in the calendar: nothing (and no error) halfway through', async () => {
    await flush(flagged());
    const calendar = rangeCalendar(q('history-range')!);
    calendar.open();
    await app.stable();
    expect(calendar.isOpen()).toBe(true);

    // The picker sets the start and clears the end: no request with the old end day (1/3).
    calendar.previousMonth();
    await app.stable();
    calendar.pick(30);
    await app.stable();
    app.http.expectNone(ALERTS_URL);
    expect(q('history-range-error')).toBeNull();
    expect(all('history-turbine')).toHaveLength(2); // the last results stay
    expect(app.text(q('history-count'))).toBe('4 flagged readings on 2 turbines');

    // The end day completes the range; the calendar closes and one request goes out.
    calendar.pick(31);
    await new Promise((resolve) => setTimeout(resolve)); // `closed` is emitted a task later
    const req = expectAlerts();
    expect([req.request.params.get('from'), req.request.params.get('to')]).toEqual([
      '2025-12-30T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ]);
    req.flush([]);
    await app.stable();
    expect(calendar.isOpen()).toBe(false);
    expect(app.text(q('history-count'))).toBe('0 flagged readings on 0 turbines');
  });

  it('sends nothing when the calendar closes on the range shown, and asks for an end day after a half pick', async () => {
    await flush(flagged());
    const calendar = rangeCalendar(q('history-range')!);
    calendar.open();
    await app.stable();
    await pressEscape();
    expect(calendar.isOpen()).toBe(false);
    app.http.expectNone(ALERTS_URL);
    expect(q('history-range-error')).toBeNull();

    calendar.open();
    await app.stable();
    calendar.pick(1);
    await app.stable();
    await pressEscape();
    expect(calendar.isOpen()).toBe(false);
    app.http.expectNone(ALERTS_URL);
    expect(app.text(q('history-range-error'))).toBe('Choose an end date.');
    expect(all('history-turbine')).toHaveLength(2);
  });

  it('shows a load error with a retry', async () => {
    expectAlerts().flush('boom', { status: 500, statusText: 'Server Error' });
    await app.stable();
    expect(app.text(q('history-error'))).toContain('The alerts could not be loaded.');

    q<HTMLButtonElement>('history-retry')!.click();
    await flush(flagged());
    expect(q('history-error')).toBeNull();
    expect(all('history-turbine')).toHaveLength(2);
  });

  it('fits range and table in one window-high view: only the rows scroll, above the paginator', async () => {
    await flush(flagged());
    expect(app.root().querySelector('[data-testid=shell]')!.hasAttribute('data-fill')).toBe(true);
    const region = q('history-scroll')!;
    expect([region.getAttribute('role'), region.getAttribute('aria-label')]).toEqual([
      'region',
      'Alerts by turbine',
    ]);
    expect(region.contains(q('alert-history'))).toBe(true);
    expect(region.contains(q('history-paginator'))).toBe(false);
    for (const th of app.root().querySelectorAll('[data-testid=alert-history] thead th')) {
      expect(th.classList).toContain('mat-mdc-table-sticky');
    }
  });
});

/** Local time (Settings → Local, browser zone America/Chicago): local days and times. */
describe('AlertHistoryPage in local time', () => {
  let app: Awaited<ReturnType<typeof openFleet>>;
  const q = (id: string) => app.root().querySelector<HTMLElement>(`[data-testid=${id}]`);
  const expectAlerts = (): TestRequest => {
    TestBed.tick();
    return app.http.expectOne((r) => r.method === 'GET' && r.url === ALERTS_URL);
  };
  const range = (req: TestRequest) => [
    req.request.params.get('from'),
    req.request.params.get('to'),
  ];

  beforeEach(async () => {
    app = await openFleet('/alerting/history', () => CLOCK, undefined, undefined, 'admin', {
      timeZone: 'local',
    });
  });
  afterEach(() => app.http.verify());

  it('asks for yesterday and today as local days (local midnights) and shows local times', async () => {
    // 2026-01-03 00:00:30 UTC is Jan 2, 18:00 CST: yesterday and today are Jan 1 and Jan 2.
    const req = expectAlerts();
    expect(range(req)).toEqual(['2026-01-01T06:00:00.000Z', '2026-01-03T06:00:00.000Z']);
    req.flush(flagged());
    await app.stable();

    const picker = await TestbedHarnessEnvironment.loader(app.harness.fixture).getHarness(
      MatDateRangeInputHarness,
    );
    expect(await picker.getValue()).toBe('1/1/2026 – 1/2/2026');
    expect(await (await picker.getEndInput()).getMax()).toBe('2026-01-02'); // today, locally
    expect(app.text(q('history-range')!.querySelector('mat-label'))).toBe('Dates (local)');
    expect(app.text(app.root().querySelector('h1 + p'))).toBe(
      'Readings that triggered alert rules when they arrived, by turbine. Times are local time (America/Chicago).',
    );
    const row = app.root().querySelector('[data-testid=history-turbine][data-turbine-id=TURB001]')!;
    expect([...row.querySelectorAll('td')].map((td) => app.text(td))).toContain('Jan 2, 07:40');
    expect(app.text(q('alert-history')!.querySelectorAll('thead th')[3])).toBe('Latest (local)');
  });

  it('keeps the picked calendar days and queries them again when the zone changes', async () => {
    expectAlerts().flush([]);
    await app.stable();

    TestBed.inject(TimeZoneSettings).setMode('utc');
    const req = expectAlerts();
    expect(range(req)).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z']);
    req.flush(flagged());
    await app.stable();
    expect(app.text(q('history-range')!.querySelector('mat-label'))).toBe('Dates (UTC)');
  });
});

/** The detail rows' chips: `@defer (when isExpanded(…); prefetch on idle)`, driven by hand. */
describe('AlertHistoryPage deferred chips (@defer)', () => {
  let app: Awaited<ReturnType<typeof openFleet>>;
  beforeEach(async () => {
    app = await openFleet('/alerting/history', () => CLOCK, undefined, undefined, 'admin', {
      deferBlockBehavior: DeferBlockBehavior.Manual,
    });
    TestBed.tick();
    app.http.expectOne((r) => r.url === ALERTS_URL).flush(flagged());
    await app.stable();
  });
  afterEach(() => app.http.verify());

  const detail = (turbineId: string) =>
    app
      .root()
      .querySelector<HTMLElement>(`[data-testid=history-detail][data-turbine-id=${turbineId}]`)!;
  const expand = async (turbineId: string) => {
    app
      .root()
      .querySelector<HTMLButtonElement>(
        `[data-testid=history-turbine][data-turbine-id=${turbineId}] [data-testid=history-expand]`,
      )!
      .click();
    await app.stable();
  };

  it('holds the expanded readings’ rows (their times) until the chips load, then shows the chips', async () => {
    const blocks = await app.harness.fixture.getDeferBlocks();
    expect(blocks).toHaveLength(2); // one per detail row
    expect(app.root().querySelector('[data-testid=history-detail-placeholder]')).toBeNull();

    await expand('TURB002');

    const placeholder = detail('TURB002').querySelector(
      '[data-testid=history-detail-placeholder]',
    )!;
    expect([...placeholder.querySelectorAll('li')].map((li) => app.text(li))).toEqual([
      'Jan 2, 03:30',
      'Jan 2, 03:25',
      'Jan 2, 03:20',
    ]);
    expect(detail('TURB002').querySelector('[data-testid=alert-chip]')).toBeNull();
    expect(detail('TURB001').querySelector('[data-testid=history-detail-placeholder]')).toBeNull();

    for (const block of blocks) await block.render(DeferBlockState.Complete);
    await app.stable();

    expect(detail('TURB002').querySelector('[data-testid=history-detail-placeholder]')).toBeNull();
    expect(detail('TURB002').querySelectorAll('[data-testid=history-reading]')).toHaveLength(3);
    expect(detail('TURB002').querySelectorAll('[data-testid=alert-chip]')).toHaveLength(6);
    // A collapsed row renders no readings even once the chips have loaded.
    expect(detail('TURB001').querySelector('[data-testid=history-reading]')).toBeNull();
  });

  it('announces loading, and asks for a reload if the chips fail to load', async () => {
    await expand('TURB002');
    const blocks = await app.harness.fixture.getDeferBlocks();
    for (const block of blocks) await block.render(DeferBlockState.Loading);
    await app.stable();
    const loading = detail('TURB002').querySelector('[data-testid=history-detail-loading]')!;
    expect(app.text(loading.querySelector('[role=status]'))).toBe('Loading alerts…');
    expect(loading.querySelectorAll('li')).toHaveLength(4); // the status + one per reading

    for (const block of blocks) await block.render(DeferBlockState.Error);
    await app.stable();
    const error = detail('TURB002').querySelector('[data-testid=history-detail-load-error]')!;
    expect(error.getAttribute('role')).toBe('alert');
    expect(app.text(error)).toBe('The alerts could not be loaded. Reload the page to try again.');
  });
});
