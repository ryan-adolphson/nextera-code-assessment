import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../api-base-url';
import { NOW } from '../clock';
import { AuthStore, SESSION_STORAGE_KEY, Session } from './auth.store';

const BASE = 'https://api.test/api';
const T0 = Date.parse('2026-10-07T12:00:00.000Z');
const HOUR = 3_600_000;

const session = (overrides: Partial<Session> = {}): Session => ({
  accessToken: 'stored-token',
  expiresAt: new Date(T0 + 24 * HOUR).toISOString(),
  signedInAt: new Date(T0).toISOString(),
  user: { email: 'owner@nextera.local', role: 'owner' },
  ...overrides,
});

describe('AuthStore', () => {
  let now: number;
  let navigate: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    now = T0;
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  /** A fresh app (a page load): the store restores what localStorage holds. */
  function load() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
        { provide: NOW, useValue: () => now },
      ],
    });
    navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    return { store: TestBed.inject(AuthStore), http: TestBed.inject(HttpTestingController) };
  }
  const stored = () => JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? 'null');

  it('starts signed out', () => {
    const { store } = load();
    expect(store.isAuthenticated()).toBe(false);
    expect(store.user()).toBeNull();
    expect(store.role()).toBeNull();
    expect(store.accessToken()).toBeNull();
    expect(store.can('viewer')).toBe(false);
  });

  it('signs in with POST /api/auth/login and keeps the session in localStorage', async () => {
    const { store, http } = load();
    const user = firstValueFrom(store.login('owner@nextera.local', 'pw'));
    const req = http.expectOne({ method: 'POST', url: `${BASE}/auth/login` });
    expect(req.request.body).toEqual({ email: 'owner@nextera.local', password: 'pw' });
    req.flush({
      accessToken: 'new-token',
      expiresAt: new Date(T0 + 24 * HOUR).toISOString(),
      user: { email: 'owner@nextera.local', role: 'owner' },
    });

    expect(await user).toEqual({ email: 'owner@nextera.local', role: 'owner' });
    expect(store.isAuthenticated()).toBe(true);
    expect(store.accessToken()).toBe('new-token');
    expect(stored()).toEqual(session({ accessToken: 'new-token' }));
  });

  it('is hierarchical in can()', () => {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session()));
    const { store } = load();
    expect([store.can('viewer'), store.can('owner'), store.can('admin')]).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('stays signed in across a reload', () => {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session()));
    now = T0 + 23 * HOUR;
    const { store } = load();
    expect(store.user()).toEqual({ email: 'owner@nextera.local', role: 'owner' });
    expect(store.accessToken()).toBe('stored-token');
  });

  it.each([
    ['the token expired', session({ expiresAt: new Date(T0 + HOUR).toISOString() }), T0 + HOUR],
    [
      'it is 24 h old',
      session({ expiresAt: new Date(T0 + 48 * HOUR).toISOString() }),
      T0 + 24 * HOUR,
    ],
  ])('drops a stored session when %s', (_case, value, at) => {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(value));
    now = at;
    const { store } = load();
    expect(store.isAuthenticated()).toBe(false);
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it.each([
    ['not JSON', '{nope'],
    [
      'an unknown role',
      JSON.stringify(session({ user: { email: 'x', role: 'operator' as never } })),
    ],
    ['missing the token', JSON.stringify({ ...session(), accessToken: undefined })],
  ])('ignores a stored value that is %s', (_case, raw) => {
    localStorage.setItem(SESSION_STORAGE_KEY, raw);
    expect(load().store.isAuthenticated()).toBe(false);
  });

  it('signs out at expiresAt and goes to /login', () => {
    vi.useFakeTimers({ now: T0 + 23 * HOUR });
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session()));
    now = T0 + 23 * HOUR;
    const { store } = load();

    vi.advanceTimersByTime(HOUR - 1);
    expect(store.isAuthenticated()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(store.isAuthenticated()).toBe(false);
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it('logout() forgets the session and goes to /login', () => {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session()));
    const { store } = load();
    store.logout();
    expect(store.isAuthenticated()).toBe(false);
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it('works in memory when localStorage is unavailable', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    try {
      const { store, http } = load();
      const done = firstValueFrom(store.login('owner@nextera.local', 'pw'));
      http.expectOne(`${BASE}/auth/login`).flush({
        accessToken: 't',
        expiresAt: new Date(T0 + HOUR).toISOString(),
        user: { email: 'owner@nextera.local', role: 'owner' },
      });
      await done;
      expect(store.isAuthenticated()).toBe(true);
    } finally {
      setItem.mockRestore();
    }
  });
});
