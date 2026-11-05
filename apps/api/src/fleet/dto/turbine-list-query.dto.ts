import { Transform, Type } from 'class-transformer';
import {
  DEFAULT_TURBINE_PAGE,
  IsUtcTimestamp,
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

  /**
   * The instant `status` is judged at (reporting = newest reading at most 15 minutes before it; a
   * later reading counts as reporting). Default: the server's clock. Any date: it only affects the
   * caller's own read, and cursors do not depend on it.
   */
  @IsOptional()
  @IsUtcTimestamp({ allowFuture: true })
  asOf?: string;

  /** The `nextCursor` / `prevCursor` of a previous page. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}
