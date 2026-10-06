import type { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@nextera/shared';
import { PrismaExceptionFilter } from './prisma-exception.filter.js';

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('boom', {
    code,
    clientVersion: 'test',
  });

describe('PrismaExceptionFilter', () => {
  const filter = new PrismaExceptionFilter();
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;

  beforeEach(() => {
    json.mockClear();
    status.mockClear();
  });

  it.each([
    ['P2002', 409],
    ['P2003', 409],
    ['P2025', 404],
  ])('maps %s to HTTP %i', (code, httpStatus) => {
    filter.catch(prismaError(code), host);

    expect(status).toHaveBeenCalledWith(httpStatus);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: httpStatus }),
    );
  });

  it('maps unknown codes to 500 without leaking the Prisma message', () => {
    vi.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);

    filter.catch(prismaError('P9999'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('boom');
  });
});
