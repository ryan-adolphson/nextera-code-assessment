import { anomalyRollupJob, describeRollup } from './anomaly-rollup.js';

const now = new Date('2026-03-01T12:00:00Z');

describe('anomaly rollup job', () => {
  it('runs incrementally by default, or from a UTC day', () => {
    expect(anomalyRollupJob.parseArgs([], {}, now)).toEqual({
      mode: { kind: 'incremental' },
      every: undefined,
    });
    expect(anomalyRollupJob.parseArgs(['--every', '3600'], {}, now)).toEqual({
      mode: { kind: 'incremental' },
      every: 3600,
    });
    expect(
      anomalyRollupJob.parseArgs(['--from', '2026-02-20'], {}, now),
    ).toEqual({ mode: { kind: 'from', day: '2026-02-20' } });
  });

  it.each([
    [['--from', '2026-02-30']],
    [['--from', '2026-03-02']],
    [['--from', 'yesterday']],
    [['--from', '2026-02-20', '--every', '60']],
  ])('rejects %j', (argv) => {
    expect(() => anomalyRollupJob.parseArgs(argv, {}, now)).toThrow();
  });

  it('describes a skipped run', () => {
    expect(
      describeRollup({
        skipped: true,
        from: null,
        asOf: null,
        bins: 0,
        sampleDivisor: 1,
        reopened: 0,
        deleted: 0,
        written: 0,
        pruned: 0,
        chunks: 0,
      }),
    ).toMatch(/skipped/);
  });
});
