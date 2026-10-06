/**
 * Publishes telemetry readings (telemetry.csv format) to the telemetry topic.
 *   Live-looking data:  npm run ingest:publish -- --count 3 [--turbine TURB002]
 *   An anomaly:         npm run ingest:publish -- --gearbox-temp 126.5
 *   A late reading:     npm run ingest:publish -- --delay-minutes 20
 *   GCP:                PUBSUB_EMULATOR_HOST= GOOGLE_CLOUD_PROJECT=<project> npm run ingest:publish
 * Readings are timestamped at the current 5-minute boundary (stepping back for --count > 1),
 * like real turbines. Re-publishing the same turbine + timestamp is ignored by the worker.
 */
import { parseArgs } from 'node:util';
import { config } from 'dotenv';
import { PubSub } from '@google-cloud/pubsub';

config({ path: ['.env', '../../.env'], quiet: true });

const TURBINE_FARMS: Record<string, string> = { TURB001: 'FARM01', TURB002: 'FARM02' };
const INTERVAL_MS = 5 * 60_000;

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '1' },
    turbine: { type: 'string', default: 'TURB001' },
    'gearbox-temp': { type: 'string' },
    'delay-minutes': { type: 'string' },
    topic: { type: 'string', default: process.env.PUBSUB_TOPIC ?? 'telemetry' },
  },
});

const turbineId = values.turbine;
const farmId = TURBINE_FARMS[turbineId] ?? 'FARM01';
const pubsub = new PubSub({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'nextera-local' });
const topic = pubsub.topic(values.topic);
const round1 = (n: number) => Math.round(n * 10) / 10;
const now = Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS;

for (let i = 0; i < Number(values.count); i++) {
  const measuredAt = new Date(now - i * INTERVAL_MS);
  const wind = 6 + Math.random() * 8; // m/s
  const reading = {
    turbine_id: turbineId,
    farm_id: farmId,
    timestamp: measuredAt.toISOString(),
    ...(values['delay-minutes'] && {
      received_at: new Date(measuredAt.getTime() + Number(values['delay-minutes']) * 60_000).toISOString(),
    }),
    power_output_kw: round1(Math.min(3500, 35 * wind ** 1.8)),
    wind_speed_ms: round1(wind),
    rotor_rpm: round1(9 + wind * 0.6),
    blade_pitch_deg: round1(Math.max(0, 6 - wind * 0.4)),
    gearbox_temp_c: Number(values['gearbox-temp'] ?? round1(74 + wind)),
  };
  const messageId = await topic.publishMessage({ json: reading });
  console.log(`Published ${messageId}:`, reading);
}

await pubsub.close();
