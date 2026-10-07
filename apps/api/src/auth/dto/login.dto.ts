import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  /** Trimmed and lower-cased before validation and lookup. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;

  /** Bounded so a huge body can't make hashing expensive. */
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password: string;
}
