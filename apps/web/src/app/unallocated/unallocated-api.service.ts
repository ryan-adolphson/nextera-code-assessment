import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { API_BASE_URL } from '../core/api-base-url';
import {
  AssignRequest,
  HeldReading,
  UnallocatedResolution,
  UnallocatedStatus,
  UnallocatedTurbine,
} from './unallocated.model';

/** /api/unallocated-turbines (owner and up; the API answers viewers 404). */
@Injectable({ providedIn: 'root' })
export class UnallocatedApi {
  private readonly http = inject(HttpClient);
  private readonly url = `${inject(API_BASE_URL)}/unallocated-turbines`;

  /** Pending or blocked entries, most recently seen first. */
  list(status: UnallocatedStatus): Observable<UnallocatedTurbine[]> {
    return this.http.get<UnallocatedTurbine[]>(this.url, { params: { status } });
  }

  /** An entry's newest held readings (by measurement time), at most `limit`. */
  readings(id: string, limit: number): Observable<HeldReading[]> {
    return this.http.get<HeldReading[]>(`${this.entry(id)}/readings`, {
      params: new HttpParams().set('limit', limit),
    });
  }

  /** An unknown turbine: create it on the farm and import its held readings. */
  assign(id: string, body: AssignRequest): Observable<UnallocatedResolution> {
    return this.http.post<UnallocatedResolution>(`${this.entry(id)}/assign`, body);
  }

  /** A mismatch: import the held readings under the turbine's current farm. */
  keep(id: string): Observable<UnallocatedResolution> {
    return this.http.post<UnallocatedResolution>(`${this.entry(id)}/keep`, {});
  }

  /** A mismatch: move the turbine and its history to the reported farm, then import. */
  move(id: string): Observable<UnallocatedResolution> {
    return this.http.post<UnallocatedResolution>(`${this.entry(id)}/move`, {});
  }

  /** Drop the held readings and every later reading of this turbine id from this farm. */
  block(id: string): Observable<UnallocatedTurbine> {
    return this.http.post<UnallocatedTurbine>(`${this.entry(id)}/block`, {});
  }

  /** Forget the entry: the next reading creates a new pending one. */
  unblock(id: string): Observable<void> {
    return this.http.post<void>(`${this.entry(id)}/unblock`, {});
  }

  private entry(id: string): string {
    return `${this.url}/${encodeURIComponent(id)}`;
  }
}
