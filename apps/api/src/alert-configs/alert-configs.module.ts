import { Module } from '@nestjs/common';
import { AlertConfigsController } from './alert-configs.controller.js';
import { AlertConfigsService } from './alert-configs.service.js';

@Module({
  controllers: [AlertConfigsController],
  providers: [AlertConfigsService],
})
export class AlertConfigsModule {}
