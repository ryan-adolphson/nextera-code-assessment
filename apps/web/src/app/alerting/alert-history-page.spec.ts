import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { MatPaginatorHarness } from '@angular/material/paginator/testing';
import { Title } from '@angular/platform-browser';
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
  /** Each table row as text: a group header, or a reading's time and its chips (" | "). */
  const table = () =>
    [...app.root().querySelectorAll('[data-testid=alert-history] tbody tr')].map((tr) => {
      const chips = [...tr.querySelectorAll('[data-testid=alert-chip]')];
      if (!chips.length) return app.text(tr);
      return `${app.text(tr.querySelector('td'))} ${chips.map((c) => app.text(c)).join(' | ')}`;
    });

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

  it('groups the readings by turbine, with each triggered rule as a Material chip', async () => {
    await flush(flagged());

    expect(table()).toEqual([
      'TURB001 · Prairie Ridge FARM01 · 1 flagged reading',
      'Jan 2, 13:40 Info: Power output 0 kW < 100',
      'TURB002 · High Plains FARM02 · 3 flagged readings',
      'Jan 2, 03:30 Error: Gearbox temperature 126.5 °C > 120 | Warning: Gearbox temperature 126.5 °C > 90',
      'Jan 2, 03:25 Error: Gearbox temperature 126.5 °C > 120 | Warning: Gearbox temperature 126.5 °C > 90',
      'Jan 2, 03:20 Error: Gearbox temperature 126.5 °C > 120 | Warning: Gearbox temperature 126.5 °C > 90',
    ]);
    expect(app.text(q('history-count'))).toBe('4 flagged readings on 2 turbines');

    // Group headers span the row and link to the turbine.
    const [group] = all('history-group');
    expect(group.querySelector('td')!.getAttribute('colspan')).toBe('2');
    expect(group.querySelector('a')!.getAttribute('href')).toBe('/farms/FARM01/turbines/TURB001');

    // Chips: Material chips in a labelled chip set, coloured by level, worst first.
    const reading = all('history-reading')[1];
    const chips = [...reading.querySelectorAll('[data-testid=alert-chip]')];
    expect(chips.map((c) => [c.tagName, c.getAttribute('data-level')])).toEqual([
      ['MAT-CHIP', 'error'],
      ['MAT-CHIP', 'warn'],
    ]);
    expect(chips[0].classList).toContain('mat-mdc-chip');
    expect(
      reading.querySelector('[data-testid=reading-alert-chips]')!.getAttribute('aria-label'),
    ).toBe('Triggered alerts');
  });

  it('pages 25 readings at a time and repeats a turbine’s header when it continues', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      reading({
        id: `r${i}`,
        turbineId: 'TURB002',
        farmId: 'FARM02',
        timestamp: new Date(Date.parse('2026-01-02T23:55:00Z') - i * 300_000).toISOString(),
        alerts: [rule()],
      }),
    );
    await flush(many);
    const pages = await TestbedHarnessEnvironment.loader(app.harness.fixture).getHarness(
      MatPaginatorHarness.with({ selector: '[data-testid=history-paginator]' }),
    );

    expect(await pages.getRangeLabel()).toBe('1 – 25 of 30');
    expect(all('history-reading')).toHaveLength(25);
    expect(table()[0]).toBe('TURB002 · High Plains FARM02 · 30 flagged readings');

    await pages.goToNextPage();
    expect(all('history-reading')).toHaveLength(5);
    expect(table()[0]).toBe('TURB002 · High Plains FARM02 · 30 flagged readings (continued)');
  });

  it('reloads when the range changes, and explains an invalid range without asking the API', async () => {
    await flush(flagged());

    await setRange('history-from', '2026-01-02T03:00');
    const req = expectAlerts();
    expect(req.request.params.get('from')).toBe('2026-01-02T03:00:00.000Z');
    expect(req.request.params.get('to')).toBe('2026-01-03T00:01:00.000Z');
    req.flush(flagged().slice(1));
    await app.stable();
    expect(all('history-reading')).toHaveLength(3);

    await setRange('history-to', '2026-01-02T02:00');
    app.http.expectNone(ALERTS_URL);
    expect(app.text(q('history-range-error'))).toBe('The end must be after the start.');
    expect(all('history-reading')).toHaveLength(3); // the last results stay

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
    expect(all('history-reading')).toHaveLength(4);
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
