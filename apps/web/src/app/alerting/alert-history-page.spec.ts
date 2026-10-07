import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { MatPaginatorHarness } from '@angular/material/paginator/testing';
import { Title } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { Telemetry } from '../fleet/fleet.model';
import { TEST_API_BASE_URL, openFleet, reading } from '../fleet/testing';
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
  const expectAlerts = (): TestRequest =>
    app.http.expectOne((r) => r.method === 'GET' && r.url === ALERTS_URL);
  async function flush(readings: Telemetry[]) {
    expectAlerts().flush(readings);
    await app.stable();
  }
  async function setRange(id: 'history-from' | 'history-to', value: string) {
    const input = q<HTMLInputElement>(id)!;
    input.value = value;
    input.dispatchEvent(new Event('change'));
    await app.stable();
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

  beforeEach(async () => {
    app = await openFleet('/alerting/history', () => CLOCK);
  });

  it('asks for the last 24 hours by default (to the next minute) and shows them in the range fields', async () => {
    const req = expectAlerts();
    expect(req.request.params.get('from')).toBe('2026-01-02T00:01:00.000Z');
    expect(req.request.params.get('to')).toBe('2026-01-03T00:01:00.000Z');
    req.flush([]);
    await app.stable();

    expect(q<HTMLInputElement>('history-from')!.value).toBe('2026-01-02T00:01');
    expect(q<HTMLInputElement>('history-to')!.value).toBe('2026-01-03T00:01');
    expect(q<HTMLInputElement>('history-from')!.type).toBe('datetime-local');
    expect(TestBed.inject(Title).getTitle()).toBe('Alert history · Nextera');
    expect(q('alerting-tab-history')!.getAttribute('aria-current')).toBe('page');
    expect(app.text(q('history-empty'))).toBe('No alerts in this range.');
    expect(app.text(q('history-count'))).toBe('0 flagged readings on 0 turbines');
  });

  it('shows one expandable summary row per turbine, with each distinct rule as a Material chip', async () => {
    await flush(flagged());

    expect(summaries()).toEqual([
      [
        '', // the expand button: named by aria-label

        'TURB001',
        'Prairie Ridge FARM01',
        'Jan 2, 13:40',
        ['Info: Power output below 100 kW ×1'],
      ],
      [
        '',
        'TURB002',
        'High Plains FARM02',
        'Jan 2, 03:30',
        [
          'Error: Gearbox temperature above 120 °C ×3',
          'Warning: Gearbox temperature above 90 °C ×3',
        ],
      ],
    ]);
    expect(app.text(q('history-count'))).toBe('4 flagged readings on 2 turbines');
    expect(all('history-turbine').map((tr) => tr.getAttribute('data-level'))).toEqual([
      'info',
      'error',
    ]);

    // Material table with multiTemplateDataRows; the chips are Material chips coloured by level.
    expect(q('alert-history')!.classList).toContain('mat-mdc-table');
    const chips = [...all('history-turbine')[1].querySelectorAll('[data-testid=alert-chip]')];
    expect(chips.map((c) => [c.tagName, c.getAttribute('data-level')])).toEqual([
      ['MAT-CHIP', 'error'],
      ['MAT-CHIP', 'warn'],
    ]);
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

    await setRange('history-from', '2026-01-02T03:00');
    const req = expectAlerts();
    expect(req.request.params.get('from')).toBe('2026-01-02T03:00:00.000Z');
    expect(req.request.params.get('to')).toBe('2026-01-03T00:01:00.000Z');
    req.flush(flagged().slice(1));
    await app.stable();
    expect(all('history-turbine')).toHaveLength(1);

    await setRange('history-to', '2026-01-02T02:00');
    app.http.expectNone(ALERTS_URL);
    expect(app.text(q('history-range-error'))).toBe('The end must be after the start.');
    expect(all('history-turbine')).toHaveLength(1); // the last results stay

    await setRange('history-to', '2026-02-05T00:00');
    app.http.expectNone(ALERTS_URL);
    expect(app.text(q('history-range-error'))).toBe('Choose at most 31 days.');
  });

  it('shows a load error with a retry', async () => {
    expectAlerts().flush('boom', { status: 500, statusText: 'Server Error' });
    await app.stable();
    expect(app.text(q('history-error'))).toContain('The alerts could not be loaded.');

    q<HTMLButtonElement>('history-retry')!.click();
    await app.stable();
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
