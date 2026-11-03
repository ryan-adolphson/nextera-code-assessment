import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { API_BASE_URL } from '../core/api-base-url';
import { FarmDailyHistory, FarmDailyQuery } from './farm-history.model';

/**
 * A farm's daily figures (viewer role). 404: unknown farm; 400: a bad range or zone. The API sends
 * an ETag with `Cache-Control: private, max-age=60`; the browser's HTTP cache handles both.
 */
@Injectable({ providedIn: 'root' })
export class FarmHistoryApi {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  /** GET /api/farms/:farmId/telemetry/daily?from&to&timeZone. */
  daily(farmId: string, { from, to, timeZone }: FarmDailyQuery): Observable<FarmDailyHistory> {
    return this.http.get<FarmDailyHistory>(
      `${this.baseUrl}/farms/${encodeURIComponent(farmId)}/telemetry/daily`,
      { params: new HttpParams().set('from', from).set('to', to).set('timeZone', timeZone) },
    );
  }
}
