import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { API_BASE_URL } from '../core/api-base-url';
import { Telemetry } from '../fleet/fleet.model';

/** What a report is about (mirrors ReportScope in apps/api/src/reports). */
export interface ReportScope {
  kind: 'farm' | 'turbine';
  /** The farm id ("FARM01") or the turbine id ("TURB001"). */
  id: string;
  /** The farm's name; for a turbine, its farm's name. */
  name: string;
  farmId: string;
}

/** GET /api/reports/telemetry. */
export interface TelemetryReport {
  scope: ReportScope;
  from: string;
  to: string;
  /** Every reading in [from, to), with its triggered rules; by turbine, then oldest first. */
  readings: Telemetry[];
}

/** The report request: one farm or one turbine, over [from, to) (ISO; at most 31 days). */
export interface ReportRequest {
  kind: 'farm' | 'turbine';
  id: string;
  from: string;
  to: string;
}

/** GET /api/reports/telemetry: all telemetry of a farm or a turbine over a range. */
@Injectable({ providedIn: 'root' })
export class ReportApi {
  private readonly http = inject(HttpClient);
  private readonly url = `${inject(API_BASE_URL)}/reports/telemetry`;

  telemetry({ kind, id, from, to }: ReportRequest): Observable<TelemetryReport> {
    return this.http.get<TelemetryReport>(this.url, {
      params: new HttpParams()
        .set(kind === 'farm' ? 'farmId' : 'turbineId', id)
        .set('from', from)
        .set('to', to),
    });
  }
}
