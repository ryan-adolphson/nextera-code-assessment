import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TelemetryIngestionService } from '../ingestion/telemetry-ingestion.service.js';
import { PubSubController } from './pubsub.controller.js';
import type { PubSubPushEnvelope } from './pubsub-push.dto.js';

/** A row of telemetry.csv as a message payload. */
const reading = {
  turbine_id: 'TURB001',
  farm_id: 'FARM01',
  timestamp: '2026-01-01T00:00:00Z',
  received_at: '2026-01-01T00:02:00Z',
  power_output_kw: 2331.2,
  wind_speed_ms: 8.0,
  rotor_rpm: 14.0,
  blade_pitch_deg: 3.6,
  gearbox_temp_c: 81.6,
};

const envelope = (payload: unknown, messageId = 'm1'): PubSubPushEnvelope => ({
  subscription: 'projects/p/subscriptions/telemetry-ingestion',
  message: {
    messageId,
    publishTime: '2026-01-01T00:02:01Z',
    data: Buffer.from(
      typeof payload === 'string' ? payload : JSON.stringify(payload),
    ).toString('base64'),
  },
});

describe('PubSubController', () => {
  let controller: PubSubController;
  const ingestion = { ingest: vi.fn() };

  beforeEach(async () => {
    ingestion.ingest.mockReset().mockResolvedValue('stored');
    const moduleRef = await Test.createTestingModule({
      controllers: [PubSubController],
      providers: [{ provide: TelemetryIngestionService, useValue: ingestion }],
    }).compile();
    controller = moduleRef.get(PubSubController);
    vi.spyOn(controller['logger'], 'log').mockImplementation(() => undefined);
    vi.spyOn(controller['logger'], 'warn').mockImplementation(() => undefined);
  });

  it('decodes a telemetry.csv-shaped payload and passes the publish time along', async () => {
    await controller.telemetry(envelope(reading));

    expect(ingestion.ingest).toHaveBeenCalledWith(
      expect.objectContaining(reading),
      '2026-01-01T00:02:01Z',
    );
  });

  it('accepts abnormal but plausible readings (anomalies are data, not errors)', async () => {
    await controller.telemetry(
      envelope({ ...reading, gearbox_temp_c: 126.5, blade_pitch_deg: 44 }),
    );
    expect(ingestion.ingest).toHaveBeenCalled();
  });

  it.each([
    ['non-JSON data', 'not json'],
    ['missing fields', { turbine_id: 'TURB001' }],
    ['a non-ISO timestamp', { ...reading, timestamp: '01/01/2026 00:00' }],
    ['negative power', { ...reading, power_output_kw: -5 }],
    ['an impossible gearbox temperature', { ...reading, gearbox_temp_c: 900 }],
    ['a numeric string', { ...reading, wind_speed_ms: '8.0' }],
    ['unexpected fields', { ...reading, admin: true }],
  ])(
    'rejects %s with 400 (Pub/Sub retries, then dead-letters it)',
    async (_, payload) => {
      await expect(
        controller.telemetry(envelope(payload)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(ingestion.ingest).not.toHaveBeenCalled();
    },
  );
});
