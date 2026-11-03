import { Router } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { NEVER, Observable, of, throwError } from 'rxjs';
import { openFleet } from '../fleet/testing';
import { Anomaly, AnomalyReport } from './anomaly.model';

const CLOCK = Date.parse('2026-01-08T12:00:30.000Z');

const lowPower: Anomaly = {
  turbineId: 'TURB001',
  farmId: 'FARM01',
  kind: 'low_power_in_wind',
  metric: null,
  start: '2026-01-07T13:40:00.000Z',
  end: '2026-01-07T13:50:00.000Z',
  readings: 3,
  value: null,
  windSpeedMs: 15.84,
  estimatedLostKwh: 850.4,
};
const stuck: Anomaly = {
  turbineId: 'TURB002',
  farmId: 'FARM02',
  kind: 'stuck_sensor',
  metric: 'gearboxTempC',
  start: '2026-01-02T03:20:00.000Z',
  end: '2026-01-02T03:30:00.000Z',
  readings: 3,
  value: 126.5,
  windSpeedMs: null,
  estimatedLostKwh: null,
};
const report = (anomalies: Anomaly[], estimatedLostKwh = 850.4): AnomalyReport => ({
  from: '',
  to: '',
  estimatedLostKwh,
  anomalies,
});

describe('AnomaliesPage (/alerting/anomalies)', () => {
  let app: Awaited<ReturnType<typeof openFleet>>;
  const q = (id: string) => app.root().querySelector<HTMLElement>(`[data-testid=${id}]`);
  const open = async (
    answer: () => Observable<AnomalyReport>,
    options?: Parameters<typeof openFleet>[5],
  ) => {
    app = await openFleet(
      '/alerting/anomalies',
      () => CLOCK,
      undefined,
      ({ anomalies }) => anomalies.list.mockImplementation(answer as never),
      'viewer',
      options,
    );
    await app.stable();
  };

  it('asks for the 7 days ending at the client clock, once', async () => {
    await open(() => of(report([])));
    expect(app.anomalies.list).toHaveBeenCalledTimes(1);
    expect(app.anomalies.list).toHaveBeenCalledWith(
      '2026-01-01T12:00:30.000Z',
      '2026-01-08T12:00:30.000Z',
    );
    app.sse.pushEvent('fleet.changed', { turbineId: 'TURB001' });
    await app.stable();
    expect(app.anomalies.list).toHaveBeenCalledTimes(1);
  });

  it('shows both kinds, links the turbine and says the loss is an estimate', async () => {
    await open(() => of(report([lowPower, stuck])));
    const rows = [...app.root().querySelectorAll<HTMLElement>('[data-testid=anomaly]')];
    expect(rows.map((r) => [r.dataset['turbineId'], r.dataset['kind']])).toEqual([
      ['TURB001', 'low_power_in_wind'],
      ['TURB002', 'stuck_sensor'],
    ]);
    const [low, st] = rows.map(
      (r) => (id: string) => app.text(r.querySelector(`[data-testid=${id}]`)),
    );
    expect(low('anomaly-kind')).toBe('Low power in strong wind');
    expect(low('anomaly-detail')).toContain('15.8 m/s');
    expect(low('anomaly-start')).toBe('Jan 7, 13:40 UTC');
    expect(low('anomaly-duration')).toBe('15 min');
    expect(low('anomaly-lost')).toBe('850 kWh');
    expect(st('anomaly-kind')).toBe('Stuck sensor');
    expect(st('anomaly-detail')).toBe('Gearbox temperature stuck at 126.5 °C');
    expect(st('anomaly-lost')).toBe('–');
    expect(rows[0].querySelector('a')!.getAttribute('href')).toBe('/farms/FARM01/turbines/TURB001');
    expect(app.text(q('anomalies-note'))).toBe(
      'Lost output is an estimate from the median output of the fleet at the same wind speed.',
    );
  });

  it('marks the serious kind apart from the stuck sensor and labels the table', async () => {
    await open(() => of(report([lowPower, stuck])));
    const [low, st] = [...app.root().querySelectorAll('[data-testid=anomaly-kind]')];
    expect(low.className).toContain('bg-danger');
    expect(st.className).not.toContain('bg-danger');
    const headers = [...app.root().querySelectorAll('th')].map((h) => app.text(h));
    expect(headers).toEqual([
      'Turbine',
      'Farm',
      'Kind',
      'Detail',
      'Start',
      'Duration',
      'Est. lost output',
    ]);
    expect(q('anomalies-scroll')!.getAttribute('aria-label')).toBe('Anomalies');
  });

  it('pages 25 anomalies at a time', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...lowPower, turbineId: `T${i}` }));
    await open(() => of(report(many)));
    const rows = () => app.root().querySelectorAll('[data-testid=anomaly]').length;
    expect(rows()).toBe(25);
    app.root().querySelector<HTMLElement>('.mat-mdc-paginator-navigation-next')!.click();
    await app.stable();
    expect(rows()).toBe(5);
  });

  it('shows times in the zone chosen in Settings', async () => {
    await open(() => of(report([lowPower])), { timeZone: 'local' });
    expect(app.text(q('anomaly-start'))).toBe('Jan 7, 07:40 CST');
  });

  it('names the farm, or falls back to its id', async () => {
    await open(() => of(report([lowPower, { ...stuck, farmId: 'FARM77' }])));
    const farms = [...app.root().querySelectorAll('[data-testid=anomaly-farm]')].map((e) =>
      app.text(e),
    );
    expect(farms[0]).toMatch(/\S.*FARM01$/);
    expect(farms[0]).not.toBe('FARM01');
    expect(farms[1]).toBe('FARM77');
    expect(app.text(q('anomalies-total'))).toBe('Estimated lost output: 850 kWh');
  });

  it('shows loading until the answer arrives', async () => {
    app = await openFleet(
      '/alerting/anomalies',
      () => CLOCK,
      undefined,
      ({ anomalies }) => anomalies.list.mockImplementation(() => NEVER),
    );
    TestBed.tick();
    expect(app.text(q('anomalies-loading'))).toBe('Loading anomalies…');
  });

  it('shows a dash for an unknown mean wind', async () => {
    await open(() => of(report([{ ...lowPower, windSpeedMs: null }])));
    expect(app.text(q('anomaly-detail'))).toBe('Mean wind –');
  });

  it('says so when there are none', async () => {
    await open(() => of(report([], 0)));
    expect(app.text(q('anomalies-empty'))).toBe('No anomalies in the last 7 days.');
    expect(q('anomalies')).toBeNull();
  });

  it('shows an error and loads again on Retry', async () => {
    let calls = 0;
    await open(() => (calls++ === 0 ? throwError(() => new Error('boom')) : of(report([stuck]))));
    expect(q('anomalies-error')).not.toBeNull();
    q('anomalies-retry')!.click();
    await new Promise((r) => setTimeout(r));
    await app.stable();
    expect(app.anomalies.list).toHaveBeenCalledTimes(2);
    expect(q('anomalies-error')).toBeNull();
    expect(q('anomaly')).not.toBeNull();
  });

  it('is a tab of Alerting for every role, current on its own route', async () => {
    await open(() => of(report([])));
    expect(TestBed.inject(Router).url).toBe('/alerting/anomalies');
    const tab = q('alerting-tab-anomalies')!;
    expect(app.text(tab)).toBe('Anomalies');
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(q('alerting-tab-history')!.getAttribute('aria-selected')).toBe('false');
  });
});
