/**
 * argon2id parameters for password hashes, used by the API (login) and the seed script so both
 * write the same kind of hash. OWASP's minimum: m = 19 MiB, t = 2, p = 1 (about 30-60 ms per hash
 * and 19 MiB per concurrent sign-in, which fits a 512 MiB Cloud Run instance). Plain values, so this
 * package doesn't need the native argon2 module at runtime; `type: 2` is argon2.argon2id.
 */
export const PASSWORD_HASH_OPTIONS = {
  type: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Emails are stored and looked up trimmed and lower-cased, so one address is one user. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
