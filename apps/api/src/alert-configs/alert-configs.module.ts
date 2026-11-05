import { Module } from '@nestjs/common';
import { FarmsCacheModule } from '../farms-cache/farms-cache.module.js';
import { AlertConfigsController } from './alert-configs.controller.js';
import { AlertConfigsService } from './alert-configs.service.js';

@Module({
  imports: [FarmsCacheModule],
  controllers: [AlertConfigsController],
  providers: [AlertConfigsService],
})
export class AlertConfigsModule {}
