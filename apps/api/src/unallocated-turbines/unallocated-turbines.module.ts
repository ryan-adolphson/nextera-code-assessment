import { Module } from '@nestjs/common';
import { UnallocatedTurbinesController } from './unallocated-turbines.controller.js';
import { UnallocatedTurbinesService } from './unallocated-turbines.service.js';

@Module({
  controllers: [UnallocatedTurbinesController],
  providers: [UnallocatedTurbinesService],
})
export class UnallocatedTurbinesModule {}
