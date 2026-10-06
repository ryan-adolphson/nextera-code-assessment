import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import type { AlertConfigResponse } from '@nextera/shared';
import { AlertConfigsService } from './alert-configs.service.js';
import {
  CreateAlertConfigDto,
  UpdateAlertConfigDto,
} from './dto/alert-config.dto.js';

/**
 * /api/alert-configs: alert thresholds. `:id` must be a UUID (else 400).
 * Known gap: writes are unauthenticated, like the rest of the API; add auth before production use.
 */
@Controller('alert-configs')
export class AlertConfigsController {
  constructor(private readonly alertConfigs: AlertConfigsService) {}

  @Get()
  list(): Promise<AlertConfigResponse[]> {
    return this.alertConfigs.list();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AlertConfigResponse> {
    return this.alertConfigs.get(id);
  }

  @Post()
  create(@Body() dto: CreateAlertConfigDto): Promise<AlertConfigResponse> {
    return this.alertConfigs.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAlertConfigDto,
  ): Promise<AlertConfigResponse> {
    return this.alertConfigs.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.alertConfigs.remove(id);
  }
}
