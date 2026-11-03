import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Observable } from 'rxjs';
import { API_BASE_URL } from '../core/api-base-url';
import { UnallocatedApi } from './unallocated-api.service';

const URL = 'http://api.test/api/unallocated-turbines';

describe('UnallocatedApi', () => {
  let api: UnallocatedApi;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: 'http://api.test/api' },
      ],
    });
    api = TestBed.inject(UnallocatedApi);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('lists by status and reads held readings with a limit', () => {
    api.list('blocked').subscribe();
    http.expectOne({ method: 'GET', url: `${URL}?status=blocked` }).flush([]);
    api.readings('a/b', 24).subscribe();
    http.expectOne({ method: 'GET', url: `${URL}/a%2Fb/readings?limit=24` }).flush([]);
  });

  it.each([
    ['assign', (a: UnallocatedApi) => a.assign('e1', { farmId: 'FARM01' }), { farmId: 'FARM01' }],
    ['keep', (a: UnallocatedApi) => a.keep('e1'), {}],
    ['move', (a: UnallocatedApi) => a.move('e1'), {}],
    ['block', (a: UnallocatedApi) => a.block('e1'), {}],
    ['unblock', (a: UnallocatedApi) => a.unblock('e1'), {}],
  ] as const)('POSTs %s', (action, call, body) => {
    (call(api) as Observable<unknown>).subscribe();
    const req = http.expectOne({ method: 'POST', url: `${URL}/e1/${action}` });
    expect(req.request.body).toEqual(body);
    req.flush(null);
  });
});
