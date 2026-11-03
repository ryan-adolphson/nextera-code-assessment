import { inject } from '@angular/core';
import { NOW } from '../core/clock';
import { latestLoad } from '../ui/latest-load';
import { AnomaliesApi } from './anomalies-api.service';
import { anomalyWindow } from './anomaly.model';

/**
 * The last 7 days' anomalies, loaded once when created (the client clock fixes the window), for
 * the Anomalies tab and the fleet tile. Not reloaded on SSE; `retry()` loads again.
 * Call it in an injection context (a field initializer).
 */
export function anomalyLoad() {
  const api = inject(AnomaliesApi);
  const now = inject(NOW);
  const load = latestLoad(({ from, to }: { from: string; to: string }) => api.list(from, to));
  load.run(anomalyWindow(now()));
  return load;
}
