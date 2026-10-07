import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  EventStore,
  PrismaService,
  TELEMETRY_RECEIVED,
  type AlertConfig,
  type Telemetry,
} from '@nextera/shared';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { IngestTelemetryDto } from './ingest-telemetry.dto.js';
import { TelemetryIngestionService } from './telemetry-ingestion.service.js';

const dto: IngestTelemetryDto = {
  turbine_id: 'TURB001',
  farm_id: 'FARM01',
  timestamp: '2026-01-01T00:00:00Z',
  power_output_kw: 2331.2,
  wind_speed_ms: 8,
  rotor_rpm: 14,
  blade_pitch_deg: 3.6,
  gearbox_temp_c: 81.6,
};

const stored: Telemetry = {
  id: 'r1',
  turbineId: 'TURB001',
  farmId: 'FARM01',
  timestamp: new Date('2026-01-01T00:00:00Z'),
  receivedAt: new Date('2026-01-01T00:02:00Z'),
  createdAt: new Date('2026-01-01T00:02:01Z'),
  powerOutputKw: 2331.2,
  windSpeedMs: 8,
  rotorRpm: 14,
  bladePitchDeg: 3.6,
  gearboxTempC: 81.6,
};

const rule = (overrides: Partial<AlertConfig> = {}): AlertConfig => ({
  id: 'rule-gearbox-error',
  measurementMetric: 'gearboxTempC',
  comparison: 'above',
  valueMetric: 80,
  alertLevel: 'error',
  enabled: true,
  ...overrides,
});

describe('TelemetryIngestionService', () => {
  let service: TelemetryIngestionService;
  let prisma: DeepMockProxy<PrismaService>;
  const events = { publish: vi.fn() };

  beforeEach(async () => {
    prisma = mockDeep<PrismaService>();
    prisma.turbine.findMany.mockResolvedValue([
      { turbineId: 'TURB001', farmId: 'FARM01' },
    ] as never);
    prisma.telemetry.createManyAndReturn.mockResolvedValue([stored]);
    prisma.alertConfig.findMany.mockResolvedValue([]); // no rules unless a test adds some
    // Interactive transactions run against the same mock.
    prisma.$transaction.mockImplementation((fn: unknown) =>
      (fn as (tx: PrismaService) => Promise<unknown>)(prisma),
    );
    events.publish.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [
        TelemetryIngestionService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventStore, useValue: events },
      ],
    }).compile();
    service = moduleRef.get(TelemetryIngestionService);
  });

  it('stores the reading (skipping duplicates) and publishes telemetry.received', async () => {
    await expect(service.ingest(dto, '2026-01-01T00:02:00Z')).resolves.toBe(
      'stored',
    );

    expect(prisma.telemetry.createManyAndReturn).toHaveBeenCalledWith({
      data: [
        {
          turbineId: 'TURB001',
          farmId: 'FARM01',
          timestamp: new Date('2026-01-01T00:00:00Z'),
          receivedAt: new Date('2026-01-01T00:02:00Z'), // Pub/Sub publish time
          powerOutputKw: 2331.2,
          windSpeedMs: 8,
          rotorRpm: 14,
          bladePitchDeg: 3.6,
          gearboxTempC: 81.6,
        },
      ],
      skipDuplicates: true,
    });
    expect(events.publish).toHaveBeenCalledWith(
      TELEMETRY_RECEIVED,
      expect.objectContaining({
        id: 'r1',
        turbineId: 'TURB001',
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    );
  });

  it('stores the enabled rules the reading triggers in the same transaction, and publishes them', async () => {
    // stored.gearboxTempC is 81.6: above 80 (error) and 60 (info), not above 90 (warn).
    const error = rule();
    const info = rule({
      id: 'rule-gearbox-info',
      valueMetric: 60,
      alertLevel: 'info',
    });
    const warn = rule({
      id: 'rule-gearbox-warn',
      valueMetric: 90,
      alertLevel: 'warn',
    });
    prisma.alertConfig.findMany.mockResolvedValue([info, warn, error]);

    await service.ingest(dto);

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(prisma.alertConfig.findMany).toHaveBeenCalledWith({
      where: { enabled: true },
    });
    expect(prisma.telemetryAlert.createMany).toHaveBeenCalledWith({
      data: [
        { telemetryId: 'r1', alertId: 'rule-gearbox-error' },
        { telemetryId: 'r1', alertId: 'rule-gearbox-info' },
      ],
    });
    const [, payload] = events.publish.mock.calls[0];
    expect(
      payload.alerts.map((a: AlertConfig) => [a.id, a.alertLevel]),
    ).toEqual([
      ['rule-gearbox-error', 'error'],
      ['rule-gearbox-info', 'info'],
    ]);
  });

  it('writes no alert rows when no rule fires, and publishes an empty alerts list', async () => {
    prisma.alertConfig.findMany.mockResolvedValue([rule({ valueMetric: 120 })]);

    await service.ingest(dto);

    expect(prisma.telemetryAlert.createMany).not.toHaveBeenCalled();
    expect(events.publish.mock.calls[0][1].alerts).toEqual([]);
  });

  it('looks turbines up by their business key (turbine_id), not the UUID id', async () => {
    await service.ingest(dto);

    expect(prisma.turbine.findMany).toHaveBeenCalledWith({
      where: { turbineId: { in: ['TURB001'] } },
      select: { turbineId: true, farmId: true },
    });
  });

  it('prefers received_at from the payload (backfills) over the publish time', async () => {
    await service.ingest(
      { ...dto, received_at: '2026-01-01T00:25:00Z' },
      '2026-03-01T00:00:00Z',
    );

    expect(prisma.telemetry.createManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            receivedAt: new Date('2026-01-01T00:25:00Z'),
          }),
        ],
      }),
    );
  });

  it('skips a duplicate (same turbine + timestamp) without publishing', async () => {
    prisma.telemetry.createManyAndReturn.mockResolvedValue([]);

    await expect(service.ingest(dto)).resolves.toBe('duplicate');
    expect(events.publish).not.toHaveBeenCalled();
    // Idempotent: a re-sent reading adds no alert rows either.
    expect(prisma.alertConfig.findMany).not.toHaveBeenCalled();
    expect(prisma.telemetryAlert.createMany).not.toHaveBeenCalled();
  });

  it('rejects an unknown turbine with 400 and stores nothing', async () => {
    prisma.turbine.findMany.mockResolvedValue([]);

    await expect(service.ingest(dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.telemetry.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('rejects a reading whose farm is not the turbine’s farm', async () => {
    await expect(service.ingest({ ...dto, farm_id: 'FARM02' })).rejects.toThrow(
      'Turbine TURB001 belongs to FARM01, not FARM02',
    );
    expect(prisma.telemetry.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('removes the row when publishing fails, so the Pub/Sub retry stores and publishes it again', async () => {
    events.publish.mockRejectedValue(new Error('redis down'));
    prisma.telemetry.delete.mockResolvedValue(stored);

    await expect(service.ingest(dto)).rejects.toThrow('redis down');
    expect(prisma.telemetry.delete).toHaveBeenCalledWith({
      where: { id: 'r1' },
    });
  });

  describe('ingestBatch (CSV upload)', () => {
    const row = (
      line: number,
      overrides: Partial<IngestTelemetryDto> = {},
    ) => ({
      line,
      reading: { ...dto, ...overrides },
    });
    const parsed = (...rows: ReturnType<typeof row>[]) => ({
      rows,
      rowErrors: [],
    });

    beforeEach(() => {
      prisma.turbine.findMany.mockResolvedValue([
        { turbineId: 'TURB001', farmId: 'FARM01' },
        { turbineId: 'TURB002', farmId: 'FARM02' },
      ] as never);
    });

    it('rejects the file when any row has an unknown turbine or the wrong farm, merged with format errors by line', async () => {
      const input = {
        rows: [
          row(2),
          row(3, { turbine_id: 'TURB999' }),
          row(5, { farm_id: 'FARM02' }),
        ],
        rowErrors: [
          {
            line: 4,
            errors: ['timestamp must be a valid ISO 8601 date string'],
          },
        ],
      };

      await expect(service.ingestBatch(input)).rejects.toMatchObject({
        rowErrors: [
          { line: 3, errors: ['Unknown turbine TURB999'] },
          {
            line: 4,
            errors: ['timestamp must be a valid ISO 8601 date string'],
          },
          {
            line: 5,
            errors: ['Turbine TURB001 belongs to FARM01, not FARM02'],
          },
        ],
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects the file when only format errors exist, without touching the database for writes', async () => {
      await expect(
        service.ingestBatch({
          rows: [row(2)],
          rowErrors: [{ line: 3, errors: ['bad'] }],
        }),
      ).rejects.toMatchObject({ rowErrors: [{ line: 3, errors: ['bad'] }] });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('inserts in one transaction, counts duplicates and uses the upload time when received_at is empty', async () => {
      const uploadedAt = new Date('2026-03-01T12:00:00Z');
      prisma.telemetry.createManyAndReturn.mockResolvedValue([stored]);

      const result = await service.ingestBatch(
        parsed(
          row(2),
          row(3, {
            timestamp: '2026-01-01T00:05:00Z',
            received_at: '2026-01-01T00:30:00Z',
          }),
        ),
        uploadedAt,
      );

      expect(result).toEqual({
        rows: 2,
        inserted: 1,
        duplicates: 1,
        turbines: ['TURB001'],
      });
      expect(prisma.telemetry.createManyAndReturn).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({ receivedAt: uploadedAt }),
          expect.objectContaining({
            receivedAt: new Date('2026-01-01T00:30:00Z'),
          }),
        ],
        skipDuplicates: true,
      });
    });

    it('loads the enabled rules once and stores the alerts of every new reading', async () => {
      const hot = { ...stored, id: 'hot', gearboxTempC: 126.5 };
      const cool = { ...stored, id: 'cool', gearboxTempC: 70 };
      prisma.telemetry.createManyAndReturn.mockResolvedValue([hot, cool]);
      prisma.alertConfig.findMany.mockResolvedValue([
        rule({ valueMetric: 120 }),
      ]);

      await service.ingestBatch(parsed(row(2), row(3)));

      expect(prisma.alertConfig.findMany).toHaveBeenCalledOnce();
      expect(prisma.telemetryAlert.createMany).toHaveBeenCalledWith({
        data: [{ telemetryId: 'hot', alertId: 'rule-gearbox-error' }],
      });
    });

    it('publishes only the newest new reading per turbine', async () => {
      const at = (
        turbineId: string,
        farmId: string,
        iso: string,
      ): Telemetry => ({
        ...stored,
        id: `${turbineId}-${iso}`,
        turbineId,
        farmId,
        timestamp: new Date(iso),
      });
      prisma.telemetry.createManyAndReturn.mockResolvedValue([
        at('TURB001', 'FARM01', '2026-03-01T00:10:00Z'),
        at('TURB001', 'FARM01', '2026-03-01T00:05:00Z'),
        at('TURB002', 'FARM02', '2026-03-01T00:00:00Z'),
      ]);

      await service.ingestBatch(parsed(row(2)));

      expect(events.publish).toHaveBeenCalledTimes(2);
      expect(events.publish.mock.calls.map(([, r]) => r.id).sort()).toEqual([
        'TURB001-2026-03-01T00:10:00Z',
        'TURB002-2026-03-01T00:00:00Z',
      ]);
    });

    it('does not fail the upload when the live update cannot be published (data is committed)', async () => {
      prisma.telemetry.createManyAndReturn.mockResolvedValue([stored]);
      events.publish.mockRejectedValue(new Error('redis down'));
      vi.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

      await expect(service.ingestBatch(parsed(row(2)))).resolves.toMatchObject({
        inserted: 1,
      });
      expect(prisma.telemetry.delete).not.toHaveBeenCalled();
    });
  });
});
