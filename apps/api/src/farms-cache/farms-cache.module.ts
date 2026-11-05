import { Module } from '@nestjs/common';
import { FarmsCacheService } from './farms-cache.service.js';

@Module({
  providers: [FarmsCacheService],
  exports: [FarmsCacheService],
})
export class FarmsCacheModule {}
