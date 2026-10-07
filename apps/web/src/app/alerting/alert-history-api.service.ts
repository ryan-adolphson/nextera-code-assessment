import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { API_BASE_URL } from '../core/api-base-url';
import { Telemetry } from '../fleet/fleet.model';

/** GET /api/alerts: the readings that triggered alert rules (telemetry_alerts), by time range. */
@Injectable({ providedIn: 'root' })
export class AlertHistoryApi {
  private readonly http = inject(HttpClient);
  private readonly url = `${inject(API_BASE_URL)}/alerts`;

  /**
   * Readings measured in [from, to) (ISO, at most 31 days) with their triggered rules, grouped by
   * turbine (id ascending) and newest first within a turbine.
   */
  list(from: string, to: string): Observable<Telemetry[]> {
    return this.http.get<Telemetry[]>(this.url, {
      params: new HttpParams().set('from', from).set('to', to),
    });
  }
}
