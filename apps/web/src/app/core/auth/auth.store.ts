import { HttpClient } from '@angular/common/http';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { hoursToMilliseconds } from 'date-fns';
import { Observable, map } from 'rxjs';
import { API_BASE_URL } from '../api-base-url';
import { NOW } from '../clock';
import { Role, hasRole, isRole } from './roles';

/** The signed-in user (POST /api/auth/login `user`, GET /api/auth/me). */
export interface AuthUser {
  email: string;
  role: Role;
}

/** POST /api/auth/login response (mirrors the API's LoginResponse). */
export interface LoginResponse {
  accessToken: string;
  /** ISO 8601. */
  expiresAt: string;
  user: AuthUser;
}

/** What is kept in localStorage. */
export interface Session {
  accessToken: string;
  /** ISO 8601: when the token expires (24 h after sign-in). */
  expiresAt: string;
  /** ISO 8601: when the user signed in on this browser. */
  signedInAt: string;
  user: AuthUser;
}

export const SESSION_STORAGE_KEY = 'nextera.session';
/** A session older than this needs a new sign-in, whatever the token says. */
export const SESSION_TTL_MS = hoursToMilliseconds(24);

/**
 * The session: `user`, `role`, `isAuthenticated`, `can(minRole)` and the access token.
 *
 * MVP decision: the session (including the token) is kept in **localStorage** for at most 24 h, so
 * a reload or a new tab stays signed in. localStorage is readable by any script on the page (XSS);
 * accepted for the proof of concept. An expired or older-than-24-h session is dropped on load, and
 * a timer signs the user out at `expiresAt` (→ /login).
 */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);
  private readonly router = inject(Router);
  private readonly clock = inject(NOW);
  private readonly session = signal<Session | null>(null);
  private expiryTimer?: ReturnType<typeof setTimeout>;

  readonly user = computed(() => this.session()?.user ?? null);
  readonly role = computed(() => this.user()?.role ?? null);
  readonly isAuthenticated = computed(() => this.session() !== null);
  /** The Bearer token for API requests (and the SSE `access_token`). */
  readonly accessToken = computed(() => this.session()?.accessToken ?? null);

  constructor() {
    this.restore(readStoredSession());
    inject(DestroyRef).onDestroy(() => clearTimeout(this.expiryTimer));
  }

  /** At least `minRole` (hides controls; the API enforces it). Reactive in templates. */
  can(minRole: Role): boolean {
    const role = this.role();
    return role !== null && hasRole(role, minRole);
  }

  /** POST /api/auth/login; on success the session is stored. Errors are the HttpErrorResponse. */
  login(email: string, password: string): Observable<AuthUser> {
    return this.http.post<LoginResponse>(`${this.baseUrl}/auth/login`, { email, password }).pipe(
      map((res) => {
        const session: Session = {
          accessToken: res.accessToken,
          expiresAt: res.expiresAt,
          signedInAt: new Date(this.clock()).toISOString(),
          user: res.user,
        };
        if (!this.restore(session)) throw new Error('The session expired immediately.');
        writeStoredSession(session);
        return res.user;
      }),
    );
  }

  /** Forgets the session (and the stored copy) and goes to /login. */
  logout(): void {
    this.clear();
    void this.router.navigateByUrl('/login');
  }

  /** Forgets the session without navigating (e.g. on the login page). */
  clear(): void {
    clearTimeout(this.expiryTimer);
    this.session.set(null);
    removeStoredSession();
  }

  /** Accepts a session that is still valid and schedules its sign-out; false (and cleared) otherwise. */
  private restore(session: Session | null): boolean {
    const endsAt = session ? sessionEnd(session) : NaN;
    const remaining = endsAt - this.clock();
    if (!session || !(remaining > 0)) {
      if (session) removeStoredSession();
      this.session.set(null);
      return false;
    }
    this.session.set(session);
    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => this.logout(), remaining);
    return true;
  }
}

/** The earlier of the token's expiry and 24 h after sign-in. */
function sessionEnd(session: Session): number {
  return Math.min(Date.parse(session.expiresAt), Date.parse(session.signedInAt) + SESSION_TTL_MS);
}

function isSession(value: unknown): value is Session {
  const s = value as Partial<Session> | null;
  return (
    typeof s === 'object' &&
    s !== null &&
    typeof s.accessToken === 'string' &&
    typeof s.expiresAt === 'string' &&
    typeof s.signedInAt === 'string' &&
    typeof s.user?.email === 'string' &&
    isRole(s.user?.role)
  );
}

// localStorage can be unavailable (privacy modes) or full: then the session lives in memory only.
function readStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    const value: unknown = raw ? JSON.parse(raw) : null;
    return isSession(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStoredSession(session: Session): void {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // memory only
  }
}

function removeStoredSession(): void {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // nothing stored
  }
}
