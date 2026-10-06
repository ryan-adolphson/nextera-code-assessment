import { farmsFixture, mixedFleetFixture, openFleet, reading } from './testing';

/** /alerting through the real routes. */
describe('AlertsPage (/alerting)', () => {
  const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
  let clockNow: number;
  let app: Awaited<ReturnType<typeof openFleet>>;
  beforeEach(() => (clockNow = CLOCK));
  afterEach(() => vi.useRealTimers());

  const open = async (farms = mixedFleetFixture()) =>
    (app = await openFleet('/alerting', () => clockNow, farms));
  const rows = () => [...app.root().querySelectorAll('[data-testid=alert]')];
  const count = (level: string) =>
    app.text(app.root().querySelector(`[data-testid=alert-count-${level}]`));
  const navCount = () =>
    app.text(app.root().querySelector('[data-testid=nav-alerting] [data-testid=alert-count]'));
  const cells = (row: Element) => [...row.querySelectorAll('td')].map((td) => app.text(td));

  it('lists the turbines needing attention worst first, with farm, status and age', async () => {
    await open();
    expect(app.text(app.root().querySelector('h1'))).toBe('Alerting');
    expect(rows().map(cells)).toEqual([
      ['TURB007', 'High Plains FARM02', 'No data in 60 min', 'Jan 2, 21:30', '2 h 30 min'],
      ['TURB005', 'Prairie Ridge FARM01', 'No data in 60 min', 'Jan 2, 22:00', '2 h'],
      ['TURB006', 'High Plains FARM02', 'No data in 30 min', 'Jan 2, 23:20', '40 min'],
      ['TURB003', 'Prairie Ridge FARM01', 'No data in 15 min', 'Jan 2, 23:40', '20 min'],
      ['TURB004', 'High Plains FARM02', 'No readings yet', 'Never reported', '–'],
    ]);
    expect(rows().map((r) => r.getAttribute('data-staleness'))).toEqual([
      'stale-60',
      'stale-60',
      'stale-30',
      'stale-15',
      'empty',
    ]);
    expect(app.text(app.root().querySelector('h2'))).toBe('5 turbines need attention');
  });

  it('links each alert to its turbine page and farm', async () => {
    await open();
    expect([...rows()[0].querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      '/farms/FARM02/turbines/TURB007',
      '/farms/FARM02',
    ]);
  });

  it('counts each level in tiles, and the total on the nav item', async () => {
    await open();
    const tiles = [...app.root().querySelectorAll('[aria-label="Alerts by level"] app-stat-tile')];
    expect(tiles.map((t) => [...t.querySelectorAll('span')].map((x) => app.text(x)))).toEqual([
      ['No data in 60 min', '2'],
      ['No data in 30 min', '1'],
      ['No data in 15 min', '1'],
      ['Never reported', '1'],
    ]);
    expect(count('stale-60')).toBe('2');
    expect(count('empty')).toBe('1');
    expect(navCount()).toBe('5');
  });

  it('drops a turbine that reports again, live', async () => {
    await open();
    app.sse.push(
      reading({ turbineId: 'TURB004', farmId: 'FARM02', timestamp: '2026-01-03T00:00:00.000Z' }),
    );
    await app.stable();

    expect(rows().map((r) => r.getAttribute('data-turbine-id'))).toEqual([
      'TURB007',
      'TURB005',
      'TURB006',
      'TURB003',
    ]);
    expect(count('empty')).toBe('0');
    expect(navCount()).toBe('4');
  });

  it('says all turbines are reporting when none needs attention', async () => {
    await open(farmsFixture());
    expect(rows()).toHaveLength(0);
    expect(app.text(app.root().querySelector('[data-testid=no-alerts]'))).toBe(
      'All turbines are reporting.',
    );
    expect(count('stale-60')).toBe('0');
    expect(navCount()).toBeUndefined();
  });

  it('raises and escalates alerts on the clock alone, updating the age', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true }); // timers only; the clock is NOW
    await open(farmsFixture());
    async function advance(minutes: number) {
      clockNow += minutes * 60_000;
      await vi.advanceTimersByTimeAsync(minutes * 60_000);
      await app.stable();
    }

    await advance(11); // 16 min after 23:55
    expect(rows().map((r) => r.getAttribute('data-staleness'))).toEqual(['stale-15', 'stale-15']);
    expect(rows().map((r) => cells(r)[4])).toEqual(['16 min', '16 min']);
    expect(navCount()).toBe('2');

    await advance(45); // 61 min
    expect(count('stale-60')).toBe('2');
    expect(count('stale-15')).toBe('0');
    expect(rows().map((r) => cells(r)[4])).toEqual(['1 h 1 min', '1 h 1 min']);
  });

  it('explains when there are no turbines at all', async () => {
    await open([{ id: 'FARM03', name: 'Red Canyon', latitude: 35, longitude: -106, turbines: [] }]);
    expect(app.text(app.root().querySelector('[data-testid=no-alerts]'))).toBe(
      'No turbines are registered yet.',
    );
  });
});
