import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { IngestTelemetryDto } from '../apps/ingestion/src/ingestion/ingest-telemetry.dto.ts';
import { PubSubPushEnvelope } from '../apps/ingestion/src/pubsub/pubsub-push.dto.ts';
import {
  LOAD_FARM_ID,
  buildEnvelope,
  loadTurbineId,
  workerAnchorMs,
} from './processor.js';

const NOW = Date.parse('2026-11-03T12:00:30.500Z');
const decode = (envelope) =>
  JSON.parse(Buffer.from(envelope.message.data, 'base64').toString('utf8'));

describe('buildEnvelope', () => {
  const build = (seq, workerId = 3, fleet = 2) =>
    buildEnvelope({
      seq,
      workerId,
      anchorMs: workerAnchorMs(NOW, workerId),
      fleet,
      nowMs: NOW,
    });

  it('passes the ingestion worker’s own envelope and reading validation', async () => {
    const envelope = build(0);
    const options = { whitelist: true, forbidNonWhitelisted: true };

    expect(
      await validate(plainToInstance(PubSubPushEnvelope, envelope), options),
    ).toEqual([]);
    expect(
      await validate(
        plainToInstance(IngestTelemetryDto, decode(envelope)),
        options,
      ),
    ).toEqual([]);
    expect(decode(envelope)).toMatchObject({
      turbine_id: loadTurbineId(1),
      farm_id: LOAD_FARM_ID,
      timestamp: '2026-11-03T12:00:30.003Z',
    });
    expect(envelope.message.publishTime).toBe('2026-11-03T12:00:30.500Z');
  });

  it('never repeats a (turbine, timestamp) or a messageId, across workers too', () => {
    const envelopes = [1, 2].flatMap((workerId) =>
      Array.from({ length: 50 }, (_, seq) => build(seq, workerId)),
    );
    const keys = envelopes.map((envelope) => {
      const { turbine_id, timestamp } = decode(envelope);
      return `${turbine_id}@${timestamp}`;
    });

    expect(new Set(keys).size).toBe(100);
    expect(new Set(envelopes.map((e) => e.message.messageId)).size).toBe(100);
  });

  it('cycles over the fleet, one 5-minute step earlier per pass', () => {
    expect(decode(build(0)).turbine_id).toBe('LOAD00002');
    expect(decode(build(1)).turbine_id).toBe('LOAD00001');
    expect(decode(build(2))).toMatchObject({
      turbine_id: 'LOAD00002',
      timestamp: '2026-11-03T11:55:30.003Z',
    });
  });

  it('starts each worker at a different place in the fleet', () => {
    expect(decode(build(0, 1, 200)).turbine_id).toBe('LOAD00042');
    expect(decode(build(0, 2, 200)).turbine_id).toBe('LOAD00083');
  });
});
