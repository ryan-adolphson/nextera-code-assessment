import { Module } from '@nestjs/common';
import { FleetController } from './fleet.controller.js';
import { FleetService } from './fleet.service.js';

@Module({
  controllers: [FleetController],
  providers: [FleetService],
})
export class FleetModule {}
