import { PASSWORD_HASH_OPTIONS, normalizeEmail } from './passwords.js';

describe('passwords', () => {
  it('uses argon2id with at least the OWASP minimum cost', () => {
    expect(PASSWORD_HASH_OPTIONS.type).toBe(2); // argon2.argon2id
    expect(PASSWORD_HASH_OPTIONS.memoryCost).toBeGreaterThanOrEqual(19_456);
    expect(PASSWORD_HASH_OPTIONS.timeCost).toBeGreaterThanOrEqual(2);
  });

  it('normalises emails by trimming and lower-casing', () => {
    expect(normalizeEmail('  Owner@Nextera.LOCAL ')).toBe(
      'owner@nextera.local',
    );
  });
});
