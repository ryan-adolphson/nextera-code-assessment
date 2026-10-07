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

  it('loads the fleet overview', async () => {
    const result = firstValueFrom(api.farms());
    http.expectOne({ method: 'GET', url: 'https://api.example.com/api/farms' }).flush([]);
    expect(await result).toEqual([]);
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

  it('exposes the SSE endpoint on the same base URL', () => {
    expect(api.eventsUrl).toBe('https://api.example.com/api/events');
  });

  it('passes the access token to the SSE endpoint as access_token (EventSource sends no headers)', () => {
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
    try {
      TestBed.configureTestingModule({
        providers: [
          provideHttpClient(),
          provideHttpClientTesting(),
          { provide: API_BASE_URL, useValue: 'https://api.example.com/api' },
        ],
      });
      expect(TestBed.inject(FleetApi).eventsUrl).toBe(
        'https://api.example.com/api/events?access_token=a.b%2Bc',
      );
    } finally {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  });
});
