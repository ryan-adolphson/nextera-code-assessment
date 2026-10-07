import { validateEnv } from './env.validation.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5433/db',
  REDIS_URL: 'redis://localhost:6380',
  JWT_SECRET: 'x'.repeat(32),
};

describe('validateEnv', () => {
  it('applies defaults and converts numeric strings', () => {
    const env = validateEnv({ ...valid, PORT: '8080' });

    expect(env.PORT).toBe(8080);
    expect(env.DB_POOL_MAX).toBe(5);
    expect(env.NODE_ENV).toBe('development');
    expect(env.CORS_ORIGINS).toBe('');
    expect(env.JWT_ISSUER).toBe('nextera-api');
    expect(env.JWT_AUDIENCE).toBe('nextera-web');
  });

  it.each([
    ['missing', undefined],
    ['empty (compose passes "" when unset)', ''],
    ['shorter than 32 characters', 'too-short-secret-0123456789abcd'],
  ])(
    'refuses a JWT_SECRET that is %s, without printing it',
    (_case, secret) => {
      const run = () => validateEnv({ ...valid, JWT_SECRET: secret });

      expect(run).toThrow(/JWT_SECRET/);
      if (secret) expect(run).not.toThrow(secret);
    },
  );

  it('accepts a 64-character key (openssl rand -base64 48)', () => {
    const secret = 'A'.repeat(63) + '=';
    expect(validateEnv({ ...valid, JWT_SECRET: secret }).JWT_SECRET).toBe(
      secret,
    );
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
});
