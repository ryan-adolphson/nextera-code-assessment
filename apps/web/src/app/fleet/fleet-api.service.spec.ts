import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../core/api-base-url';
import { SESSION_STORAGE_KEY } from '../core/auth/auth.store';
import { FleetApi } from './fleet-api.service';

describe('FleetApi', () => {
  let api: FleetApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: 'https://api.example.com/api' },
      ],
    });
    api = TestBed.inject(FleetApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('loads the fleet totals', async () => {
    const result = firstValueFrom(api.fleetSummary());
    http
      .expectOne({ method: 'GET', url: 'https://api.example.com/api/fleet/summary' })
      .flush({ farms: 1 });
    expect(await result).toEqual({ farms: 1 });
  });

  it('loads the farm summaries, not the whole fleet', async () => {
    const result = firstValueFrom(api.farmSummaries());
    http.expectOne({ method: 'GET', url: 'https://api.example.com/api/farm-summaries' }).flush([]);
    expect(await result).toEqual([]);
  });

  it('asks for a page of turbines with only the query parts that are set', async () => {
    const result = firstValueFrom(
      api.turbines({
        farmId: 'FARM01',
        q: 'TURB',
        status: 'stale',
        commissioned: false,
        hasData: true,
        sort: 'power',
        dir: 'desc',
        limit: 25,
        cursor: 'abc',
      }),
    );
    const req = http.expectOne((r) => r.url === 'https://api.example.com/api/turbines');
    expect(
      Object.fromEntries(req.request.params.keys().map((k) => [k, req.request.params.get(k)])),
    ).toEqual({
      farmId: 'FARM01',
      q: 'TURB',
      status: 'stale',
      commissioned: 'false',
      hasData: 'true',
      sort: 'power',
      dir: 'desc',
      limit: '25',
      cursor: 'abc',
    });
    req.flush({ items: [], nextCursor: null, prevCursor: null, total: 0, totalCapped: false });
    expect((await result).items).toEqual([]);
  });

  it('leaves out empty, null and undefined query parts', () => {
    firstValueFrom(api.turbines({ q: '', cursor: null, farmId: undefined, limit: 25 }));
    const req = http.expectOne((r) => r.url === 'https://api.example.com/api/turbines');
    expect(req.request.params.keys()).toEqual(['limit']);
    req.flush(null);
  });

  it('searches turbines by id and returns just the items', async () => {
    const result = firstValueFrom(api.searchTurbines('T1', 5));
    const req = http.expectOne((r) => r.url === 'https://api.example.com/api/turbines');
    expect(req.request.params.get('q')).toBe('T1');
    expect(req.request.params.get('limit')).toBe('5');
    expect(req.request.params.get('sort')).toBe('id');
    req.flush({
      items: [{ id: 'TURB001' }],
      nextCursor: null,
      prevCursor: null,
      total: 1,
      totalCapped: false,
    });
    expect(await result).toEqual([{ id: 'TURB001' }]);
  });

  it('loads one turbine by id, encoded', async () => {
    const result = firstValueFrom(api.turbine('TURB 1'));
    http.expectOne('https://api.example.com/api/turbines/TURB%201').flush({ id: 'TURB 1' });
    expect(await result).toEqual({ id: 'TURB 1' });
  });

  it("loads a farm's turbine markers", async () => {
    const result = firstValueFrom(api.turbineMarkers('FARM01'));
    http
      .expectOne('https://api.example.com/api/farms/FARM01/turbine-markers')
      .flush([{ id: 'TURB001' }]);
    expect(await result).toEqual([{ id: 'TURB001' }]);
  });

  it("loads a turbine's telemetry for a time window", async () => {
    const result = firstValueFrom(
      api.telemetry('TURB001', {
        from: '2026-01-02T00:00:00.000Z',
        to: '2026-01-03T00:00:00.001Z',
        limit: 289,
      }),
    );
    http
      .expectOne(
        (req) =>
          req.url === 'https://api.example.com/api/turbines/TURB001/telemetry' &&
          req.params.get('from') === '2026-01-02T00:00:00.000Z' &&
          req.params.get('to') === '2026-01-03T00:00:00.001Z' &&
          req.params.get('limit') === '289',
      )
      .flush([]);
    await result;
  });

  it('omits time bounds that are not given', async () => {
    const result = firstValueFrom(api.telemetry('TURB001', { limit: 5 }));
    const req = http.expectOne((r) => r.url.endsWith('/turbines/TURB001/telemetry'));
    expect(req.request.params.keys()).toEqual(['limit']);
    req.flush([]);
    await result;
  });

  it("loads a turbine's telemetry stats for the same window", async () => {
    const stats = { turbineId: 'TURB001', from: null, to: null, count: 0, metrics: {} };
    const result = firstValueFrom(
      api.telemetryStats('TURB001', {
        from: '2026-01-02T00:00:00.000Z',
        to: '2026-01-03T00:00:00.001Z',
        limit: 289,
      }),
    );
    http
      .expectOne(
        (req) =>
          req.method === 'GET' &&
          req.url === 'https://api.example.com/api/turbines/TURB001/telemetry/stats' &&
          req.params.get('from') === '2026-01-02T00:00:00.000Z' &&
          req.params.get('to') === '2026-01-03T00:00:00.001Z' &&
          req.params.get('limit') === '289',
      )
      .flush(stats);
    expect(await result).toEqual(stats);
  });

  it("changes a turbine's commissioned state with a PATCH and returns the updated turbine", async () => {
    const turbine = {
      id: 'TURB001',
      farmId: 'FARM01',
      latitude: 41.2,
      longitude: -96.5,
      commissioned: true,
    };
    const result = firstValueFrom(api.setCommissioned('TURB001', true));
    const req = http.expectOne({
      method: 'PATCH',
      url: 'https://api.example.com/api/turbines/TURB001',
    });
    expect(req.request.body).toEqual({ commissioned: true });
    req.flush(turbine);
    expect(await result).toEqual(turbine);
  });

  it('exposes the SSE endpoint on the same base URL, without a turbine list when none are given', () => {
    expect(api.eventsUrl()).toBe('https://api.example.com/api/events');
    expect(api.eventsUrl([])).toBe('https://api.example.com/api/events');
  });

  describe('eventsUrl with a session', () => {
    beforeEach(() => {
      TestBed.resetTestingModule();
      localStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({
          accessToken: 'a.b+c',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          signedInAt: new Date().toISOString(),
          user: { email: 'viewer@nextera.local', role: 'viewer' },
        }),
      );
      TestBed.configureTestingModule({
        providers: [
          provideHttpClient(),
          provideHttpClientTesting(),
          { provide: API_BASE_URL, useValue: 'https://api.example.com/api' },
        ],
      });
      api = TestBed.inject(FleetApi);
    });

    afterEach(() => localStorage.removeItem(SESSION_STORAGE_KEY));

    it('passes the access token as access_token (EventSource sends no headers)', () => {
      expect(api.eventsUrl()).toBe('https://api.example.com/api/events?access_token=a.b%2Bc');
    });

    it('adds the watched turbines after the token', () => {
      expect(api.eventsUrl(['TURB001', 'TURB002'])).toBe(
        'https://api.example.com/api/events?access_token=a.b%2Bc&turbines=TURB001,TURB002',
      );
    });

    it('sends each id once and drops ids the API would refuse', () => {
      const url = api.eventsUrl(['TURB001', 'TURB001', 'bad id', 'a,b', '', 'x'.repeat(65)]);
      expect(url).toContain('&turbines=TURB001');
      expect(url.endsWith('turbines=TURB001')).toBe(true);
    });

    it('sends at most 100 ids', () => {
      const ids = Array.from({ length: 150 }, (_, i) => `T${i}`);
      const sent = new URL(api.eventsUrl(ids)).searchParams.get('turbines')!.split(',');
      expect(sent).toHaveLength(100);
      expect(sent[99]).toBe('T99');
    });

    it('sends no turbines parameter when every id is invalid', () => {
      expect(api.eventsUrl(['bad id'])).toBe(
        'https://api.example.com/api/events?access_token=a.b%2Bc',
      );
    });
  });
});
