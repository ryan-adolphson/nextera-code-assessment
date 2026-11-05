import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { API_BASE_URL } from '../core/api-base-url';
import { Telemetry } from '../fleet/fleet.model';

/** One page of GET /api/alerts, newest first. */
export interface AlertsPage {
  readings: Telemetry[];
  /** Pass to the next request for the following (older) page; null on the last page. */
  nextCursor: string | null;
}

/** Readings per request (the API's cap may be lower). */
export const ALERTS_PAGE_SIZE = 500;

/** GET /api/alerts: the readings that triggered alert rules (telemetry_alerts), by time range. */
@Injectable({ providedIn: 'root' })
export class AlertHistoryApi {
  private readonly http = inject(HttpClient);
  private readonly url = `${inject(API_BASE_URL)}/alerts`;

  /**
   * Readings measured in [from, to) (ISO, at most 31 days) with their triggered rules, newest
   * first, one page at a time (`cursor` from the previous page's `nextCursor`).
   */
  list(from: string, to: string, cursor: string | null = null): Observable<AlertsPage> {
    let params = new HttpParams().set('from', from).set('to', to).set('limit', ALERTS_PAGE_SIZE);
    if (cursor) params = params.set('cursor', cursor);
    return this.http
      .get<{ items: Telemetry[]; nextCursor: string | null }>(this.url, { params })
      .pipe(map((body): AlertsPage => ({ readings: body.items, nextCursor: body.nextCursor })));
  }
}
