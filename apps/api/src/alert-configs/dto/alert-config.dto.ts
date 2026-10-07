import { IsBoolean, IsIn, IsNumber, ValidateIf } from 'class-validator';
import {
  AlertComparison,
  AlertLevel,
  MeasurementMetric,
} from '@nextera/shared';

const METRICS = Object.values(MeasurementMetric);
const COMPARISONS = Object.values(AlertComparison);
const LEVELS = Object.values(AlertLevel);

const FINITE = { allowNaN: false, allowInfinity: false };

const BOOLEAN = { message: 'enabled must be a boolean' };

/** POST /api/alert-configs: every field is required except `enabled` (default true). */
export class CreateAlertConfigDto {
  @IsIn(METRICS, {
    message: `measurementMetric must be one of: ${METRICS.join(', ')}`,
  })
  measurementMetric: MeasurementMetric;

  @IsIn(COMPARISONS, {
    message: `comparison must be one of: ${COMPARISONS.join(', ')}`,
  })
  comparison: AlertComparison;

  /** The threshold, in the metric's unit. A JSON number (strings are rejected). */
  @IsNumber(FINITE, { message: 'valueMetric must be a finite number' })
  valueMetric: number;

  @IsIn(LEVELS, { message: `alertLevel must be one of: ${LEVELS.join(', ')}` })
  alertLevel: AlertLevel;

  /** Optional; the database default is true. */
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean(BOOLEAN)
  enabled?: boolean;
}

/**
 * Validates the field only when it is present: undefined means "unchanged", while null (not
 * allowed for these required columns) still fails validation instead of reaching Prisma.
 */
const IfPresent = () => ValidateIf((_, value) => value !== undefined);

/** PATCH /api/alert-configs/:id: any subset of the fields (at least one). */
export class UpdateAlertConfigDto {
  @IfPresent()
  @IsIn(METRICS, {
    message: `measurementMetric must be one of: ${METRICS.join(', ')}`,
  })
  measurementMetric?: MeasurementMetric;

  @IfPresent()
  @IsIn(COMPARISONS, {
    message: `comparison must be one of: ${COMPARISONS.join(', ')}`,
  })
  comparison?: AlertComparison;

  @IfPresent()
  @IsNumber(FINITE, { message: 'valueMetric must be a finite number' })
  valueMetric?: number;

  @IfPresent()
  @IsIn(LEVELS, { message: `alertLevel must be one of: ${LEVELS.join(', ')}` })
  alertLevel?: AlertLevel;

  /** false disables the rule (the way to retire a rule with alert history). */
  @IfPresent()
  @IsBoolean(BOOLEAN)
  enabled?: boolean;
}
