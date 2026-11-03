import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { API_BASE_URL } from '../core/api-base-url';
import { AnomalyReport } from './anomaly.model';

/** GET /api/anomalies: detected episodes (low power in strong wind, stuck sensors) in [from, to). */
@Injectable({ providedIn: 'root' })
export class AnomaliesApi {
  private readonly http = inject(HttpClient);
  private readonly url = `${inject(API_BASE_URL)}/anomalies`;

  /** `from`/`to` are ISO instants, at most 31 days apart. */
  list(from: string, to: string): Observable<AnomalyReport> {
    return this.http.get<AnomalyReport>(this.url, {
      params: new HttpParams().set('from', from).set('to', to),
    });
  }
}
