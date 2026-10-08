import { POOL_MAX, SESSION_OPTIONS, createReadOnlyPrisma } from './prisma.js';

describe('createReadOnlyPrisma', () => {
  it('makes every session read-only, with a statement timeout and a small pool', () => {
    expect(SESSION_OPTIONS).toContain('-c default_transaction_read_only=on');
    expect(SESSION_OPTIONS).toContain('-c statement_timeout=');
    expect(POOL_MAX).toBe(2);
  });

  it.each([
    'postgresql://u:p@localhost:5433/nextera?options=-c%20default_transaction_read_only%3Doff',
    'postgresql://u:p@localhost:5433/nextera?sslmode=disable&options=x',
  ])(
    'refuses a URL that sets its own options (it would override them): %s',
    (url) => {
      expect(() => createReadOnlyPrisma(url)).toThrow(/must not set "options"/);
    },
  );

  it('accepts a plain URL without connecting', async () => {
    const prisma = createReadOnlyPrisma(
      'postgresql://u:p@localhost:1/nextera?schema=public',
    );
    await prisma.$disconnect();
  });
});
