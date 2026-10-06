import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { parseTelemetryCsv, TelemetryCsvError } from './telemetry-csv.js';
import {
  BatchResult,
  TelemetryIngestionService,
} from './telemetry-ingestion.service.js';

/** ~100k rows of telemetry.csv; Cloud Run's request limit is 32 MiB. */
export const MAX_CSV_BYTES = 10 * 1024 * 1024;
/** Cap on row errors returned in one response (the total is always reported). */
const MAX_REPORTED_ERRORS = 100;

/**
 * Bulk load of telemetry in telemetry.csv format (backfills, corrections, data from other systems):
 *   curl -F file=@readings.csv http://localhost:3001/ingest/telemetry
 * 201 with counts on success. 400 with errors by line if anything is invalid; nothing is stored.
 * In GCP the worker is private (IAM), so callers need an identity token with run.invoker.
 */
@Controller('ingest')
export class CsvUploadController {
  private readonly logger = new Logger(CsvUploadController.name);

  constructor(private readonly ingestion: TelemetryIngestionService) {}

  @Post('telemetry')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_CSV_BYTES, files: 1 } }),
  )
  async upload(
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<BatchResult> {
    if (!file) {
      throw new BadRequestException(
        'Upload a CSV file in the multipart field "file"',
      );
    }

    try {
      const parsed = parseTelemetryCsv(file.buffer.toString('utf8'));
      const result = await this.ingestion.ingestBatch(parsed);
      this.logger.log(
        `CSV ${file.originalname}: ${result.inserted} inserted, ${result.duplicates} duplicates`,
      );
      return result;
    } catch (error) {
      if (!(error instanceof TelemetryCsvError)) throw error;
      this.logger.warn(
        `CSV ${file.originalname} rejected: ${error.message} (${error.rowErrors.length} rows)`,
      );
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        message: error.message,
        errorCount: error.rowErrors.length,
        errors: error.rowErrors.slice(0, MAX_REPORTED_ERRORS),
      });
    }
  }
}
