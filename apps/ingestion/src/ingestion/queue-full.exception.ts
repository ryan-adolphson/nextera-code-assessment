import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';

/** The ingest queue is full: 503 + Retry-After; nothing was written, so Pub/Sub just retries. */
export class QueueFullException extends ServiceUnavailableException {
  constructor(readonly retryAfterSeconds: number) {
    super('Ingestion queue is full, retry later');
  }
}

/** Adds Retry-After; the body and status stay Nest's 503 (no other filter turns it into a 500). */
@Catch(QueueFullException)
export class QueueFullFilter implements ExceptionFilter<QueueFullException> {
  catch(exception: QueueFullException, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(exception.getStatus())
      .set('Retry-After', String(exception.retryAfterSeconds))
      .json(exception.getResponse());
  }
}
