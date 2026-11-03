import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { API_BASE_URL } from '../core/api-base-url';
import { AnomaliesApi } from './anomalies-api.service';

describe('AnomaliesApi', () => {
  it('sends GET /anomalies with the range', () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: 'https://api.example.com/api' },
      ],
    });
    const report = { from: 'a', to: 'b', estimatedLostKwh: 0, anomalies: [] };
    let got: unknown;
    TestBed.inject(AnomaliesApi)
      .list('2026-01-01T00:00:00.000Z', '2026-01-08T00:00:00.000Z')
      .subscribe((r) => (got = r));
    const req = TestBed.inject(HttpTestingController).expectOne(
      (r) => r.url === 'https://api.example.com/api/anomalies',
    );
    expect(req.request.params.get('from')).toBe('2026-01-01T00:00:00.000Z');
    expect(req.request.params.get('to')).toBe('2026-01-08T00:00:00.000Z');
    req.flush(report);
    expect(got).toEqual(report);
  });
});
