import { assertLocalDatabase, parseScaleSeedEnv } from './seed-scale.js';

const NOW = new Date('2026-03-01T00:00:00Z');

describe('parseScaleSeedEnv', () => {
  it('defaults to a million turbines on 10,000 farms, a 1 % sample and one day', () => {
    expect(parseScaleSeedEnv({}, NOW)).toEqual({
      farms: 10_000,
      turbines: 1_000_000,
      samplePercent: 1,
      hours: 24,
      now: NOW,
    });
  });

  it('takes overrides from SCALE_*', () => {
    expect(
      parseScaleSeedEnv(
        {
          SCALE_FARMS: '20',
          SCALE_TURBINES: '2000',
          SCALE_SAMPLE_PERCENT: '5',
          SCALE_HOURS: '6',
          SCALE_NOW: '2026-04-01T10:07:00Z',
        },
        NOW,
      ),
    ).toEqual({
      farms: 20,
      turbines: 2000,
      samplePercent: 5,
      hours: 6,
      now: new Date('2026-04-01T10:07:00Z'),
    });
  });

  it.each([
    [{ SCALE_FARMS: '0' }, /SCALE_FARMS/],
    [{ SCALE_TURBINES: '1.5' }, /SCALE_TURBINES/],
    [{ SCALE_SAMPLE_PERCENT: '101' }, /SCALE_SAMPLE_PERCENT/],
    [{ SCALE_HOURS: '800' }, /SCALE_HOURS/],
    [{ SCALE_NOW: 'soon' }, /SCALE_NOW/],
    [
      { SCALE_FARMS: '10', SCALE_TURBINES: '30000' },
      /at most 2000 turbines per farm/,
    ],
  ])('rejects %j', (env, message) => {
    expect(() => parseScaleSeedEnv(env, NOW)).toThrow(message);
  });
});

describe('assertLocalDatabase', () => {
  it.each([
    'postgresql://u:p@localhost:5433/nextera',
    'postgresql://u:p@127.0.0.1/nextera',
    'postgres://u:p@[::1]:5432/nextera',
  ])('accepts %s', (url) => {
    expect(() => assertLocalDatabase(url)).not.toThrow();
  });

  it.each([
    'postgresql://u:p@10.1.2.3/nextera',
    'postgresql://u:p@db.example.com:5432/nextera',
    // Cloud SQL form: localhost in the URL, the real host in ?host=.
    'postgresql://u:p@localhost/nextera?host=/cloudsql/proj:region:db',
    'postgresql://u:p@localhost/nextera?hostaddr=10.1.2.3',
    'mysql://u:p@localhost/nextera',
  ])('refuses %s, without echoing the password', (url) => {
    expect(() => assertLocalDatabase(url)).toThrow(/Refusing/);
    try {
      assertLocalDatabase(url);
    } catch (error) {
      expect((error as Error).message).not.toContain(':p@');
    }
  });

  it('refuses a missing or malformed URL', () => {
    expect(() => assertLocalDatabase(undefined)).toThrow(/not set/);
    expect(() => assertLocalDatabase('not a url')).toThrow(/not a valid URL/);
  });
});
