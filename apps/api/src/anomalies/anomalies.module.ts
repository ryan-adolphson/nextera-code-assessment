import { Module } from '@nestjs/common';
import { AnomaliesController } from './anomalies.controller.js';
import { AnomaliesService } from './anomalies.service.js';

@Module({
  controllers: [AnomaliesController],
  providers: [AnomaliesService],
})
export class AnomaliesModule {}
