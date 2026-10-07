import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../api-base-url';
import { NOW } from '../clock';
import { authInterceptor } from './auth.interceptor';
import { AuthStore, SESSION_STORAGE_KEY } from './auth.store';

const BASE = 'https://api.test/api';
const T0 = Date.parse('2026-10-07T12:00:00.000Z');

describe('authInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let store: AuthStore;
  let navigate: ReturnType<typeof vi.spyOn>;

  function setup(signedIn: boolean) {
    localStorage.clear();
    if (signedIn) {
      localStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({
          accessToken: 'the-token',
          expiresAt: new Date(T0 + 3_600_000).toISOString(),
          signedInAt: new Date(T0).toISOString(),
          user: { email: 'viewer@nextera.local', role: 'viewer' },
        }),
      );
    }
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
        { provide: NOW, useValue: () => T0 },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
    store = TestBed.inject(AuthStore);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
  }

  afterEach(() => {
    backend.verify();
    localStorage.clear();
  });

  it('adds the Bearer token to API requests', () => {
    setup(true);
    http.get(`${BASE}/farms`).subscribe();
    expect(backend.expectOne(`${BASE}/farms`).request.headers.get('Authorization')).toBe(
      'Bearer the-token',
    );
  });

  it.each(['/config.json', 'https://other.example.com/api/farms', 'https://api.test/apiary'])(
    'never sends the token outside API_BASE_URL (%s)',
    (url) => {
      setup(true);
      http.get(url).subscribe();
      expect(backend.expectOne(url).request.headers.has('Authorization')).toBe(false);
    },
  );

  it('sends no header while signed out', () => {
    setup(false);
    http.get(`${BASE}/farms`).subscribe({ error: () => undefined });
    expect(backend.expectOne(`${BASE}/farms`).request.headers.has('Authorization')).toBe(false);
  });

  it('signs out and goes to /login on a 401 from the API', async () => {
    setup(true);
    const result = firstValueFrom(http.get(`${BASE}/farms`)).catch((e: unknown) => e);
    backend.expectOne(`${BASE}/farms`).flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(((await result) as { status: number }).status).toBe(401);
    expect(store.isAuthenticated()).toBe(false);
    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it('leaves a 404 (role too low) and other errors to the caller', async () => {
    setup(true);
    const result = firstValueFrom(http.get(`${BASE}/reports/telemetry`)).catch((e: unknown) => e);
    backend
      .expectOne(`${BASE}/reports/telemetry`)
      .flush({}, { status: 404, statusText: 'Not Found' });
    await result;
    expect(store.isAuthenticated()).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("doesn't sign out on the login request's own 401 (wrong password)", async () => {
    setup(false);
    const result = firstValueFrom(store.login('x@nextera.local', 'nope')).catch((e: unknown) => e);
    const req = backend.expectOne(`${BASE}/auth/login`);
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({}, { status: 401, statusText: 'Unauthorized' });
    await result;
    expect(navigate).not.toHaveBeenCalled();
  });
});
