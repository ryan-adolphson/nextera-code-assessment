import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../core/api-base-url';
import { AlertConfigApi } from './alert-config-api.service';
import { AlertConfig } from './alert-config.model';

const URL = 'https://api.example.com/api/alert-configs';
const RULE: AlertConfig = {
  id: '0b3c7a1e-8f7d-4a4e-9c11-2f1d6c3b9a10',
  measurementMetric: 'gearboxTempC',
  comparison: 'above',
  valueMetric: 120,
  alertLevel: 'error',
  enabled: true,
};
// The editor's fields: neither the id nor `enabled` (the API default / left unchanged).
const { id: _id, enabled: _enabled, ...INPUT } = RULE;

describe('AlertConfigApi', () => {
  let api: AlertConfigApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: 'https://api.example.com/api' },
      ],
    });
    api = TestBed.inject(AlertConfigApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('lists rules', async () => {
    const result = firstValueFrom(api.list());
    http.expectOne({ method: 'GET', url: URL }).flush([RULE]);
    expect(await result).toEqual([RULE]);
  });

  it('creates a rule', async () => {
    const result = firstValueFrom(api.create(INPUT));
    const req = http.expectOne({ method: 'POST', url: URL });
    expect(req.request.body).toEqual(INPUT);
    req.flush(RULE, { status: 201, statusText: 'Created' });
    expect(await result).toEqual(RULE);
  });

  it('updates and deletes by id', async () => {
    const updated = firstValueFrom(api.update(RULE.id, { valueMetric: 110 }));
    const patch = http.expectOne({ method: 'PATCH', url: `${URL}/${RULE.id}` });
    expect(patch.request.body).toEqual({ valueMetric: 110 });
    patch.flush({ ...RULE, valueMetric: 110 });
    expect((await updated).valueMetric).toBe(110);

    const removed = firstValueFrom(api.remove(RULE.id), { defaultValue: undefined });
    const del = http.expectOne({ method: 'DELETE', url: `${URL}/${RULE.id}` });
    del.flush(null, { status: 204, statusText: 'No Content' });
    await removed;
  });
});
