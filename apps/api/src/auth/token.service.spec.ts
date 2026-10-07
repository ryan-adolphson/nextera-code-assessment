import { ConfigService } from '@nestjs/config';
import { SignJWT, UnsecuredJWT, base64url } from 'jose';
import { ACCESS_TOKEN_TTL_SECONDS, TokenService } from './token.service.js';

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const USER = {
  id: '6f1c2b1e-8a4d-4c2b-9b1a-3d2e1f0a9b8c',
  role: 'owner' as const,
};

const config = (overrides: Record<string, string> = {}) =>
  new ConfigService({
    JWT_SECRET: SECRET,
    JWT_ISSUER: 'nextera-api',
    JWT_AUDIENCE: 'nextera-web',
    ...overrides,
  });

/** A token signed with our key but arbitrary claims/header, to probe each check. */
const forge = (
  claims: Record<string, unknown>,
  {
    alg = 'HS256',
    key = SECRET,
    exp = '1h',
    iss = 'nextera-api',
    aud = 'nextera-web',
    sub = USER.id,
  }: {
    alg?: string;
    key?: string;
    exp?: string | number;
    iss?: string;
    aud?: string;
    sub?: string;
  } = {},
) =>
  new SignJWT({ role: USER.role, ...claims })
    .setProtectedHeader({ alg })
    .setSubject(sub)
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(key));

describe('TokenService', () => {
  const tokens = new TokenService(config());

  it('signs HS256 tokens with sub, role, iss, aud, iat, exp (24 h) and jti, and verifies them', async () => {
    const now = new Date('2026-10-07T12:00:00Z');
    const { token, expiresAt } = await tokens.sign(USER, now);

    expect(expiresAt).toEqual(new Date('2026-10-08T12:00:00Z'));
    const [header, payload] = token
      .split('.')
      .slice(0, 2)
      .map((part) =>
        JSON.parse(new TextDecoder().decode(base64url.decode(part))),
      );
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(payload).toEqual({
      sub: USER.id,
      role: 'owner',
      iss: 'nextera-api',
      aud: 'nextera-web',
      iat: now.getTime() / 1000,
      exp: now.getTime() / 1000 + ACCESS_TOKEN_TTL_SECONDS,
      jti: expect.any(String),
    });
    expect(JSON.stringify(payload)).not.toContain('@'); // no email in a readable token

    const fresh = await tokens.sign(USER);
    expect(await tokens.verify(fresh.token)).toEqual({
      sub: USER.id,
      role: 'owner',
      exp: fresh.expiresAt.getTime() / 1000,
    });
  });

  it.each([
    ['expired', () => forge({}, { exp: Math.floor(Date.now() / 1000) - 60 })],
    ['signed with another key', () => forge({}, { key: `${SECRET}-other` })],
    ['from another issuer', () => forge({}, { iss: 'someone-else' })],
    ['for another audience', () => forge({}, { aud: 'someone-else' })],
    ['HS512 (algorithm not allowed)', () => forge({}, { alg: 'HS512' })],
    ['an unknown role', () => forge({ role: 'operator' })],
    ['without a role', () => forge({ role: undefined })],
    [
      'with a non-UUID subject',
      () => forge({}, { sub: 'admin@nextera.local' }),
    ],
    [
      'unsigned (alg: none)',
      async () =>
        new UnsecuredJWT({ role: 'admin' })
          .setSubject(USER.id)
          .setIssuer('nextera-api')
          .setAudience('nextera-web')
          .setIssuedAt()
          .setExpirationTime('1h')
          .encode(),
    ],
    [
      'tampered (role raised, signature kept)',
      async () => {
        const [header, , signature] = (await tokens.sign(USER)).token.split(
          '.',
        );
        const payload = base64url.encode(
          JSON.stringify({
            sub: USER.id,
            role: 'admin',
            iss: 'nextera-api',
            aud: 'nextera-web',
            exp: 9_999_999_999,
            iat: 1,
          }),
        );
        return `${header}.${payload}.${signature}`;
      },
    ],
    ['garbage', async () => 'not.a.jwt'],
    ['empty', async () => ''],
  ])('rejects a token that is %s', async (_case, make) => {
    expect(await tokens.verify(await make())).toBeNull();
  });

  it('accepts a token that expired within the 30 s clock tolerance', async () => {
    const token = await forge({}, { exp: Math.floor(Date.now() / 1000) - 10 });
    expect(await tokens.verify(token)).not.toBeNull();
  });

  it('rejects tokens of an API with another secret (keys come from JWT_SECRET)', async () => {
    const other = new TokenService(config({ JWT_SECRET: `${SECRET}-rotated` }));
    expect(await other.verify((await tokens.sign(USER)).token)).toBeNull();
  });
});
