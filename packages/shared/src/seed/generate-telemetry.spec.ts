import { STUCK_SENSOR_MIN_POWER_RANGE_KW } from '../wind/anomalies.js';
import { DEMO_SEED, DEMO_TURBINES } from './demo-fleet.js';
import { DEMO_UNALLOCATED } from './demo-unallocated.js';
import {
  DEMO_ANOMALIES,
  demoReportingLagMinutes,
  isDemoStopped,
  floorToTelemetryStep,
  generateTelemetry,
  type GeneratedTelemetryRow,
} from './generate-telemetry.js';

const END = new Date('2026-10-08T12:00:00Z');
const MIN = 60_000;
const generate = (end: Date | number = END, hours = 72) =>
  generateTelemetry({ turbines: DEMO_TURBINES, end, hours, seed: DEMO_SEED });

const rows = generate();
const byTurbine = new Map<string, GeneratedTelemetryRow[]>();
for (const r of rows) {
  const list = byTurbine.get(r.turbine_id) ?? [];
  list.push(r);
  byTurbine.set(r.turbine_id, list);
}
const at = (turbineId: string, minutesBeforeEnd: number) =>
  of(turbineId).find(
    (r) =>
      r.timestamp ===
      new Date(END.getTime() - minutesBeforeEnd * MIN).toISOString(),
  );
const of = (turbineId: string) => byTurbine.get(turbineId) ?? [];
const farmOf = (turbineId: string) =>
  DEMO_TURBINES.find((t) => t.turbineId === turbineId)!.farmId;
const metrics = (r: GeneratedTelemetryRow | undefined) =>
  r && {
    power_output_kw: r.power_output_kw,
    wind_speed_ms: r.wind_speed_ms,
    rotor_rpm: r.rotor_rpm,
    blade_pitch_deg: r.blade_pitch_deg,
    gearbox_temp_c: r.gearbox_temp_c,
  };

describe('generateTelemetry', () => {
  it('is deterministic for the same input and differs for another seed', () => {
    expect(generate()).toEqual(rows);
    expect(
      generateTelemetry({
        turbines: DEMO_TURBINES,
        end: END,
        hours: 72,
        seed: DEMO_SEED + 1,
      }),
    ).not.toEqual(rows);
  });

  it('floors end to a 5-minute boundary and steps every 5 minutes, oldest first', () => {
    const shifted = generate(new Date('2026-10-08T12:04:59.999Z'));
    expect(shifted).toEqual(rows);

    const times = [...new Set(of('TURB003').map((r) => r.timestamp))];
    expect(times.at(-1)).toBe('2026-10-08T12:00:00.000Z');
    expect(times[0]).toBe('2026-10-05T12:05:00.000Z'); // (end - 72 h, end]
    for (let i = 1; i < times.length; i++) {
      expect(Date.parse(times[i]) - Date.parse(times[i - 1])).toBe(5 * MIN);
    }
  });

  it('writes 72 h × 12 readings per turbine, minus the gap, the stopped and the lagging turbines', () => {
    const perTurbine = 72 * 12;
    const missing =
      DEMO_ANOMALIES.gap.readings +
      DEMO_ANOMALIES.stopped.reduce((n, s) => n + s.offsetMinutes / 5, 0) +
      DEMO_ANOMALIES.lagging.reduce((n, l) => n + l.lagMinutes / 5, 0);
    expect(rows).toHaveLength(DEMO_TURBINES.length * perTurbine - missing);
    expect(of('TURB003')).toHaveLength(perTurbine);
    expect(of(DEMO_ANOMALIES.gap.turbineId)).toHaveLength(
      perTurbine - DEMO_ANOMALIES.gap.readings,
    );
  });

  it('continues the same curve for a later end (values depend on time, not on end)', () => {
    const later = generate(END.getTime() + 60 * MIN, 2);
    const reading = later.find(
      (r) => r.turbine_id === 'TURB010' && r.timestamp === END.toISOString(),
    );
    expect(reading).toEqual(at('TURB010', 0));
  });

  it('keeps normal readings in plausible ranges that no default rule flags', () => {
    const normal = of('TURB003');
    for (const r of normal) {
      expect(r.wind_speed_ms).toBeGreaterThanOrEqual(3);
      expect(r.wind_speed_ms).toBeLessThanOrEqual(22);
      expect(r.power_output_kw).toBeGreaterThanOrEqual(100);
      expect(r.power_output_kw).toBeLessThanOrEqual(3500);
      expect(r.blade_pitch_deg).toBeLessThanOrEqual(30);
      expect(r.gearbox_temp_c).toBeLessThanOrEqual(100);
    }
    // The wind varies (a daily cycle plus noise), it isn't a constant.
    const winds = normal.map((r) => r.wind_speed_ms);
    expect(Math.max(...winds) - Math.min(...winds)).toBeGreaterThan(4);
  });

  it('freezes TURB001 at 0 kW in 15.8 m/s wind for 72 identical readings (6 h) from ~50 h before end', () => {
    const { turbineId, offsetMinutes, readings, values } =
      DEMO_ANOMALIES.frozenPower;
    expect(turbineId).toBe('TURB001');
    expect(offsetMinutes).toBe(50 * 60);
    expect(readings).toBe(72);
    for (let i = 0; i < readings; i++) {
      expect(metrics(at(turbineId, offsetMinutes - i * 5))).toEqual(values);
    }
    expect(values).toMatchObject({ power_output_kw: 0, wind_speed_ms: 15.8 });
    expect(at(turbineId, offsetMinutes + 5)?.power_output_kw).toBeGreaterThan(
      100,
    );
    expect(
      at(turbineId, offsetMinutes - readings * 5)?.power_output_kw,
    ).toBeGreaterThan(100);
  });

  it('spikes TURB002 blade pitch to 44° once ~30 h before end', () => {
    const { turbineId, offsetMinutes } = DEMO_ANOMALIES.pitchSpike;
    expect(at(turbineId, offsetMinutes)?.blade_pitch_deg).toBe(44);
    expect(of(turbineId).filter((r) => r.blade_pitch_deg > 30)).toHaveLength(1);
  });

  it('sticks TURB002 gearbox at 126.5 °C for 18 readings (90 min) from ~6 h before end, power still moving', () => {
    const { turbineId, offsetMinutes, readings } = DEMO_ANOMALIES.gearboxStuck;
    expect(readings).toBe(18);
    const hot = of(turbineId).filter((r) => r.gearbox_temp_c > 100);
    expect(hot.map((r) => r.timestamp)).toEqual(
      Array.from({ length: readings }, (_, i) =>
        new Date(END.getTime() - (offsetMinutes - i * 5) * MIN).toISOString(),
      ),
    );
    const power = hot.map((r) => r.power_output_kw);
    expect(Math.max(...power) - Math.min(...power)).toBeGreaterThan(
      STUCK_SENSOR_MIN_POWER_RANGE_KW,
    );
    expect(hot.every((r) => r.gearbox_temp_c === 126.5)).toBe(true);
  });

  it('stops TURB013 90 min before end and 5 more 2–5 h before it ("No data in 60 min")', () => {
    expect(DEMO_ANOMALIES.stopped).toEqual([
      { turbineId: 'TURB013', offsetMinutes: 90 },
      { turbineId: 'TURB053', offsetMinutes: 120 },
      { turbineId: 'TURB091', offsetMinutes: 150 },
      { turbineId: 'TURB139', offsetMinutes: 180 },
      { turbineId: 'TURB160', offsetMinutes: 240 },
      { turbineId: 'TURB195', offsetMinutes: 300 },
    ]);
    for (const { turbineId, offsetMinutes } of DEMO_ANOMALIES.stopped) {
      expect(offsetMinutes % 5, turbineId).toBe(0);
      expect(offsetMinutes, turbineId).toBeGreaterThan(60); // red
      expect(isDemoStopped(turbineId)).toBe(true);
      expect(demoReportingLagMinutes(turbineId)).toBe(offsetMinutes);
      expect(of(turbineId).at(-1)?.timestamp).toBe(
        new Date(END.getTime() - offsetMinutes * MIN).toISOString(),
      );
      expect(at(turbineId, offsetMinutes - 5)).toBeUndefined();
      expect(of(turbineId)).toHaveLength(72 * 12 - offsetMinutes / 5);
    }
  });

  it('lags 8 turbines 20 min (yellow) and 6 turbines 45 min (orange), TURB011 and TURB018 among them', () => {
    const { lagging } = DEMO_ANOMALIES;
    const byLag = (minutes: number) =>
      lagging.filter((l) => l.lagMinutes === minutes).map((l) => l.turbineId);
    expect(byLag(20)).toHaveLength(8);
    expect(byLag(20)).toContain('TURB011');
    expect(byLag(45)).toHaveLength(6);
    expect(byLag(45)).toContain('TURB018');
    expect(lagging).toHaveLength(14);
    for (const { turbineId, lagMinutes } of lagging) {
      expect(lagMinutes % 5, turbineId).toBe(0); // the feed stays on 5-min boundaries
      expect(isDemoStopped(turbineId)).toBe(false);
      expect(demoReportingLagMinutes(turbineId)).toBe(lagMinutes);
      expect(of(turbineId).at(-1)?.timestamp).toBe(
        new Date(END.getTime() - lagMinutes * MIN).toISOString(),
      );
      expect(at(turbineId, lagMinutes - 5)).toBeUndefined();
      // Everything before the lag is there: a lag, not a gap.
      expect(of(turbineId)).toHaveLength(72 * 12 - lagMinutes / 5);
    }
  });

  it('makes about 10 % of the fleet stale, on every farm, without other anomalies', () => {
    const stale: string[] = [
      ...DEMO_ANOMALIES.lagging.map((l) => l.turbineId),
      ...DEMO_ANOMALIES.stopped.map((s) => s.turbineId),
    ];
    expect(new Set(stale).size).toBe(stale.length);
    expect(stale).toHaveLength(20);
    expect(stale.length / DEMO_TURBINES.length).toBe(0.1);

    const anomalous = new Set<string>([
      DEMO_ANOMALIES.frozenPower.turbineId,
      DEMO_ANOMALIES.pitchSpike.turbineId,
      DEMO_ANOMALIES.gearboxStuck.turbineId,
      DEMO_ANOMALIES.gap.turbineId,
      ...DEMO_ANOMALIES.late.map((l) => l.turbineId),
      // Their held readings come from the same generator: a lag would cut them short.
      ...DEMO_UNALLOCATED.map((e) => e.turbineId),
    ]);
    const perFarm = new Map<string, number>();
    for (const turbineId of stale) {
      expect(anomalous.has(turbineId), turbineId).toBe(false);
      const farm = farmOf(turbineId);
      perFarm.set(farm, (perFarm.get(farm) ?? 0) + 1);
    }
    expect(perFarm.size).toBe(10);
    expect(Math.max(...perFarm.values())).toBeLessThanOrEqual(3);

    // Everyone else reports up to `end`.
    const fresh = DEMO_TURBINES.filter((t) => !stale.includes(t.turbineId));
    expect(fresh).toHaveLength(180);
    for (const { turbineId } of fresh) {
      expect(demoReportingLagMinutes(turbineId)).toBe(0);
      expect(of(turbineId).at(-1)?.timestamp, turbineId).toBe(
        END.toISOString(),
      );
    }
  });

  it('demoReportingLagMinutes: a stopped offset, a lag, else 0', () => {
    expect(demoReportingLagMinutes('TURB013')).toBe(90);
    expect(demoReportingLagMinutes('TURB195')).toBe(300);
    expect(demoReportingLagMinutes('TURB011')).toBe(20);
    expect(demoReportingLagMinutes('TURB018')).toBe(45);
    expect(demoReportingLagMinutes('TURB003')).toBe(0);
    expect(demoReportingLagMinutes('TURB999')).toBe(0);
  });

  it('leaves a gap of a few readings', () => {
    const { turbineId, offsetMinutes, readings } = DEMO_ANOMALIES.gap;
    expect(at(turbineId, offsetMinutes + 5)).toBeDefined();
    for (let i = 0; i < readings; i++) {
      expect(at(turbineId, offsetMinutes - i * 5)).toBeUndefined();
    }
    expect(at(turbineId, offsetMinutes - readings * 5)).toBeDefined();
  });

  it('receives most readings within a minute and the late ones 10–20 min late', () => {
    const delay = (r: GeneratedTelemetryRow) =>
      (Date.parse(r.received_at) - Date.parse(r.timestamp)) / MIN;
    for (const {
      turbineId,
      offsetMinutes,
      delayMinutes,
    } of DEMO_ANOMALIES.late) {
      expect(delayMinutes).toBeGreaterThanOrEqual(10);
      expect(delayMinutes).toBeLessThanOrEqual(20);
      expect(delay(at(turbineId, offsetMinutes)!)).toBe(delayMinutes);
    }
    const late = rows.filter((r) => delay(r) >= 1);
    expect(late).toHaveLength(DEMO_ANOMALIES.late.length);
    expect(rows.every((r) => delay(r) > 0)).toBe(true);
  });

  it('returns one reading per turbine for a single step, without the stopped and lagging ones', () => {
    const tick = generate(END, 5 / 60);
    const missing = [
      ...DEMO_ANOMALIES.stopped.map((s) => s.turbineId),
      ...DEMO_ANOMALIES.lagging.map((l) => l.turbineId),
    ];
    expect(tick).toHaveLength(DEMO_TURBINES.length - missing.length);
    expect(tick.every((r) => r.timestamp === END.toISOString())).toBe(true);
    for (const id of missing) {
      expect(tick.map((r) => r.turbine_id)).not.toContain(id);
    }
  });

  it('rejects a non-positive window and an invalid end', () => {
    expect(() => generate(END, 0)).toThrow(RangeError);
    expect(() => generate(new Date('nope'))).toThrow(RangeError);
  });
});

describe('floorToTelemetryStep', () => {
  it('floors to the 5-minute boundary', () => {
    expect(floorToTelemetryStep(Date.parse('2026-10-08T12:09:30Z'))).toEqual(
      new Date('2026-10-08T12:05:00Z'),
    );
  });
});
