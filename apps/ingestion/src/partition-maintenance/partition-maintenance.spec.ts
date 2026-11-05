import {
  describeMaintenance,
  parseRetentionDays,
  partitionMaintenanceJob,
} from './partition-maintenance.js';

const now = new Date('2026-03-01T00:00:00Z');

describe('partition maintenance job', () => {
  it('has no retention unless TELEMETRY_RETENTION_DAYS is set', () => {
    expect(parseRetentionDays(undefined)).toBeNull();
    expect(parseRetentionDays('')).toBeNull();
    expect(parseRetentionDays('31')).toBe(31);
  });

  it.each(['0', '-5', '1.5', 'a month'])(
    'rejects a retention of %j',
    (value) => {
      expect(() => parseRetentionDays(value)).toThrow(
        /TELEMETRY_RETENTION_DAYS/,
      );
    },
  );

  it('reads --days-ahead, --every and the retention from the env', () => {
    expect(partitionMaintenanceJob.parseArgs([], {}, now)).toEqual({
      retentionDays: null,
      daysAhead: 3,
      every: undefined,
    });
    expect(
      partitionMaintenanceJob.parseArgs(
        ['--days-ahead', '7', '--every', '86400'],
        { TELEMETRY_RETENTION_DAYS: '31' },
        now,
      ),
    ).toEqual({ retentionDays: 31, daysAhead: 7, every: 86_400 });
    expect(() =>
      partitionMaintenanceJob.parseArgs(['--days-ahead', '99'], {}, now),
    ).toThrow(/--days-ahead/);
    expect(() =>
      partitionMaintenanceJob.parseArgs(['--nope'], {}, now),
    ).toThrow();
  });

  it('says plainly when nothing is deleted', () => {
    expect(
      describeMaintenance({
        created: ['2026-03-02'],
        dropped: 0,
        purgedDefault: 0,
        retentionCutoff: null,
        skipped: false,
      }),
    ).toBe(
      'created 1 day partition(s) (2026-03-02), no retention set: nothing dropped',
    );
  });

  it('reports a skipped run (another run holds the lock)', () => {
    expect(
      describeMaintenance({
        created: [],
        dropped: 0,
        purgedDefault: 0,
        retentionCutoff: null,
        skipped: true,
      }),
    ).toMatch(/^skipped: another/);
  });
});
