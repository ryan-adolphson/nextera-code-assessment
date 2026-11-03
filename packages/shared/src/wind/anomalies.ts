/**
 * Anomaly detection rules (computed on read in Postgres by `listAnomalies`, queries.ts). Beyond the
 * static alert thresholds: a pattern over consecutive readings of one turbine.
 */

/** The reporting interval. Two readings of a turbine more than this apart are a gap. */
export const ANOMALY_STEP_MINUTES = 5;
/** A low-power episode is at least this many consecutive readings of one turbine (15 min). */
export const ANOMALY_MIN_READINGS = 3;
/**
 * A stuck-sensor episode is at least this many consecutive readings (1 hour) with the same value.
 * Shorter repeats are common by chance at 1-decimal precision (14.9k on 7 days of demo data at 3).
 */
export const STUCK_SENSOR_MIN_READINGS = 12;
/**
 * ... while the turbine's power keeps changing: max - min of `power_output_kw` over the episode
 * must be at least this (kW). A sensor is stuck while the turbine moves; if power is flat too, the
 * turbine is in a plateau (calm wind at the cut-in clamp, rated output) or off, not a faulty
 * sensor. Chosen from the data (168 h of demo telemetry, 200 turbines): the 12+ reading runs that
 * are plateaus all have a power range of at most 12.7 kW (a few kW of jitter around ~250 kW),
 * while a gearbox stuck on a running turbine has hundreds (467 kW over 90 min). 50 kW (about
 * 1.4 % of rated 3,500 kW) sits ~4x above the plateau noise and ~9x below the fault.
 */
export const STUCK_SENSOR_MIN_POWER_RANGE_KW = 50;
/** `low_power_in_wind` only judges readings at or above this wind speed (m/s). */
export const LOW_POWER_MIN_WIND_MS = 10;
/** ... whose power is below this fraction of the expected power. */
export const LOW_POWER_MAX_RATIO = 0.1;
/** A 1 m/s wind bin needs at least this many fleet readings to give an expected power. */
export const EXPECTED_POWER_MIN_BIN_READINGS = 20;
/** Without any usable bin at or below the wind speed, power under this (kW) counts as low. */
export const LOW_POWER_FALLBACK_KW = 100;

export type AnomalyKind = 'low_power_in_wind' | 'stuck_sensor';
/** The metrics a sensor can be stuck on (not power: it legitimately sits at 0 or at rated). */
export type AnomalyMetric = 'gearboxTempC' | 'windSpeedMs' | 'rotorRpm';
