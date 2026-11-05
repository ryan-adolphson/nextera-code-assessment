import { Transform, Type } from 'class-transformer';
import {
  DEFAULT_TURBINE_PAGE,
  MAX_TURBINE_PAGE,
  TURBINE_SORTS,
  TURBINE_STATUSES,
  type TurbineSort,
  type TurbineStatus,
} from '@nextera/shared';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** "true" / "false" in a query string → a boolean (anything else stays and fails IsBoolean). */
const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/** GET /api/turbines. See `listTurbines` (`@nextera/shared`) for the semantics. */
export class TurbineListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  farmId?: string;

  /** Case-insensitive substring of the turbine id, or of a farm's id or name. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  q?: string;

  @IsOptional()
  @IsIn(TURBINE_STATUSES)
  status?: TurbineStatus;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  commissioned?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  hasData?: boolean;

  /** `power`, `wind` and `gearbox` need `farmId` (400 otherwise). */
  @IsOptional()
  @IsIn(TURBINE_SORTS)
  sort?: TurbineSort;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  dir?: 'asc' | 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_TURBINE_PAGE)
  limit: number = DEFAULT_TURBINE_PAGE;

  /** The `nextCursor` / `prevCursor` of a previous page. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}
