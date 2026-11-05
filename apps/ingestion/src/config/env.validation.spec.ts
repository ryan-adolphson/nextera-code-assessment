import { validateEnv } from './env.validation.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5433/db',
  REDIS_URL: 'redis://localhost:6380',
};

describe('validateEnv', () => {
  it('applies defaults and converts numeric strings', () => {
    const env = validateEnv({ ...valid, PORT: '8080' });

    expect(env.PORT).toBe(8080);
    expect(env.DB_POOL_MAX).toBe(5);
    expect(env.INGEST_BATCH_MAX).toBe(100);
    expect(env.INGEST_MAX_QUEUED).toBe(500);
    expect(env.NODE_ENV).toBe('development');
  });

  it('defaults to port 3001 so it can run next to the API on 3000', () => {
    expect(validateEnv(valid).PORT).toBe(3001);
  });

  it('accepts the Cloud SQL Unix socket URL used on Cloud Run', () => {
    const url =
      'postgresql://u:p@localhost/db?host=/cloudsql/proj:us-central1:nextera-pg&schema=public';

    expect(validateEnv({ ...valid, DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it('lists every invalid variable', () => {
    const run = () => validateEnv({ PORT: 'abc', REDIS_URL: 'http://x' });

    expect(run).toThrow(/DATABASE_URL/);
    expect(run).toThrow(/PORT/);
    expect(run).toThrow(/REDIS_URL/);
  });

  it('accepts batching limits and rejects out-of-range ones', () => {
    const env = validateEnv({
      ...valid,
      INGEST_BATCH_MAX: '50',
      INGEST_MAX_QUEUED: '200',
    });
    expect(env.INGEST_BATCH_MAX).toBe(50);
    expect(env.INGEST_MAX_QUEUED).toBe(200);
    expect(() => validateEnv({ ...valid, INGEST_BATCH_MAX: '0' })).toThrow(
      /INGEST_BATCH_MAX/,
    );
    expect(() => validateEnv({ ...valid, INGEST_MAX_QUEUED: 'x' })).toThrow(
      /INGEST_MAX_QUEUED/,
    );
  });
});
