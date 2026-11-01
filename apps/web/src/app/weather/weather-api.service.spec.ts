import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { API_BASE_URL } from '../core/api-base-url';
import { weatherResponse } from '../fleet/testing';
import { WeatherApi } from './weather-api.service';

describe('WeatherApi', () => {
  let api: WeatherApi;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: 'http://api.test/api' },
      ],
    });
    api = TestBed.inject(WeatherApi);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  const range = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-08T00:00:00.000Z' };

  it('GET /farms/:farmId/weather with the range, interval and time zone', () => {
    const query = { ...range, interval: 'daily' as const, timeZone: 'America/Chicago' };
    let body: unknown;
    api.farm('FARM 01', query).subscribe((res) => (body = res));
    const req = http.expectOne((r) => r.url === 'http://api.test/api/farms/FARM%2001/weather');
    expect(req.request.params.toString()).toBe(
      'from=2026-01-01T00:00:00.000Z&to=2026-01-08T00:00:00.000Z&interval=daily&timeZone=America/Chicago',
    );
    req.flush(weatherResponse('FARM 01', query));
    expect(body).toMatchObject({ farmId: 'FARM 01', interval: 'daily', points: [] });
  });

  it('GET /turbines/:id/weather without a time zone when none is given', () => {
    api.turbine('TURB001', { ...range, interval: '30min' }).subscribe();
    const req = http.expectOne((r) => r.url === 'http://api.test/api/turbines/TURB001/weather');
    expect(req.request.params.keys()).toEqual(['from', 'to', 'interval']);
    expect(req.request.params.get('interval')).toBe('30min');
    req.flush(weatherResponse('FARM01', { ...range, interval: '30min' }, [], 'TURB001'));
  });
});
