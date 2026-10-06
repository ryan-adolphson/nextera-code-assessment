import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IngestTelemetryDto } from '../ingestion/ingest-telemetry.dto.js';
import { TelemetryIngestionService } from '../ingestion/telemetry-ingestion.service.js';
import { PubSubPushEnvelope } from './pubsub-push.dto.js';

/**
 * Pub/Sub push endpoint. Response codes drive delivery:
 * - 2xx: acknowledged (stored, or a duplicate of a stored reading).
 * - 4xx / 5xx: nacked and retried with backoff; after max delivery attempts the message goes to
 *   the dead-letter topic. Invalid payloads therefore end up in the DLQ for inspection.
 * Only Pub/Sub can call this in GCP: the service requires IAM (run.invoker) and the push
 * subscription authenticates with an OIDC token.
 */
@Controller('pubsub')
export class PubSubController {
  private readonly logger = new Logger(PubSubController.name);

  constructor(private readonly ingestion: TelemetryIngestionService) {}

  @Post('telemetry')
  @HttpCode(HttpStatus.NO_CONTENT)
  async telemetry(@Body() envelope: PubSubPushEnvelope): Promise<void> {
    const { messageId, data, publishTime } = envelope.message;
    const reading = await this.decode(messageId, data);
    const result = await this.ingestion.ingest(reading, publishTime);
    this.logger.log(
      `Message ${messageId}: ${reading.turbine_id} @ ${reading.timestamp} ${result}`,
    );
  }

  private async decode(
    messageId: string,
    data: string,
  ): Promise<IngestTelemetryDto> {
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    } catch {
      throw new BadRequestException(`Message ${messageId}: data is not JSON`);
    }

    const dto = plainToInstance(IngestTelemetryDto, json);
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length > 0) {
      const details = errors.flatMap((e) => Object.values(e.constraints ?? {}));
      this.logger.warn(`Message ${messageId} rejected: ${details.join('; ')}`);
      throw new BadRequestException(details);
    }
    return dto;
  }
}
