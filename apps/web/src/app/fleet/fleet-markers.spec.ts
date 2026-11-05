import { FARM_LEGEND, TURBINE_LEGEND, farmMarkers, turbineMarkers } from './fleet-markers';
import { FarmSummary } from './fleet.store';
import { TurbineMarkerResponse } from './fleet.model';

const farm = (overrides: Partial<FarmSummary> = {}): FarmSummary => ({
  id: 'FARM01',
  name: 'Prairie Ridge',
  latitude: 41.25,
  longitude: -96.53,
  turbineCount: 1,
  commissioned: 1,
  reporting: 1,
  stale: 0,
  alerting: 0,
  staleness: 'ok',
  powerKw: 1960.5,
  avgWindMs: 6.7,
  asOf: '2026-01-02T23:55:00.000Z',
  ...overrides,
});

describe('farmMarkers', () => {
  it('places farms at their coordinates with a summary tooltip', () => {
    expect(farmMarkers([farm()])).toEqual([
      {
        id: 'FARM01',
        lat: 41.25,
        lng: -96.53,
        status: 'ok',
        radius: 9,
        tooltip: ['Prairie Ridge', '1 / 1 turbines reporting · 1,961 kW'],
      },
    ]);
  });

  it("colours a farm by its freshest turbine's level and names the level", () => {
    const [stale, never, none] = farmMarkers([
      farm({ reporting: 0, powerKw: 0, staleness: 'stale-30' }),
      farm({ id: 'FARM02', reporting: 0, powerKw: 0, staleness: 'empty' }),
      farm({ id: 'FARM03', turbineCount: 0, reporting: 0, staleness: 'empty' }),
    ]);
    expect(stale).toMatchObject({
      status: 'stale-30',
      tooltip: ['Prairie Ridge', '0 / 1 turbines reporting · 0 kW', 'No data in 30 min'],
    });
    expect(never.status).toBe('empty'); // has turbines, none ever reported
    expect(none).toMatchObject({
      status: 'empty',
      tooltip: ['Prairie Ridge', 'No turbines registered'],
    });
  });

  it('sizes markers by turbine count, capped for large farms', () => {
    const radii = farmMarkers([0, 5, 50].map((n) => farm({ turbineCount: n }))).map(
      (m) => m.radius,
    );
    expect(radii).toEqual([7, 17, 18]);
  });
});

describe('turbineMarkers', () => {
  const NOW_MS = Date.parse('2026-01-03T00:00:00.000Z');
  const marker = (overrides: Partial<TurbineMarkerResponse> = {}): TurbineMarkerResponse => ({
    id: 'TURB001',
    latitude: 41.263,
    longitude: -96.518,
    status: 'reporting',
    timestamp: '2026-01-02T23:55:00.000Z',
    ...overrides,
  });

  it('places turbines at their own coordinates with their level', () => {
    expect(turbineMarkers([marker()], NOW_MS)).toEqual([
      {
        id: 'TURB001',
        lat: 41.263,
        lng: -96.518,
        status: 'ok',
        radius: 9,
        tooltip: ['TURB001', 'Reporting'],
      },
    ]);
  });

  it('flags each staleness level by colour and label, and turbines without readings', () => {
    const markers = turbineMarkers(
      [
        marker({ status: 'stale', timestamp: '2026-01-02T23:40:00.000Z' }),
        marker({ status: 'stale', timestamp: '2026-01-02T23:20:00.000Z' }),
        marker({ status: 'stale', timestamp: '2026-01-02T22:00:00.000Z' }),
        marker({ id: 'TURB009', status: 'no_data', timestamp: null }),
      ],
      NOW_MS,
    );
    expect(markers.map((m) => [m.status, m.tooltip.at(-1)])).toEqual([
      ['stale-15', 'No data in 15 min'],
      ['stale-30', 'No data in 30 min'],
      ['stale-60', 'No data in 60 min'],
      ['empty', 'No readings yet'],
    ]);
    expect(markers[3].tooltip).toEqual(['TURB009', 'No readings yet']);
  });

  it('never shows a turbine the server calls stale as reporting', () => {
    // The server's clock is ahead of ours: its "stale" reading is only 5 minutes old here.
    const [m] = turbineMarkers([marker({ status: 'stale' })], NOW_MS);
    expect(m.status).toBe('stale-15');
  });

  it('shows a turbine without a time as having no readings', () => {
    const [m] = turbineMarkers([marker({ status: 'reporting', timestamp: null })], NOW_MS);
    expect(m.status).toBe('empty');
  });
});

describe('legends', () => {
  it('list reporting, the three levels and the empty state', () => {
    expect(TURBINE_LEGEND).toEqual([
      { status: 'ok', label: 'Reporting' },
      { status: 'stale-15', label: 'No data in 15 min' },
      { status: 'stale-30', label: 'No data in 30 min' },
      { status: 'stale-60', label: 'No data in 60 min' },
      { status: 'empty', label: 'No readings yet' },
    ]);
    expect(FARM_LEGEND.at(-1)).toEqual({ status: 'empty', label: 'No turbines or readings' });
    expect(FARM_LEGEND.slice(0, 4)).toEqual(TURBINE_LEGEND.slice(0, 4));
  });
});
