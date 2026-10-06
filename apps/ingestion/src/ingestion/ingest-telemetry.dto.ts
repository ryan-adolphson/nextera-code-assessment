import {
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

const number = { allowNaN: false, allowInfinity: false } as const;

/**
 * One reading published to the telemetry topic. Field names match telemetry.csv, so the provided
 * dataset doubles as the producer contract.
 *
 * Bounds reject only physically impossible values (broken sensors, unit mix-ups). Plausible but
 * abnormal readings (e.g. a 126.5 °C gearbox or a 44° pitch) are stored: detecting them is the
 * point of the system.
 */
export class IngestTelemetryDto {
  @IsString()
  @Length(1, 64)
  turbine_id: string;

  @IsString()
  @Length(1, 64)
  farm_id: string;

  /** When the turbine measured the values (ISO 8601, UTC). */
  @IsISO8601({ strict: true })
  timestamp: string;

  /** Optional for live data (Pub/Sub publish time is used); set when backfilling. */
  @IsOptional()
  @IsISO8601({ strict: true })
  received_at?: string;

  @IsNumber(number)
  @Min(0)
  @Max(20_000)
  power_output_kw: number;

  @IsNumber(number)
  @Min(0)
  @Max(100)
  wind_speed_ms: number;

  @IsNumber(number)
  @Min(0)
  @Max(100)
  rotor_rpm: number;

  @IsNumber(number)
  @Min(-10)
  @Max(100)
  blade_pitch_deg: number;

  @IsNumber(number)
  @Min(-60)
  @Max(250)
  gearbox_temp_c: number;
}
