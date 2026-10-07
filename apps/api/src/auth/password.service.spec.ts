import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  const passwords = new PasswordService();

  it('hashes with argon2id at the shared parameters and verifies', async () => {
    const hash = await passwords.hash('correct horse battery');

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(await passwords.verify(hash, 'correct horse battery')).toBe(true);
    expect(await passwords.verify(hash, 'correct horse batterY')).toBe(false);
  });

  it('treats a malformed hash as a wrong password', async () => {
    expect(await passwords.verify('not-a-hash', 'x')).toBe(false);
  });

  it('verifies a dummy hash for unknown users and always fails', async () => {
    expect(await passwords.verifyDummy('anything')).toBe(false);
  });
});
