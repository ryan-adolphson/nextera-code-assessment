import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { API_BASE_URL } from '../api-base-url';
import { AuthStore } from './auth.store';

/**
 * Adds `Authorization: Bearer <token>` to requests under API_BASE_URL only (never /config.json or
 * other hosts). A 401 from the API means the token is missing, invalid or expired: sign out and go
 * to /login. The login request's own 401 ("Invalid email or password") is left to the login page.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const base = inject(API_BASE_URL);
  const auth = inject(AuthStore);
  if (!req.url.startsWith(`${base}/`)) return next(req);

  const token = auth.accessToken();
  const isLogin = req.url === `${base}/auth/login`;
  const request =
    token && !isLogin ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;
  return next(request).pipe(
    catchError((error: unknown) => {
      if (!isLogin && error instanceof HttpErrorResponse && error.status === 401) {
        auth.logout();
      }
      return throwError(() => error);
    }),
  );
};
