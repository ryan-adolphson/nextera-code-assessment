// Artillery processor: sign-in for load/reads.yml, the Pub/Sub push message for load/ingest.yml.
// Plain ESM with no dependencies: every Artillery worker thread loads it.
import { randomUUID } from 'node:crypto';
import { threadId } from 'node:worker_threads';

export const LOAD_FARM_ID = 'LOAD01';
const STEP_MS = 5 * 60 * 1000;
/** Spaces out where each worker starts in the fleet, or they would all reuse its first turbines. */
const WORKER_STRIDE = 41;

export const loadTurbineId = (index) =>
  `LOAD${String(index + 1).padStart(5, '0')}`;

/** LOAD_FLEET_SIZE, default 200. Must match what `load:setup` created. */
export function fleetSize(env = process.env) {
  const size = Number(env.LOAD_FLEET_SIZE ?? 200);
  if (!Number.isInteger(size) || size < 1 || size > 1_000_000) {
    throw new Error('LOAD_FLEET_SIZE must be an integer from 1 to 1000000');
  }
  return size;
}

/**
 * The worker's starting timestamp: this second, with the worker's id in the milliseconds. Steps
 * are whole minutes, so two workers can never produce the same timestamp.
 */
export const workerAnchorMs = (nowMs, workerId) =>
  Math.floor(nowMs / 1000) * 1000 + (workerId % 1000);

/**
 * The seq-th Pub/Sub push envelope of a worker. Round robin over the fleet; each pass over it is
 * one 5-minute step earlier, so (turbine, timestamp) never repeats and every message stores a row.
 * The field names are the telemetry.csv ones (IngestTelemetryDto).
 */
export function buildEnvelope({ seq, workerId, anchorMs, fleet, nowMs }) {
  const reading = {
    turbine_id: loadTurbineId((seq + workerId * WORKER_STRIDE) % fleet),
    farm_id: LOAD_FARM_ID,
    timestamp: new Date(
      anchorMs - Math.floor(seq / fleet) * STEP_MS,
    ).toISOString(),
    power_output_kw: 1500 + (seq % 500),
    wind_speed_ms: 9 + (seq % 5),
    rotor_rpm: 12 + (seq % 3),
    blade_pitch_deg: 2 + (seq % 4),
    gearbox_temp_c: 60 + (seq % 10),
  };
  return {
    message: {
      data: Buffer.from(JSON.stringify(reading)).toString('base64'),
      messageId: `load-${workerId}-${seq}-${randomUUID()}`,
      publishTime: new Date(nowMs).toISOString(),
    },
    subscription: 'projects/load-test/subscriptions/telemetry-ingestion',
  };
}

const workerId = threadId;
const anchorMs = workerAnchorMs(Date.now(), workerId);
let seq = 0;

/** Artillery beforeRequest hook of load/ingest.yml. */
export function addTelemetryMessage(requestParams, _context, _events, next) {
  requestParams.json = buildEnvelope({
    seq: seq++,
    workerId,
    anchorMs,
    fleet: fleetSize(),
    nowMs: Date.now(),
  });
  next();
}

/**
 * Artillery `before` hook of load/reads.yml: runs once, and its variables are shared with every
 * virtual user. The password comes from the environment and is never logged.
 */
export async function signIn(context) {
  const { LOAD_API_URL, SEED_USER_PASSWORD } = process.env;
  if (!LOAD_API_URL || !SEED_USER_PASSWORD) {
    throw new Error('Set LOAD_API_URL and SEED_USER_PASSWORD');
  }
  const response = await fetch(`${LOAD_API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: process.env.LOAD_USER_EMAIL ?? 'viewer@nextera.local',
      password: SEED_USER_PASSWORD,
    }),
  });
  if (!response.ok) throw new Error(`Sign-in failed: ${response.status}`);
  context.vars.token = (await response.json()).accessToken;
}
