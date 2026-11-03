/**
 * Deterministic demo telemetry (telemetry.csv rows) for `npm run db:seed:demo` and the live
 * `npm run demo:feed`.
 *
 * Values are a pure function of (seed, turbine, measurement time): wind is a smooth daily cycle
 * plus slow farm-wide noise, slower per-turbine noise and a little per-reading jitter; power, rotor
 * speed, pitch and gearbox temperature are derived from it with the formulas of
 * apps/ingestion/scripts/publish-sample.ts. So a feed reading for 12:05 continues the curve the
 * seed wrote up to 12:00, whatever `end` either of them used.
 *
 * The anomalies (DEMO_ANOMALIES) are placed at fixed offsets from `end` instead, so a fresh seed
 * always shows them in the last 72 h. A later top-up run only adds readings newer than the ones
 * stored (the rest are duplicates), so it doesn't add the anomalies again; it does fill the earlier
 * gap, since that time is no longer at the gap's offset.
 */

/** Telemetry readings are 5 minutes apart. */
export const TELEMETRY_STEP_MINUTES = 5;
const STEP_MS = TELEMETRY_STEP_MINUTES * 60_000;
const HOUR_MS = 3_600_000;

/** One row in telemetry.csv format (also the Pub/Sub message contract). */
export interface GeneratedTelemetryRow {
  turbine_id: string;
  farm_id: string;
  /** ISO 8601, UTC, on a 5-minute boundary. */
  timestamp: string;
  /** ISO 8601, UTC: a few seconds after `timestamp`, 10–20 min for the late readings. */
  received_at: string;
  power_output_kw: number;
  wind_speed_ms: number;
  rotor_rpm: number;
  blade_pitch_deg: number;
  gearbox_temp_c: number;
}

export interface GenerateTelemetryOptions {
  turbines: readonly { turbineId: string; farmId: string }[];
  /** The newest measurement time; floored to a 5-minute boundary. */
  end: Date | number;
  /** Length of the window: readings at end, end - 5 min, … (hours × 12 per turbine). */
  hours: number;
  /** PRNG seed (DEMO_SEED for the demo). */
  seed: number;
}

/** Minutes before `end` of each anomaly's first reading (later readings follow every 5 min). */
export const DEMO_ANOMALIES = {
  /**
   * TURB001 stops: 0 kW in 15.8 m/s wind, identical values (the fixture's 13:40–13:50 values) for
   * 6 hours, from 50 h to 44 h before `end`.
   */
  frozenPower: {
    turbineId: 'TURB001',
    offsetMinutes: 50 * 60,
    readings: 72,
    values: {
      power_output_kw: 0,
      wind_speed_ms: 15.8,
      rotor_rpm: 4.2,
      blade_pitch_deg: 12.5,
      gearbox_temp_c: 68,
    },
  },
  /** TURB002: one 44° blade pitch reading (power drops to 60 %). */
  pitchSpike: {
    turbineId: 'TURB002',
    offsetMinutes: 30 * 60,
    readings: 1,
    bladePitchDeg: 44,
  },
  /**
   * TURB002: the gearbox sensor stuck at 126.5 °C for 90 min, from 6 h to 4.5 h before `end` (the
   * other values stay normal, so its power keeps changing).
   */
  gearboxStuck: {
    turbineId: 'TURB002',
    offsetMinutes: 6 * 60,
    readings: 18,
    gearboxTempC: 126.5,
  },
  /**
   * Turbines that stopped reporting (red, "No data in 60 min"): the seed ends their readings
   * `offsetMinutes` (a multiple of 5) before `end`, 90 min to 5 h, and the live feed never publishes
   * them, so they stay red. TURB013 is the original one.
   */
  stopped: [
    { turbineId: 'TURB013', offsetMinutes: 90 }, // FARM05
    { turbineId: 'TURB053', offsetMinutes: 120 }, // FARM02
    { turbineId: 'TURB091', offsetMinutes: 150 }, // FARM04
    { turbineId: 'TURB139', offsetMinutes: 180 }, // FARM07
    { turbineId: 'TURB160', offsetMinutes: 240 }, // FARM08
    { turbineId: 'TURB195', offsetMinutes: 300 }, // FARM10
  ],
  /**
   * Turbines that report, but late by a constant `lagMinutes` (a multiple of 5): the seed ends their
   * readings `lagMinutes` before `end`, and the live feed publishes, on each tick, their reading for
   * the boundary at or before now − lagMinutes. So their staleness pill stays put while someone
   * presents: 20 min → "No data in 15 min" (yellow), 45 min → "No data in 30 min" (orange).
   * TURB011 and TURB018 are the original ones. With the stopped ones: 20 of the 200 turbines
   * (10 %), on every farm, none with another anomaly or a DEMO_UNALLOCATED plan.
   */
  lagging: [
    { turbineId: 'TURB011', lagMinutes: 20 }, // FARM04
    { turbineId: 'TURB030', lagMinutes: 20 }, // FARM01
    { turbineId: 'TURB047', lagMinutes: 20 }, // FARM02
    { turbineId: 'TURB063', lagMinutes: 20 }, // FARM03
    { turbineId: 'TURB102', lagMinutes: 20 }, // FARM05
    { turbineId: 'TURB117', lagMinutes: 20 }, // FARM06
    { turbineId: 'TURB152', lagMinutes: 20 }, // FARM08
    { turbineId: 'TURB186', lagMinutes: 20 }, // FARM10
    { turbineId: 'TURB018', lagMinutes: 45 }, // FARM07
    { turbineId: 'TURB036', lagMinutes: 45 }, // FARM01
    { turbineId: 'TURB070', lagMinutes: 45 }, // FARM03
    { turbineId: 'TURB085', lagMinutes: 45 }, // FARM04
    { turbineId: 'TURB124', lagMinutes: 45 }, // FARM06
    { turbineId: 'TURB173', lagMinutes: 45 }, // FARM09
  ],
  /** TURB008: 4 readings missing (a 20-minute hole). */
  gap: { turbineId: 'TURB008', offsetMinutes: 20 * 60, readings: 4 },
  /**
   * TURB999 claims FARM01 but isn't in the fleet (outside TURB001–TURB200, never seeded): only the
   * live feed publishes it, so ingestion holds its readings as an unallocated (unknown) turbine.
   */
  unallocated: { turbineId: 'TURB999', farmId: 'FARM01' },
  /** Readings that arrived late: received_at = timestamp + delayMinutes. */
  late: [
    { turbineId: 'TURB005', offsetMinutes: 12 * 60, delayMinutes: 10 },
    { turbineId: 'TURB014', offsetMinutes: 24 * 60, delayMinutes: 15 },
    { turbineId: 'TURB021', offsetMinutes: 36 * 60, delayMinutes: 20 },
  ],
} as const;

/** Each stale demo turbine's minutes behind `end` (stopped: its offset; lagging: its lag). */
const REPORTING_LAG_MINUTES: ReadonlyMap<string, number> = new Map([
  ...DEMO_ANOMALIES.stopped.map((s) => [s.turbineId, s.offsetMinutes] as const),
  ...DEMO_ANOMALIES.lagging.map((l) => [l.turbineId, l.lagMinutes] as const),
]);

/**
 * Minutes before `end` of a demo turbine's newest reading: a stopped turbine's offset, a lagging
 * turbine's lag, else 0. The one rule the seed (generateTelemetry) and the live feed both go by.
 */
export function demoReportingLagMinutes(turbineId: string): number {
  return REPORTING_LAG_MINUTES.get(turbineId) ?? 0;
}

/** Whether the live feed never publishes this turbine (a stopped one). */
export function isDemoStopped(turbineId: string): boolean {
  return DEMO_ANOMALIES.stopped.some((s) => s.turbineId === turbineId);
}

/** `time` floored to a 5-minute boundary. */
export function floorToTelemetryStep(time: Date | number): Date {
  const ms = typeof time === 'number' ? time : time.getTime();
  return new Date(Math.floor(ms / STEP_MS) * STEP_MS);
}

/**
 * Rows for every turbine at end, end - 5 min, … (hours × 12 steps), oldest first, then in
 * `turbines` order; minus the gap and each stale turbine's last minutes: a stopped one's offset,
 * a lagging one's `lagMinutes` (demoReportingLagMinutes).
 */
export function generateTelemetry({
  turbines,
  end,
  hours,
  seed,
}: GenerateTelemetryOptions): GeneratedTelemetryRow[] {
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new RangeError(`hours must be a positive number, got ${hours}`);
  }
  const endMs = floorToTelemetryStep(end).getTime();
  if (Number.isNaN(endMs)) throw new RangeError('end is not a valid time');
  const steps = Math.max(1, Math.round((hours * HOUR_MS) / STEP_MS));
  const a = DEMO_ANOMALIES;

  const rows: GeneratedTelemetryRow[] = [];
  for (let step = steps - 1; step >= 0; step--) {
    const time = endMs - step * STEP_MS;
    const minutesBeforeEnd = step * TELEMETRY_STEP_MINUTES;
    const within = (anomaly: { offsetMinutes: number }, readings: number) =>
      minutesBeforeEnd <= anomaly.offsetMinutes &&
      minutesBeforeEnd >
        anomaly.offsetMinutes - readings * TELEMETRY_STEP_MINUTES;

    for (const { turbineId, farmId } of turbines) {
      const is = (anomaly: { turbineId: string }) =>
        anomaly.turbineId === turbineId;
      if (minutesBeforeEnd < demoReportingLagMinutes(turbineId)) continue;
      if (is(a.gap) && within(a.gap, a.gap.readings)) continue;

      const row = normalReading(seed, turbineId, farmId, time);
      if (is(a.frozenPower) && within(a.frozenPower, a.frozenPower.readings)) {
        Object.assign(row, a.frozenPower.values);
      }
      if (is(a.pitchSpike) && within(a.pitchSpike, a.pitchSpike.readings)) {
        row.blade_pitch_deg = a.pitchSpike.bladePitchDeg;
        row.power_output_kw = round1(row.power_output_kw * 0.6);
      }
      if (
        is(a.gearboxStuck) &&
        within(a.gearboxStuck, a.gearboxStuck.readings)
      ) {
        row.gearbox_temp_c = a.gearboxStuck.gearboxTempC;
      }
      const late = a.late.find(
        (l) => is(l) && minutesBeforeEnd === l.offsetMinutes,
      );
      if (late) {
        row.received_at = new Date(
          time + late.delayMinutes * 60_000,
        ).toISOString();
      }
      rows.push(row);
    }
  }
  return rows;
}

/** A reading without anomalies: a pure function of seed, turbine and time. */
function normalReading(
  seed: number,
  turbineId: string,
  farmId: string,
  time: number,
): GeneratedTelemetryRow {
  const hours = time / HOUR_MS;
  const hourOfDay = (time % (24 * HOUR_MS)) / HOUR_MS;
  // Per farm: a mean wind of 7.5–10 m/s and a daily peak around 15:00 ± 3 h UTC.
  const mean = 7.5 + 2.5 * random(seed, `${farmId}:mean`, 0);
  const peak = 15 + 6 * (random(seed, `${farmId}:peak`, 0) - 0.5);
  const daily = 2.5 * Math.cos((2 * Math.PI * (hourOfDay - peak)) / 24);
  const farmNoise = 3 * smoothNoise(seed, farmId, hours / 3); // weather fronts, farm-wide
  const turbineNoise = 0.8 * smoothNoise(seed, turbineId, hours);
  const jitter = 0.4 * (2 * random(seed, `${turbineId}:jitter`, time) - 1);
  const wind = clamp(mean + daily + farmNoise + turbineNoise + jitter, 3, 22);
  const delaySeconds =
    5 + Math.floor(55 * random(seed, `${turbineId}:rx`, time));

  // The formulas of publish-sample.ts.
  return {
    turbine_id: turbineId,
    farm_id: farmId,
    timestamp: new Date(time).toISOString(),
    received_at: new Date(time + delaySeconds * 1000).toISOString(),
    power_output_kw: round1(Math.min(3500, 35 * wind ** 1.8)),
    wind_speed_ms: round1(wind),
    rotor_rpm: round1(9 + wind * 0.6),
    blade_pitch_deg: round1(Math.max(0, 6 - wind * 0.4)),
    gearbox_temp_c: round1(74 + wind),
  };
}

/** Smooth value noise in [-1, 1]: random knots at whole `x`, smoothstep-interpolated between. */
function smoothNoise(seed: number, key: string, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f);
  const a = random(seed, key, i);
  const b = random(seed, key, i + 1);
  return 2 * (a + (b - a) * s) - 1;
}

/** A uniform number in [0, 1) for (seed, key, n): mulberry32 seeded with an FNV-1a hash. */
function random(seed: number, key: string, n: number): number {
  return mulberry32(fnv1a(`${seed}:${key}:${n}`))();
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(state: number): () => number {
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));
const round1 = (n: number) => Math.round(n * 10) / 10;
