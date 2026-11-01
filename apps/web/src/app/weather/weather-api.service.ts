import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { API_BASE_URL } from '../core/api-base-url';
import { WeatherInterval, WeatherQuery, WeatherResponse } from './weather.model';

/** Open-Meteo weather stored per farm (viewer role). 404: unknown farm/turbine; 400: bad range/zone. */
@Injectable({ providedIn: 'root' })
export class WeatherApi {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  /** GET /api/farms/:farmId/weather. */
  farm<I extends WeatherInterval>(
    farmId: string,
    query: WeatherQuery<I>,
  ): Observable<WeatherResponse<I>> {
    return this.http.get<WeatherResponse<I>>(
      `${this.baseUrl}/farms/${encodeURIComponent(farmId)}/weather`,
      { params: queryParams(query) },
    );
  }

  /** GET /api/turbines/:id/weather: the turbine's farm's weather (the body adds `turbineId`). */
  turbine<I extends WeatherInterval>(
    turbineId: string,
    query: WeatherQuery<I>,
  ): Observable<WeatherResponse<I>> {
    return this.http.get<WeatherResponse<I>>(
      `${this.baseUrl}/turbines/${encodeURIComponent(turbineId)}/weather`,
      { params: queryParams(query) },
    );
  }
}

function queryParams({ from, to, interval, timeZone }: WeatherQuery): HttpParams {
  const params = new HttpParams().set('from', from).set('to', to).set('interval', interval);
  return timeZone ? params.set('timeZone', timeZone) : params;
}
