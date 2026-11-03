import { IsBoolean } from 'class-validator';

/** PATCH /api/turbines/:id: required, a JSON boolean ("true" and 1 are rejected). */
export class UpdateTurbineDto {
  @IsBoolean({ message: 'commissioned must be a boolean' })
  commissioned: boolean;
}
