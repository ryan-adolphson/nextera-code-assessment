import type { TelemetryResponse } from '@nextera/shared';
import { MAX_READINGS_PER_TURBINE, groupByTurbine } from './list-alerts.js';

const rule = (
  alertLevel: 'info' | 'warn' | 'error',
  measurementMetric: 'gearboxTempC' | 'bladePitchDeg' = 'gearboxTempC',
  enabled = true,
) => ({
  id: `${measurementMetric}-${alertLevel}`,
  measurementMetric,
  comparison: 'above' as const,
  valueMetric: measurementMetric === 'gearboxTempC' ? 120 : 30,
  alertLevel,
  enabled,
});

const reading = (
  turbineId: string,
  timestamp: string,
  alerts: ReturnType<typeof rule>[],
): TelemetryResponse => ({
  id: `${turbineId}@${timestamp}`,
  turbineId,
  farmId: 'FARM02',
  timestamp,
  receivedAt: timestamp,
  powerOutputKw: 2200,
  windSpeedMs: 10.7,
  rotorRpm: 12.8,
  bladePitchDeg: 44,
  gearboxTempC: 126.5,
  alerts,
});

describe('groupByTurbine', () => {
  it('groups by turbine with the worst level, level counts and readable rules', () => {
    const groups = groupByTurbine([
      reading('TURB001', '2026-01-01T18:10:00.000Z', [
        rule('info', 'bladePitchDeg'),
      ]),
      reading('TURB002', '2026-01-02T03:30:00.000Z', [
        rule('error'),
        rule('warn', 'gearboxTempC', false),
      ]),
      reading('TURB002', '2026-01-02T03:25:00.000Z', [rule('error')]),
    ]);

    expect(groups).toEqual([
      {
        turbineId: 'TURB001',
        farmId: 'FARM02',
        worstLevel: 'info',
        levelCounts: { error: 0, warn: 0, info: 1 },
        flaggedReadings: 1,
        latestAlert: '2026-01-01T18:10:00.000Z',
        readings: [
          {
            timestamp: '2026-01-01T18:10:00.000Z',
            alerts: ['info: bladePitchDeg 44 above 30'],
          },
        ],
        omittedReadings: 0,
      },
      {
        turbineId: 'TURB002',
        farmId: 'FARM02',
        worstLevel: 'error',
        levelCounts: { error: 2, warn: 1, info: 0 },
        flaggedReadings: 2,
        latestAlert: '2026-01-02T03:30:00.000Z',
        readings: [
          {
            timestamp: '2026-01-02T03:30:00.000Z',
            alerts: [
              'error: gearboxTempC 126.5 above 120',
              'warn: gearboxTempC 126.5 above 120 (rule now disabled)',
            ],
          },
          {
            timestamp: '2026-01-02T03:25:00.000Z',
            alerts: ['error: gearboxTempC 126.5 above 120'],
          },
        ],
        omittedReadings: 0,
      },
    ]);
  });

  it('lists the newest readings per turbine and counts the rest', () => {
    const many = Array.from({ length: MAX_READINGS_PER_TURBINE + 3 }, (_, i) =>
      reading(
        'TURB002',
        new Date(Date.UTC(2026, 0, 2) - i * 300_000).toISOString(),
        [rule('warn')],
      ),
    );

    const [group] = groupByTurbine(many);

    expect(group.readings).toHaveLength(MAX_READINGS_PER_TURBINE);
    expect(group.omittedReadings).toBe(3);
    expect(group.flaggedReadings).toBe(MAX_READINGS_PER_TURBINE + 3);
    expect(group.levelCounts.warn).toBe(MAX_READINGS_PER_TURBINE + 3);
  });
});
