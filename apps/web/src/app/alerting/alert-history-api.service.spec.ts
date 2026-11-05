import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../core/api-base-url';
import { reading } from '../fleet/testing';
import { ALERTS_PAGE_SIZE, AlertHistoryApi } from './alert-history-api.service';

describe('AlertHistoryApi', () => {
  const URL = 'https://api.example.com/api/alerts';
  let api: AlertHistoryApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: 'https://api.example.com/api' },
      ],
    });
    api = TestBed.inject(AlertHistoryApi);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('asks for the first page of the range: a limit and no cursor', async () => {
    const result = firstValueFrom(api.list('2026-01-02T00:00:00.000Z', '2026-01-04T00:00:00.000Z'));
    const req = http.expectOne((r) => r.url === URL);

    expect(req.request.method).toBe('GET');
    expect(req.request.params.get('from')).toBe('2026-01-02T00:00:00.000Z');
    expect(req.request.params.get('to')).toBe('2026-01-04T00:00:00.000Z');
    expect(req.request.params.get('limit')).toBe(String(ALERTS_PAGE_SIZE));
    expect(req.request.params.has('cursor')).toBe(false);
    req.flush({ items: [], nextCursor: null });
    expect(await result).toEqual({ readings: [], nextCursor: null });
  });

  it('passes the cursor of the page before, and returns the next one', async () => {
    const flagged = reading({ id: 'r1' });
    const result = firstValueFrom(api.list('a', 'b', 'cursor-1'));
    const req = http.expectOne((r) => r.url === URL);

    expect(req.request.params.get('cursor')).toBe('cursor-1');
    req.flush({ items: [flagged], nextCursor: 'cursor-2' });
    expect(await result).toEqual({ readings: [flagged], nextCursor: 'cursor-2' });
  });
});
