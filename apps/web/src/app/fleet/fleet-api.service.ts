import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { API_BASE_URL } from '../core/api-base-url';
import { AuthStore } from '../core/auth/auth.store';
import { FarmOverview, Telemetry, TelemetryStats } from './fleet.model';

/** A telemetry query: [from, to) on measurement time, the newest `limit` readings. */
export interface TelemetryWindow {
  from?: string;
  to?: string;
  limit: number;
}

@Injectable({ providedIn: 'root' })
export class FleetApi {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  private readonly auth = inject(AuthStore);

  /**
   * The SSE endpoint with the access token as `?access_token=` (EventSource can't send headers;
   * the API accepts the query token on this route only). MVP trade-off: query strings appear in
   * request logs.
   */
  get eventsUrl(): string {
    const token = this.auth.accessToken();
    const url = `${this.baseUrl}/events`;
    return token ? `${url}?access_token=${encodeURIComponent(token)}` : url;
  }

  /** Farms, their turbines and each turbine's latest reading. */
  farms(): Observable<FarmOverview[]> {
    return this.http.get<FarmOverview[]>(`${this.baseUrl}/farms`);
  }

  /** A turbine's readings in [from, to), newest first, at most `limit`. */
  telemetry(turbineId: string, window: TelemetryWindow): Observable<Telemetry[]> {
    return this.http.get<Telemetry[]>(`${this.baseUrl}/turbines/${turbineId}/telemetry`, {
      params: windowParams(window),
    });
  }

  /** Median, high and low of every metric over the same readings `telemetry()` returns. */
  telemetryStats(turbineId: string, window: TelemetryWindow): Observable<TelemetryStats> {
    return this.http.get<TelemetryStats>(`${this.baseUrl}/turbines/${turbineId}/telemetry/stats`, {
      params: windowParams(window),
    });
  }
}

function windowParams(window: TelemetryWindow): HttpParams {
  let params = new HttpParams().set('limit', window.limit);
  if (window.from) params = params.set('from', window.from);
  if (window.to) params = params.set('to', window.to);
  return params;
}
