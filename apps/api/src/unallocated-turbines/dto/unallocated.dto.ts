import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  DEFAULT_TELEMETRY_LIMIT,
  MAX_TELEMETRY_LIMIT,
  UnallocatedStatus,
} from '@nextera/shared';

const STATUSES = Object.values(UnallocatedStatus);
const FINITE = { allowNaN: false, allowInfinity: false };

/** GET /api/unallocated-turbines?status=pending|blocked (default pending). */
export class UnallocatedListQueryDto {
  @IsOptional()
  @IsIn(STATUSES, { message: `status must be one of: ${STATUSES.join(', ')}` })
  status: UnallocatedStatus = 'pending';
}

/** GET /api/unallocated-turbines/:id/readings?limit= (newest first, default 288, max 2016). */
export class HeldReadingsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_TELEMETRY_LIMIT)
  limit: number = DEFAULT_TELEMETRY_LIMIT;
}

/**
 * Validates the field only when it is present: undefined means "use the farm's coordinates", while
 * null still fails validation.
 */
const IfPresent = () => ValidateIf((_, value) => value !== undefined);

/**
 * POST /api/unallocated-turbines/:id/assign: the farm to create the turbine on, and optionally its
 * coordinates (both or neither; default: the farm's).
 */
export class AssignUnallocatedDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  farmId: string;

  @IfPresent()
  @IsNumber(FINITE, { message: 'latitude must be a finite number' })
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IfPresent()
  @IsNumber(FINITE, { message: 'longitude must be a finite number' })
  @Min(-180)
  @Max(180)
  longitude?: number;
}
