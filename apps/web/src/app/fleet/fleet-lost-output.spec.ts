import { Subject, of, throwError } from 'rxjs';
import { AnomalyReport } from '../alerting/anomaly.model';
import { openFleet } from './testing';

const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
const report = (estimatedLostKwh: number): AnomalyReport => ({
  from: '',
  to: '',
  estimatedLostKwh,
  anomalies: [],
});

describe('Fleet overview: estimated lost output tile', () => {
  const open = async (answer: () => unknown) => {
    const app = await openFleet(
      '/farms',
      () => CLOCK,
      undefined,
      ({ anomalies }) => anomalies.list.mockImplementation(answer as never),
    );
    await app.stable();
    const tile = app.root().querySelector<HTMLElement>('[data-testid=fleet-lost-output]')!;
    return { app, tile, text: app.text(tile) };
  };

  it.each([
    [849.6, '850 kWh'],
    [1000, '1.0 MWh'],
    [12_345, '12.3 MWh'],
    [0, '0 kWh'],
  ])('shows %s kWh as %s, linking to the Anomalies tab, from one request', async (kwh, shown) => {
    const { app, tile, text } = await open(() => of(report(kwh)));
    expect(text).toBe(shown);
    expect(tile.querySelector('a')!.getAttribute('href')).toBe('/alerting/anomalies');
    expect(app.anomalies.list).toHaveBeenCalledTimes(1);
    expect(app.anomalies.list).toHaveBeenCalledWith(
      '2025-12-27T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z',
    );
    app.sse.pushEvent('fleet.changed', { turbineId: 'TURB001' });
    await app.stable();
    expect(app.anomalies.list).toHaveBeenCalledTimes(1);
  });

  it('shows a dash when the request fails, and the rest of the page is unaffected', async () => {
    const { app, text } = await open(() => throwError(() => new Error('500')));
    expect(text).toBe('–');
    expect(app.root().querySelector('[data-testid=fleet-lost-output] mat-spinner')).toBeNull();
    expect(app.root().querySelector('[data-testid=fleet-power]')).not.toBeNull();
    expect(app.root().querySelector('[data-testid=farms]')).not.toBeNull();
    expect(app.root().querySelector('[data-testid=fleet-error]')).toBeNull();
  });

  it('shows a spinner and no link while the request is pending, then the value', async () => {
    const answer = new Subject<AnomalyReport>();
    const app = await openFleet(
      '/farms',
      () => CLOCK,
      undefined,
      ({ anomalies }) => anomalies.list.mockImplementation((() => answer) as never),
    );
    const tile = () => app.root().querySelector<HTMLElement>('[data-testid=fleet-lost-output]')!;
    await new Promise((r) => setTimeout(r));
    expect(tile().querySelector('mat-spinner')).not.toBeNull();
    expect(tile().querySelector('mat-spinner')!.getAttribute('aria-label')).toBe(
      'Loading estimated lost output',
    );
    expect(tile().querySelector('a')).toBeNull();
    answer.next(report(12_345));
    answer.complete();
    await app.stable();
    expect(tile().querySelector('mat-spinner')).toBeNull();
    expect(app.text(tile())).toBe('12.3 MWh');
    expect(tile().querySelector('a')).not.toBeNull();
  });
});
