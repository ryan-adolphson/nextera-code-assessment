import { Module } from '@nestjs/common';
import { FarmsCacheModule } from '../farms-cache/farms-cache.module.js';
import { FleetController } from './fleet.controller.js';
import { FleetService } from './fleet.service.js';

@Module({
  imports: [FarmsCacheModule],
  controllers: [FleetController],
  providers: [FleetService],
})
export class FleetModule {}
