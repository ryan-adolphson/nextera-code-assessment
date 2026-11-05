import { Module } from '@nestjs/common';
import { FarmsCacheModule } from '../farms-cache/farms-cache.module.js';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';

@Module({
  imports: [FarmsCacheModule],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
