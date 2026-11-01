import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { TestRequest } from '@angular/common/http/testing';
import { DeferBlockBehavior, DeferBlockState, TestBed } from '@angular/core/testing';
import { MatAutocompleteHarness } from '@angular/material/autocomplete/testing';
import { MatDateRangeInputHarness } from '@angular/material/datepicker/testing';
import { AlertConfig } from '../alerting/alert-config.model';
import { LineChart } from '../charts/line-chart';
import { TimeZoneSettings } from '../core/time-zone';
import { Telemetry } from '../fleet/fleet.model';
import {
  TEST_API_BASE_URL,
  mixedFleetFixture,
  openFleet,
  rangeCalendar,
  reading,
} from '../fleet/testing';
import { TelemetryReport } from './report-api.service';

const REPORT_URL = `${TEST_API_BASE_URL}/reports/telemetry`;
const CLOCK = Date.parse('2026-01-03T00:00:30.000Z');

const gearboxError: AlertConfig = {
  id: 'gearbox-error',
  measurementMetric: 'gearboxTempC',
  comparison: 'above',
  valueMetric: 120,
  alertLevel: 'error',
  enabled: true,
};

const at = (hhmm: string) => `2026-01-02T${hhmm}:00.000Z`;
/** TURB002's readings with the frozen gearbox at 03:20 (flagged). */
const turbineReadings = (): Telemetry[] => [
  reading({ id: 'r1', turbineId: 'TURB002', farmId: 'FARM02', timestamp: at('03:15') }),
  reading({
    id: 'r2',
    turbineId: 'TURB002',
    farmId: 'FARM02',
    timestamp: at('03:20'),
    gearboxTempC: 126.5,
    alerts: [gearboxError],
  }),
];

/** /reporting through the real routes (mixed fleet), the client clock at 2026-01-03T00:00:30Z. */
describe('ReportingPage (/reporting)', () => {
  let app: Awaited<ReturnType<typeof openFleet>>;
  beforeEach(async () => {
    app = await openFleet('/reporting', () => CLOCK, mixedFleetFixture());
  });
  afterEach(() => app.http.verify());

  const q = <T extends Element = HTMLElement>(id: string) =>
    app.root().querySelector<T & HTMLElement>(`[data-testid=${id}]`);
  const all = (id: string) => [...app.root().querySelectorAll(`[data-testid=${id}]`)];
  const loader = () => TestbedHarnessEnvironment.loader(app.harness.fixture);

  /** Types into the autocomplete and picks the option whose text matches. */
  async function choose(typed: string, option: string | RegExp) {
    const scope = await loader().getHarness(MatAutocompleteHarness);
    await scope.enterText(typed);
    await scope.selectOption({ text: option });
    await app.stable();
  }
  async function setDays(start: string, end: string) {
    const range = await loader().getHarness(MatDateRangeInputHarness);
    await (await range.getStartInput()).setValue(start);
    await (await range.getEndInput()).setValue(end);
    await app.stable();
  }
  /**
   * Clicks Run and renders. A tick, not `whenStable()`: a valid form starts the report resource,
   * a pending task until the test flushes its request.
   */
  function run() {
    q<HTMLButtonElement>('run-report')!.click();
    TestBed.tick();
  }
  /** The pending report request (the resource sends it on change detection). */
  const expectReport = (): TestRequest => {
    TestBed.tick();
    return app.http.expectOne((r) => r.method === 'GET' && r.url === REPORT_URL);
  };
  async function respond(report: TelemetryReport) {
    expectReport().flush(report);
    await app.stable();
  }
  const charts = () =>
    app.harness.fixture.debugElement
      .queryAll((d) => d.name === 'app-line-chart')
      .map((d) => d.componentInstance as LineChart);

  it('needs a farm or turbine and the dates before it asks the API', async () => {
    expect(app.text(app.root().querySelector('h1'))).toBe('Reporting');
    expect(q<HTMLButtonElement>('download-csv')!.disabled).toBe(true); // nothing to download yet

    run();

    app.http.expectNone(REPORT_URL);
    const errors = [...app.root().querySelectorAll('mat-error')].map((e) => app.text(e));
    expect(errors).toEqual(['Choose a farm or turbine.', 'Choose the start and end dates.']);
  });

  it('offers farms and turbines in groups, filtered by what is typed', async () => {
    const scope = await loader().getHarness(MatAutocompleteHarness);
    await scope.focus();
    const groups = await scope.getOptionGroups();
    expect(await Promise.all(groups.map((g) => g.getLabelText()))).toEqual(['Farms', 'Turbines']);
    expect((await scope.getOptions()).length).toBe(3 + 7); // 3 farms, 7 turbines

    await scope.enterText('high');
    expect(await Promise.all((await scope.getOptions()).map((o) => o.getText()))).toEqual([
      'High Plains (FARM02)',
      'TURB002 · High Plains',
      'TURB004 · High Plains',
      'TURB006 · High Plains',
      'TURB007 · High Plains',
    ]);
  });

  it('runs a turbine report for whole UTC days and shows the summary, charts and table', async () => {
    await choose('TURB002', 'TURB002 · High Plains');
    expect(q<HTMLInputElement>('report-scope')!.value).toBe('TURB002 · High Plains');
    await setDays('1/1/2026', '1/2/2026');
    run();

    const req = expectReport();
    expect(req.request.params.get('turbineId')).toBe('TURB002');
    expect(req.request.params.has('farmId')).toBe(false);
    expect(req.request.params.get('from')).toBe('2026-01-01T00:00:00.000Z');
    expect(req.request.params.get('to')).toBe('2026-01-03T00:00:00.000Z'); // the day after the end
    expect(app.text(q('report-status'))).toBe('Loading report…');
    req.flush({
      scope: { kind: 'turbine', id: 'TURB002', name: 'High Plains', farmId: 'FARM02' },
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-03T00:00:00.000Z',
      readings: turbineReadings(),
    } satisfies TelemetryReport);
    await app.stable();

    expect(app.text(q('report-status'))).toBe(
      'TURB002 · High Plains, Jan 1, 2026 – Jan 2, 2026 (UTC)',
    );
    expect([q('report-readings'), q('report-turbines'), q('report-alerts')].map(app.text)).toEqual([
      '2',
      '1',
      '1',
    ]);

    // Five metric charts plus the alerts chart, over the report's days.
    expect(charts().map((c) => c.title())).toEqual([
      'Power output',
      'Wind speed',
      'Rotor speed',
      'Blade pitch',
      'Gearbox temperature',
      'Alert rules triggered',
    ]);
    expect(
      charts()[4]
        .points()
        .map((p) => p.v),
    ).toEqual([80, 126.5]);
    expect(charts()[0].domain()).toEqual({
      from: Date.parse('2026-01-01T00:00:00.000Z'),
      to: Date.parse('2026-01-03T00:00:00.000Z'),
    });
    expect(charts()[5].markers()).toEqual([
      {
        t: Date.parse(at('03:20')),
        v: 1,
        level: 'error',
        lines: ['Error: Gearbox temperature 126.5 °C > 120'],
      },
    ]);

    // The table: one row per reading (no turbine column for a turbine), alerts as a badge + count.
    const rows = all('report-row');
    expect(rows).toHaveLength(2);
    const header = [...q('report-table')!.querySelectorAll('thead th')].map((th) => app.text(th));
    expect(header[1]).toBe('Power output (kW)');
    expect(header).not.toContain('Turbine');
    expect(app.text(rows[1].querySelector('[data-testid=report-row-alerts]'))).toBe('Error 1');
    expect(app.text(rows[0].querySelector('[data-testid=report-row-alerts]'))).toBe('–');
    expect(q('report-paginator')).not.toBeNull();
  });

  it('runs a farm report: one request by farm id, farm totals in the charts, a turbine column', async () => {
    await choose('prairie', 'Prairie Ridge (FARM01)');
    await setDays('1/2/2026', '1/2/2026');
    run();

    const req = expectReport();
    expect(req.request.params.get('farmId')).toBe('FARM01');
    expect(req.request.params.get('to')).toBe('2026-01-03T00:00:00.000Z'); // one whole day
    req.flush({
      scope: { kind: 'farm', id: 'FARM01', name: 'Prairie Ridge', farmId: 'FARM01' },
      from: '2026-01-02T00:00:00.000Z',
      to: '2026-01-03T00:00:00.000Z',
      readings: [
        reading({ id: 'a', turbineId: 'TURB001', timestamp: at('03:20'), powerOutputKw: 2000 }),
        reading({ id: 'b', turbineId: 'TURB003', timestamp: at('03:20'), powerOutputKw: 1500 }),
      ],
    } satisfies TelemetryReport);
    await app.stable();

    expect(charts()[0].points()).toEqual([{ t: Date.parse(at('03:20')), v: 3500 }]); // summed
    expect(app.text(q('report-turbines'))).toBe('2');
    const header = [...q('report-table')!.querySelectorAll('thead th')].map((th) => app.text(th));
    expect(header.slice(0, 2)).toEqual(['Measured (UTC)', 'Turbine']);
  });

  const turbineReport = (from = '2026-01-01', to = '2026-01-03'): TelemetryReport => ({
    scope: { kind: 'turbine', id: 'TURB002', name: 'High Plains', farmId: 'FARM02' },
    from: `${from}T00:00:00.000Z`,
    to: `${to}T00:00:00.000Z`,
    readings: turbineReadings(),
  });

  it('runs only on Run: picking days in the calendar sends nothing, and says nothing halfway through', async () => {
    await choose('TURB002', 'TURB002 · High Plains');
    await setDays('1/1/2026', '1/2/2026');
    run();
    await respond(turbineReport());

    const calendar = rangeCalendar(q('report-range')!);
    calendar.open();
    await app.stable();
    calendar.previousMonth();
    await app.stable();
    calendar.pick(30); // a new start day: the picker clears the end day
    await app.stable();
    app.http.expectNone(REPORT_URL);
    // No "Choose the start and end dates." / range error while the end day is still to pick.
    expect(app.root().querySelectorAll('mat-error')).toHaveLength(0);
    expect(q('report-range-error')).toBeNull();
    calendar.pick(31);
    await new Promise((resolve) => setTimeout(resolve));
    await app.stable();
    expect(calendar.isOpen()).toBe(false);
    app.http.expectNone(REPORT_URL); // still the last report until Run
    expect(app.root().querySelectorAll('mat-error')).toHaveLength(0);

    run();
    const req = expectReport();
    expect([req.request.params.get('from'), req.request.params.get('to')]).toEqual([
      '2025-12-30T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ]);
    req.flush(turbineReport('2025-12-30', '2026-01-01'));
    await app.stable();
  });

  it('rejects typed text that is not an option, and a range over 31 days', async () => {
    const scope = await loader().getHarness(MatAutocompleteHarness);
    await scope.enterText('somewhere');
    await setDays('12/1/2025', '1/2/2026');
    run();

    app.http.expectNone(REPORT_URL);
    expect(app.text(app.root().querySelector('mat-error'))).toBe(
      'Choose a farm or turbine from the list.',
    );
    expect(app.text(q('report-range-error'))).toBe('Choose at most 31 days.');
  });

  it("keeps the date picker's own checks: a day after today (max) is not sent", async () => {
    await choose('TURB002', 'TURB002 · High Plains');
    await setDays('1/1/2026', '1/10/2026'); // today is Jan 3
    run();

    app.http.expectNone(REPORT_URL);
    expect(q('report-to')!.closest('mat-form-field')!.classList).toContain(
      'mat-form-field-invalid',
    );
    expect(app.text(app.root().querySelector('mat-error'))).toBe('Choose the start and end dates.');
  });

  it('shows a load error with a retry, and an empty range', async () => {
    await choose('TURB002', 'TURB002 · High Plains');
    await setDays('1/1/2026', '1/2/2026');
    run();
    expectReport().flush('boom', { status: 500, statusText: 'Server Error' });
    await app.stable();
    expect(app.text(q('report-error'))).toContain('The report could not be loaded.');

    q<HTMLButtonElement>('report-retry')!.click();
    await respond({
      scope: { kind: 'turbine', id: 'TURB002', name: 'High Plains', farmId: 'FARM02' },
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-03T00:00:00.000Z',
      readings: [],
    });
    expect(q('report-error')).toBeNull();
    expect(app.text(q('report-empty'))).toBe('No readings in this range.');
    expect(q<HTMLButtonElement>('download-csv')!.disabled).toBe(true);
  });

  it('downloads the report as CSV, built in the browser', async () => {
    await choose('TURB002', 'TURB002 · High Plains');
    await setDays('1/1/2026', '1/2/2026');
    run();
    await respond({
      scope: { kind: 'turbine', id: 'TURB002', name: 'High Plains', farmId: 'FARM02' },
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-03T00:00:00.000Z',
      readings: turbineReadings(),
    });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:report');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    expect(q<HTMLButtonElement>('download-csv')!.disabled).toBe(false);
    q<HTMLButtonElement>('download-csv')!.click();

    const csv = await (create.mock.calls[0][0] as Blob).text();
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3); // header + 2 readings
    expect(lines[2].endsWith(',error:gearbox_temp_c above 120')).toBe(true);
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(
      'report-TURB002-2026-01-01-2026-01-02.csv',
    );
    app.http.expectNone(REPORT_URL); // no second request
    vi.restoreAllMocks();
  });
});

/** Local time (Settings → Local, browser zone America/Chicago): local days and times. */
describe('ReportingPage in local time', () => {
  let app: Awaited<ReturnType<typeof openFleet>>;
  beforeEach(async () => {
    app = await openFleet('/reporting', () => CLOCK, mixedFleetFixture(), undefined, 'admin', {
      timeZone: 'local',
    });
  });
  afterEach(() => app.http.verify());

  const q = (id: string) => app.root().querySelector<HTMLElement>(`[data-testid=${id}]`);
  const loader = () => TestbedHarnessEnvironment.loader(app.harness.fixture);
  const expectReport = (): TestRequest => {
    TestBed.tick();
    return app.http.expectOne((r) => r.method === 'GET' && r.url === REPORT_URL);
  };
  const range = (req: TestRequest) => [
    req.request.params.get('from'),
    req.request.params.get('to'),
  ];

  it('reports whole local days, shows local times and re-runs for the same days on a zone change', async () => {
    const scope = await loader().getHarness(MatAutocompleteHarness);
    await scope.enterText('TURB002');
    await scope.selectOption({ text: 'TURB002 · High Plains' });
    const picker = await loader().getHarness(MatDateRangeInputHarness);
    expect(await (await picker.getEndInput()).getMax()).toBe('2026-01-02'); // today, locally
    await (await picker.getStartInput()).setValue('1/1/2026');
    await (await picker.getEndInput()).setValue('1/2/2026');
    await app.stable();
    q('run-report')!.click();

    const req = expectReport();
    expect(range(req)).toEqual(['2026-01-01T06:00:00.000Z', '2026-01-03T06:00:00.000Z']);
    req.flush({
      scope: { kind: 'turbine', id: 'TURB002', name: 'High Plains', farmId: 'FARM02' },
      from: '2026-01-01T06:00:00.000Z',
      to: '2026-01-03T06:00:00.000Z',
      readings: turbineReadings(),
    } satisfies TelemetryReport);
    await app.stable();

    expect(app.text(q('report-status'))).toBe(
      'TURB002 · High Plains, Jan 1, 2026 – Jan 2, 2026 (local)',
    );
    expect(app.text(q('report-range')!.querySelector('mat-label'))).toBe('Dates (local)');
    const table = q('report-table')!;
    expect(app.text(table.querySelector('thead th'))).toBe('Measured (local)');
    expect(app.text(table.querySelector('tbody td'))).toBe('Jan 1, 21:15'); // 03:15 UTC

    // The file name names the local days; the rows keep their ISO UTC timestamps.
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:report');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    q('download-csv')!.click();
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(
      'report-TURB002-2026-01-01-2026-01-02.csv',
    );
    expect(await (create.mock.calls[0][0] as Blob).text()).toContain('2026-01-02T03:15:00.000Z');
    vi.restoreAllMocks();

    TestBed.inject(TimeZoneSettings).setMode('utc');
    const again = expectReport();
    expect(range(again)).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z']);
    again.flush({
      scope: { kind: 'turbine', id: 'TURB002', name: 'High Plains', farmId: 'FARM02' },
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-03T00:00:00.000Z',
      readings: turbineReadings(),
    } satisfies TelemetryReport);
    await app.stable();
    expect(app.text(q('report-status'))).toBe(
      'TURB002 · High Plains, Jan 1, 2026 – Jan 2, 2026 (UTC)',
    );
  });

  it('does not run a report on a zone change before the first run', async () => {
    TestBed.inject(TimeZoneSettings).setMode('utc');
    await app.stable();
    app.http.expectNone(REPORT_URL);
  });
});

/** The report charts' `@defer (when hasCharts(); prefetch on idle)`, driven by hand. */
describe('ReportingPage deferred charts (@defer)', () => {
  let app: Awaited<ReturnType<typeof openFleet>>;
  beforeEach(async () => {
    app = await openFleet('/reporting', () => CLOCK, mixedFleetFixture(), undefined, 'admin', {
      deferBlockBehavior: DeferBlockBehavior.Manual,
    });
    await app.stable();
  });
  afterEach(() => app.http.verify());

  const q = (id: string) => app.root().querySelector<HTMLElement>(`[data-testid=${id}]`);
  const all = (selector: string) => [...app.root().querySelectorAll<HTMLElement>(selector)];

  async function runReport() {
    const loader = TestbedHarnessEnvironment.loader(app.harness.fixture);
    const scope = await loader.getHarness(MatAutocompleteHarness);
    await scope.enterText('TURB002');
    await scope.selectOption({ text: 'TURB002 · High Plains' });
    const range = await loader.getHarness(MatDateRangeInputHarness);
    await (await range.getStartInput()).setValue('1/1/2026');
    await (await range.getEndInput()).setValue('1/2/2026');
    await app.stable();
    q('run-report')!.click();
    TestBed.tick();
    app.http
      .expectOne((r) => r.url === REPORT_URL)
      .flush({
        scope: { kind: 'turbine', id: 'TURB002', name: 'High Plains', farmId: 'FARM02' },
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-03T00:00:00.000Z',
        readings: turbineReadings(),
      } satisfies TelemetryReport);
    await app.stable();
  }

  it('shows nothing before a report, a card per chart until ECharts loads, then the charts', async () => {
    const [charts] = await app.harness.fixture.getDeferBlocks();
    expect(q('chart-skeleton')).toBeNull(); // no report yet: no space reserved

    await runReport();

    // Tiles and table are there at once; the charts' place is held by a card per chart.
    expect(app.text(q('report-readings'))).toBe('2');
    expect(all('[data-testid=report-row]')).toHaveLength(2);
    expect(all('[data-testid=chart-skeleton-card]').map((c) => app.text(c))).toEqual([
      'Power output',
      'Wind speed',
      'Rotor speed',
      'Blade pitch',
      'Gearbox temperature',
      'Alert rules triggered',
    ]);
    expect(all('app-line-chart')).toHaveLength(0);

    await charts.render(DeferBlockState.Complete);
    await app.stable();

    expect(q('chart-skeleton')).toBeNull();
    expect(q('report-charts')).not.toBeNull();
    expect(all('app-line-chart')).toHaveLength(6);
  });

  it('announces the loading state and keeps the table when the chunk fails', async () => {
    const [charts] = await app.harness.fixture.getDeferBlocks();
    await runReport();

    await charts.render(DeferBlockState.Loading);
    await app.stable();
    expect(app.text(q('charts-loading'))).toBe('Loading charts…');

    await charts.render(DeferBlockState.Error);
    await app.stable();
    expect(q('charts-load-error')!.getAttribute('role')).toBe('alert');
    expect(all('[data-testid=report-row]')).toHaveLength(2);
  });
});
