import type { FarmDailyHistoryResponse } from '@nextera/shared';
import type { Response } from 'express';
import { mock } from 'vitest-mock-extended';
import { jsonEtag } from '../common/etag.js';
import { FarmDailyQueryDto } from './dto/farm-daily-query.dto.js';
import { FleetController } from './fleet.controller.js';
import { FleetService } from './fleet.service.js';

describe('FleetController', () => {
  describe('dailyHistory', () => {
    it('sends the ETag of the body and Cache-Control: private, no-cache (always revalidate)', async () => {
      const body = {
        farmId: 'FARM01',
        days: [],
      } as unknown as FarmDailyHistoryResponse;
      const fleet = mock<FleetService>();
      fleet.dailyHistory.mockResolvedValue(body);
      const res = mock<Response>();

      const result = await new FleetController(fleet).dailyHistory(
        'FARM01',
        new FarmDailyQueryDto(),
        res,
      );

      expect(result).toBe(body);
      expect(res.setHeader).toHaveBeenCalledWith('ETag', jsonEtag(body));
      // No max-age: the browser must ask (and get a 304) on every request, so the web's
      // Refresh sees a new rollup run at once.
      expect(res.setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'private, no-cache',
      );
    });
  });
});
