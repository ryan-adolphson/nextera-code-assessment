import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { API_BASE_URL } from '../core/api-base-url';
import { AuthStore } from '../core/auth/auth.store';
import {
  FarmSummaryResponse,
  FleetSummaryResponse,
  Telemetry,
  TelemetryStats,
  TurbineItem,
  TurbineMarkerResponse,
  TurbinePageResponse,
  TurbineQuery,
  TurbineResponse,
} from './fleet.model';

/** The API caps the SSE turbine list at 100 ids. */
export const MAX_WATCHED_TURBINES = 100;
const TURBINE_ID = /^[A-Za-z0-9_.-]{1,64}$/;

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
   * the API accepts the query token on this route only) and the turbines whose readings to send
   * as `?turbines=a,b,c` (at most 100; none = only the fleet-wide events). MVP trade-off: query
   * strings appear in request logs.
   */
  eventsUrl(turbineIds: readonly string[] = []): string {
    const token = this.auth.accessToken();
    const query: string[] = [];
    if (token) query.push(`access_token=${encodeURIComponent(token)}`);
    // The API answers 400 to a list that isn't at most 100 unique, well-formed ids.
    const ids = [...new Set(turbineIds)]
      .filter((id) => TURBINE_ID.test(id))
      .slice(0, MAX_WATCHED_TURBINES);
    if (ids.length) query.push(`turbines=${ids.join(',')}`);
    return `${this.baseUrl}/events${query.length ? `?${query.join('&')}` : ''}`;
  }

  /** Fleet totals (rebuilt about once a minute). */
  fleetSummary(): Observable<FleetSummaryResponse> {
    return this.http.get<FleetSummaryResponse>(`${this.baseUrl}/fleet/summary`);
  }

  /** Every farm with its totals (no turbines). Served with an ETag. */
  farmSummaries(): Observable<FarmSummaryResponse[]> {
    return this.http.get<FarmSummaryResponse[]>(`${this.baseUrl}/farm-summaries`);
  }

  /** One page of turbines with their latest reading (keyset paging by `cursor`). */
  turbines(query: TurbineQuery): Observable<TurbinePageResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params = params.set(key, value);
    }
    return this.http.get<TurbinePageResponse>(`${this.baseUrl}/turbines`, { params });
  }

  /** The turbines matching `q` (id, farm id or farm name), by id: the Reporting turbine picker. */
  searchTurbines(q: string, limit = 20): Observable<TurbineItem[]> {
    return this.turbines({ q, limit, sort: 'id', dir: 'asc' }).pipe(map((page) => page.items));
  }

  /** One turbine with its latest reading (404 when unknown). */
  turbine(turbineId: string): Observable<TurbineItem> {
    return this.http.get<TurbineItem>(`${this.baseUrl}/turbines/${encodeURIComponent(turbineId)}`);
  }

  /** A farm's turbines as map markers (id, position, status), at most 2,000. */
  turbineMarkers(farmId: string): Observable<TurbineMarkerResponse[]> {
    return this.http.get<TurbineMarkerResponse[]>(
      `${this.baseUrl}/farms/${encodeURIComponent(farmId)}/turbine-markers`,
    );
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

  /** Marks a turbine commissioned or not (owner and up; the API answers 404 for lower roles). */
  setCommissioned(turbineId: string, commissioned: boolean): Observable<TurbineResponse> {
    return this.http.patch<TurbineResponse>(`${this.baseUrl}/turbines/${turbineId}`, {
      commissioned,
    });
  }
}

function windowParams(window: TelemetryWindow): HttpParams {
  let params = new HttpParams().set('limit', window.limit);
  if (window.from) params = params.set('from', window.from);
  if (window.to) params = params.set('to', window.to);
  return params;
}
