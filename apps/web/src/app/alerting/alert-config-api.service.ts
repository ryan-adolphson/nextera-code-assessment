import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { API_BASE_URL } from '../core/api-base-url';
import { AlertConfig, AlertConfigInput } from './alert-config.model';

/** /api/alert-configs. Known gap: writes are unauthenticated for now, like the rest of the API. */
@Injectable({ providedIn: 'root' })
export class AlertConfigApi {
  private readonly http = inject(HttpClient);
  private readonly url = `${inject(API_BASE_URL)}/alert-configs`;

  /** Ordered by metric, then level severity, then value (by the API). */
  list(): Observable<AlertConfig[]> {
    return this.http.get<AlertConfig[]>(this.url);
  }

  create(rule: AlertConfigInput): Observable<AlertConfig> {
    return this.http.post<AlertConfig>(this.url, rule);
  }

  update(id: string, changes: Partial<AlertConfigInput>): Observable<AlertConfig> {
    return this.http.patch<AlertConfig>(`${this.url}/${encodeURIComponent(id)}`, changes);
  }

  remove(id: string): Observable<void> {
    return this.http.delete<void>(`${this.url}/${encodeURIComponent(id)}`);
  }
}
