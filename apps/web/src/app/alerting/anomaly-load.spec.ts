import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { API_BASE_URL } from '../core/api-base-url';
import { NOW } from '../core/clock';
import { anomalyLoad } from './anomaly-load';

/**
 * The state the fleet tile reads (`value` null and not failed = spinner; a dash only after a
 * failure), with the real HttpClient instead of a mocked api.
 */
describe('anomalyLoad over HTTP', () => {
  const setup = () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: NOW, useValue: () => Date.parse('2026-01-03T00:00:00Z') },
      ],
    });
    const load = TestBed.runInInjectionContext(() => anomalyLoad());
    const http = TestBed.inject(HttpTestingController);
    const state = () => [load.value(), load.loading(), load.failed()];
    return { load, http, state };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve));

  it('is pending (no value, not failed) from creation until the answer', async () => {
    const { http, state } = setup();
    expect(state()).toEqual([null, true, false]); // before the first change detection
    TestBed.tick();
    const request = http.expectOne((r) => r.url === '/api/anomalies');
    expect(request.request.params.get('from')).toBe('2025-12-27T00:00:00.000Z');
    expect(state()).toEqual([null, true, false]); // request out, no answer yet

    const report = { from: '', to: '', estimatedLostKwh: 5, anomalies: [] };
    request.flush(report);
    await settle();
    expect(state()).toEqual([report, false, false]);
  });

  it('fails only when the request fails, and retries back to pending', async () => {
    const { load, http, state } = setup();
    TestBed.tick();
    http
      .expectOne((r) => r.url === '/api/anomalies')
      .flush('boom', { status: 500, statusText: 'Server Error' });
    await settle();
    expect(state()).toEqual([null, false, true]);

    load.retry();
    TestBed.tick();
    expect(load.failed()).toBe(false);
    expect(load.value()).toBeNull(); // pending again: the tile shows its spinner, not a dash
    http.expectOne((r) => r.url === '/api/anomalies').flush({ estimatedLostKwh: 0, anomalies: [] });
    await settle();
    expect(load.value()).not.toBeNull();
  });
});
