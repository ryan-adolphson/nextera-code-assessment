import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import type {
  HeldReadingResponse,
  UnallocatedResolutionResponse,
  UnallocatedTurbineResponse,
} from '@nextera/shared';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import {
  AssignUnallocatedDto,
  HeldReadingsQueryDto,
  UnallocatedListQueryDto,
} from './dto/unallocated.dto.js';
import { UnallocatedTurbinesService } from './unallocated-turbines.service.js';

/**
 * /api/unallocated-turbines: readings ingestion held for unknown turbines and farm mismatches, and
 * the owner's decisions on them. Owner and admin only (a viewer gets 404). `:id` is the entry's
 * UUID (else 400). The actions answer 200 (unblock: 204), 404 for an unknown entry, 409 when the
 * entry's kind or status doesn't allow the action.
 */
@Roles('owner')
@Controller('unallocated-turbines')
export class UnallocatedTurbinesController {
  constructor(private readonly unallocated: UnallocatedTurbinesService) {}

  @Get()
  list(
    @Query() query: UnallocatedListQueryDto,
  ): Promise<UnallocatedTurbineResponse[]> {
    return this.unallocated.list(query.status);
  }

  @Get(':id/readings')
  readings(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: HeldReadingsQueryDto,
  ): Promise<HeldReadingResponse[]> {
    return this.unallocated.readings(id, query.limit);
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignUnallocatedDto,
  ): Promise<UnallocatedResolutionResponse> {
    return this.unallocated.assign(id, dto);
  }

  @Post(':id/keep')
  @HttpCode(HttpStatus.OK)
  keep(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UnallocatedResolutionResponse> {
    return this.unallocated.keep(id);
  }

  @Post(':id/move')
  @HttpCode(HttpStatus.OK)
  move(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UnallocatedResolutionResponse> {
    return this.unallocated.move(id);
  }

  @Post(':id/block')
  @HttpCode(HttpStatus.OK)
  block(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UnallocatedTurbineResponse> {
    return this.unallocated.block(id, user);
  }

  @Post(':id/unblock')
  @HttpCode(HttpStatus.NO_CONTENT)
  unblock(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.unallocated.unblock(id);
  }
}
