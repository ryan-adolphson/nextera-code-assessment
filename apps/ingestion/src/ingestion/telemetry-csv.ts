import { TELEMETRY_CSV_COLUMNS, parseCsv } from '@nextera/shared';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { IngestTelemetryDto } from './ingest-telemetry.dto.js';

/** A validated CSV row with its 1-based line number in the file (the header is line 1). */
export interface TelemetryCsvRow {
  line: number;
  reading: IngestTelemetryDto;
}

export interface RowError {
  line: number;
  errors: string[];
}

/** Rows that passed format validation, plus the format errors of the rows that didn't. */
export interface ParsedTelemetryCsv {
  rows: TelemetryCsvRow[];
  rowErrors: RowError[];
}

/** Thrown when the file can't be used; carries every problem found, by line. */
export class TelemetryCsvError extends Error {
  constructor(
    message: string,
    readonly rowErrors: RowError[] = [],
  ) {
    super(message);
  }
}

const NUMERIC = [
  'power_output_kw',
  'wind_speed_ms',
  'rotor_rpm',
  'blade_pitch_deg',
  'gearbox_temp_c',
] as const;

/**
 * Parses a telemetry.csv-formatted file and validates every row with the same rules as Pub/Sub
 * messages (IngestTelemetryDto). An empty `received_at` means "use the upload time".
 * File-level problems (empty file, wrong header, wrong column count) throw. Row problems are
 * collected and returned, so they can be reported together with database checks (unknown
 * turbines) and one upload attempt shows everything that needs fixing.
 */
export function parseTelemetryCsv(text: string): ParsedTelemetryCsv {
  if (!text.trim()) throw new TelemetryCsvError('The CSV file is empty');

  let records: Record<string, string>[];
  try {
    records = parseCsv(text, TELEMETRY_CSV_COLUMNS);
  } catch (error) {
    throw new TelemetryCsvError((error as Error).message);
  }
  if (records.length === 0) {
    throw new TelemetryCsvError('The CSV file has a header but no rows');
  }

  const rows: TelemetryCsvRow[] = [];
  const rowErrors: RowError[] = [];
  records.forEach((record, i) => {
    const line = i + 2;
    const reading = plainToInstance(IngestTelemetryDto, {
      ...record,
      received_at: record.received_at || undefined,
      ...Object.fromEntries(
        NUMERIC.map((key) => [
          key,
          record[key] === '' ? NaN : Number(record[key]),
        ]),
      ),
    });
    // Empty cells get a clear "required" message instead of whatever numeric rule fails first.
    const missing = TELEMETRY_CSV_COLUMNS.filter(
      (column) => column !== 'received_at' && record[column] === '',
    );
    const errors = [
      ...missing.map((column) => `${column} is required`),
      ...validateSync(reading, { stopAtFirstError: true })
        .filter(
          (e) => !missing.includes(e.property as (typeof missing)[number]),
        )
        .flatMap((e) => Object.values(e.constraints ?? {})),
    ];
    if (errors.length) rowErrors.push({ line, errors });
    else rows.push({ line, reading });
  });

  return { rows, rowErrors };
}
