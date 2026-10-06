import {
  ArgumentsHost,
  Catch,
  ConflictException,
  ExceptionFilter,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '@nextera/shared';

const KNOWN_ERRORS: Record<string, () => HttpException> = {
  P2002: () => new ConflictException('Resource already exists'),
  P2003: () =>
    new ConflictException('Operation violates a relation constraint'),
  P2025: () => new NotFoundException('Resource not found'),
};

/** Maps Prisma errors to HTTP errors so services can let them bubble up. */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const known = KNOWN_ERRORS[exception.code];
    if (!known) {
      this.logger.error(
        `Unhandled Prisma error ${exception.code}`,
        exception.stack,
      );
    }
    const error = known ? known() : new InternalServerErrorException();

    host
      .switchToHttp()
      .getResponse<Response>()
      .status(error.getStatus())
      .json(error.getResponse());
  }
}
