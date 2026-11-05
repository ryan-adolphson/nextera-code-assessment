import { FLEET_TICK } from '@nextera/shared';
import { liveSummaryJob } from './live-summary.js';

const now = new Date('2026-03-01T00:00:00Z');

describe('live summary job', () => {
  it('needs REDIS_URL to publish the tick, unless --no-publish', () => {
    expect(() => liveSummaryJob.parseArgs([], {}, now)).toThrow(/REDIS_URL/);
    expect(
      liveSummaryJob.parseArgs([], { REDIS_URL: 'redis://x' }, now),
    ).toEqual({ publish: true, every: undefined });
    expect(
      liveSummaryJob.parseArgs(['--no-publish', '--every', '60'], {}, now),
    ).toEqual({ publish: false, every: 60 });
  });

  it('names the event fleet.tick', () => {
    expect(FLEET_TICK).toBe('fleet.tick');
  });
});
