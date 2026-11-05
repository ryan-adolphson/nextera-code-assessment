import { Prisma } from '../generated/prisma/client.js';
import {
  ANOMALY_MIN_READINGS,
  ANOMALY_STEP_MINUTES,
  LOW_POWER_FALLBACK_KW,
  LOW_POWER_MAX_RATIO,
  LOW_POWER_MIN_WIND_MS,
  STUCK_SENSOR_MIN_POWER_RANGE_KW,
  STUCK_SENSOR_MIN_READINGS,
} from './anomalies.js';

/** The columns the episode SQL can find a stuck sensor on: label, value column, run-id column. */
const STUCK_METRICS = [
  { metric: 'gearboxTempC', value: 'g', run: 'g_run' },
  { metric: 'windSpeedMs', value: 'w', run: 'w_run' },
  { metric: 'rotorRpm', value: 'rpm', run: 'rpm_run' },
] as const;

/**
 * The stuck-sensor episodes of one metric, from the `marked` CTE: the readings of its long runs
 * (`long_runs`), grouped, whose power range shows the turbine kept moving. Identifiers come from
 * the constant above, never from input.
 */
const stuckEpisodes = (
  metric: string,
  value: string,
  run: string,
) => Prisma.sql`
      SELECT 'stuck_sensor'::text AS kind, ${metric}::text AS metric,
             m.turbine_id, max(m.farm_id) AS farm_id,
             min(m.timestamp) AS episode_start, max(m.timestamp) AS episode_end,
             count(*)::int AS readings,
             min(m.${Prisma.raw(value)})::float8 AS value,
             NULL::float8 AS wind_speed_ms,
             NULL::float8 AS lost_kwh
      FROM marked m
      JOIN long_runs lr
        ON lr.metric = ${metric} AND lr.turbine_id = m.turbine_id AND lr.run = m.${Prisma.raw(run)}
      GROUP BY m.turbine_id, m.${Prisma.raw(run)}
      HAVING count(*) >= ${STUCK_SENSOR_MIN_READINGS}::int
         AND max(m.p) - min(m.p) >= ${STUCK_SENSOR_MIN_POWER_RANGE_KW}::float8`;

/**
 * The anomaly rules as one SQL statement (see `listAnomalies` in queries.ts for what they are and
 * why): `listAnomalies` runs it over the readings of a queried range, and the anomaly rollup over
 * a window of the stored readings, so both apply the same thresholds and the same
 * gaps-and-islands logic. The caller supplies:
 *
 * - `readings`: the body of CTE `r`: `SELECT turbine_id, farm_id, timestamp, power_output_kw AS p,
 *   wind_speed_ms AS w, rotor_rpm AS rpm, gearbox_temp_c AS g, floor(wind_speed_ms)::int AS bin`;
 * - `bins`: the body of CTE `bins` (may select FROM `r`): rows `(bin int, expected float8)`, the
 *   expected power per 1 m/s wind bin. The query takes the nearest bin at or below a reading's.
 *
 * Returns rows of `AnomalyRow` (kind, metric, turbine_id, farm_id, episode_start, episode_end,
 * readings, value, wind_speed_ms, lost_kwh), newest episode end first. The `bins` CTE must stay
 * `MATERIALIZED` and the readings CTE `NOT MATERIALIZED` (see the SQL comments).
 */
export function anomalyEpisodesSql({
  readings,
  bins,
}: {
  readings: Prisma.Sql;
  bins: Prisma.Sql;
}): Prisma.Sql {
  const step = ANOMALY_STEP_MINUTES;
  return Prisma.sql`
    WITH r AS NOT MATERIALIZED (
      ${readings}
    ),
    -- MATERIALIZED: else the planner inlines it and re-aggregates the table for every reading.
    bins AS MATERIALIZED (
      ${bins}
    ),
    judged AS (
      SELECT r.*, e.expected,
             (r.w >= ${LOW_POWER_MIN_WIND_MS}::float8
              AND r.p < CASE WHEN e.expected IS NULL THEN ${LOW_POWER_FALLBACK_KW}::float8
                             ELSE ${LOW_POWER_MAX_RATIO}::float8 * e.expected END) AS low
      FROM r
      LEFT JOIN LATERAL (
        SELECT bins.expected FROM bins
        WHERE r.w >= ${LOW_POWER_MIN_WIND_MS}::float8 AND bins.bin <= r.bin
        ORDER BY bins.bin DESC LIMIT 1
      ) e ON true
    ),
    -- One pass per turbine (a single sort): the previous reading's values, then a run id per
    -- rule that increments whenever the run breaks (gap, or the condition doesn't hold again).
    prev AS (
      SELECT *,
             timestamp - lag(timestamp) OVER t <= make_interval(mins => ${step}::int) AS contiguous,
             lag(low) OVER t AS prev_low,
             lag(g) OVER t AS prev_g,
             lag(w) OVER t AS prev_w,
             lag(rpm) OVER t AS prev_rpm
      FROM judged
      WINDOW t AS (PARTITION BY turbine_id ORDER BY timestamp)
    ),
    marked AS MATERIALIZED (
      SELECT *,
             sum(CASE WHEN low AND prev_low AND contiguous THEN 0 ELSE 1 END) OVER t AS low_run,
             sum(CASE WHEN g = prev_g AND contiguous THEN 0 ELSE 1 END) OVER t AS g_run,
             sum(CASE WHEN w = prev_w AND contiguous THEN 0 ELSE 1 END) OVER t AS w_run,
             sum(CASE WHEN rpm = prev_rpm AND contiguous THEN 0 ELSE 1 END) OVER t AS rpm_run
      FROM prev
      WINDOW t AS (PARTITION BY turbine_id ORDER BY timestamp)
    ),
    low_episodes AS (
      SELECT 'low_power_in_wind'::text AS kind, NULL::text AS metric,
             turbine_id, max(farm_id) AS farm_id,
             min(timestamp) AS episode_start, max(timestamp) AS episode_end,
             count(*)::int AS readings,
             NULL::float8 AS value,
             round(avg(w)::numeric, 2)::float8 AS wind_speed_ms,
             round((sum(CASE WHEN expected IS NOT NULL THEN greatest(0, expected - p) END)
                    * ${step}::float8 / 60)::numeric, 1)::float8 AS lost_kwh
      FROM marked
      WHERE low
      GROUP BY turbine_id, low_run
      HAVING count(*) >= ${ANOMALY_MIN_READINGS}::int
    ),
    -- A run of >= N equal values: its run id equals the id N-1 readings earlier. Finding those
    -- (turbine, metric, run) keys first means only their readings are grouped below, instead of
    -- a group per reading (~1M hash groups spilling to disk on a week of a 200-turbine fleet).
    long_runs AS (
      SELECT DISTINCT x.turbine_id, m.metric, m.run
      FROM (
        SELECT turbine_id,
               g_run, lag(g_run, ${STUCK_SENSOR_MIN_READINGS - 1}::int) OVER t AS g_back,
               w_run, lag(w_run, ${STUCK_SENSOR_MIN_READINGS - 1}::int) OVER t AS w_back,
               rpm_run, lag(rpm_run, ${STUCK_SENSOR_MIN_READINGS - 1}::int) OVER t AS rpm_back
        FROM marked
        WINDOW t AS (PARTITION BY turbine_id ORDER BY timestamp)
      ) x
      CROSS JOIN LATERAL (VALUES
        ('gearboxTempC', x.g_run, x.g_back),
        ('windSpeedMs', x.w_run, x.w_back),
        ('rotorRpm', x.rpm_run, x.rpm_back)
      ) AS m(metric, run, back)
      WHERE m.run = m.back
    ),
    stuck_episodes AS (
      ${Prisma.join(
        STUCK_METRICS.map(({ metric, value, run }) =>
          stuckEpisodes(metric, value, run),
        ),
        ' UNION ALL ',
      )}
    )
    SELECT * FROM low_episodes
    UNION ALL
    SELECT * FROM stuck_episodes
    ORDER BY episode_end DESC, turbine_id, kind, metric`;
}
