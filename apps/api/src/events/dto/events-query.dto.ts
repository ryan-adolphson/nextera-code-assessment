import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

/** Most turbines one stream can follow. */
export const MAX_SCOPED_TURBINES = 100;

/** Business ids ("TURB001"); also keeps anything odd out of the Redis channel name. */
export const TURBINE_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export class EventsQueryDto {
  /**
   * Comma-separated turbine business ids whose live readings the stream carries. Duplicates are
   * dropped; `turbines=` (empty) means none; an empty entry ("a,,b") or a bad id is a 400.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? [...new Set(value === '' ? [] : value.split(','))]
      : value,
  )
  @IsArray()
  @ArrayMaxSize(MAX_SCOPED_TURBINES)
  @Matches(TURBINE_ID_PATTERN, { each: true })
  turbines?: string[];

  /** Read by the auth guard (`@AllowQueryToken()`); declared so the global whitelist lets it in. */
  @IsOptional()
  @IsString()
  access_token?: string;
}
