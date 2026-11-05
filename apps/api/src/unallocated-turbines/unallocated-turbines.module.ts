import { Module } from '@nestjs/common';
import { FarmsCacheModule } from '../farms-cache/farms-cache.module.js';
import { UnallocatedTurbinesController } from './unallocated-turbines.controller.js';
import { UnallocatedTurbinesService } from './unallocated-turbines.service.js';

@Module({
  imports: [FarmsCacheModule],
  controllers: [UnallocatedTurbinesController],
  providers: [UnallocatedTurbinesService],
})
export class UnallocatedTurbinesModule {}
