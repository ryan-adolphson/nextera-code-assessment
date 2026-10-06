// Tests the container's startup check (docker/40-runtime-config.sh) with the system `sh`.
// Run with `npm run test:docker` (part of `npm test`); Node's built-in runner + type stripping.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const script = join(import.meta.dirname, '40-runtime-config.sh');
const dir = mkdtempSync(join(tmpdir(), 'nextera-web-config-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function run(apiBaseUrl: string | undefined) {
  const out = join(dir, `config-${n++}.json`);
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', RUNTIME_CONFIG_FILE: out };
  if (apiBaseUrl !== undefined) env['API_BASE_URL'] = apiBaseUrl;
  const result = spawnSync('sh', [script], { env, encoding: 'utf8' });
  return {
    status: result.status,
    stderr: result.stderr,
    config: existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as unknown) : undefined,
  };
}

describe('40-runtime-config.sh', () => {
  for (const [value, expected] of [
    ['https://api.nextera.energy/api', 'https://api.nextera.energy/api'],
    [
      ' https://nextera-api-abc123-uc.a.run.app/api/ ',
      'https://nextera-api-abc123-uc.a.run.app/api',
    ],
    [
      'https://nextera-api-123456789.us-central1.run.app/api',
      'https://nextera-api-123456789.us-central1.run.app/api',
    ],
    ['https://API.Nextera.Energy:8443/v1/api', 'https://API.Nextera.Energy:8443/v1/api'],
    // docker compose / local runs: http only for loopback hosts
    ['http://localhost:8080/api', 'http://localhost:8080/api'],
    ['http://127.0.0.1:3000/api/', 'http://127.0.0.1:3000/api'],
    ['http://[::1]:8080/api', 'http://[::1]:8080/api'],
  ] as const) {
    it(`accepts ${JSON.stringify(value)}`, () => {
      const { status, stderr, config } = run(value);
      assert.equal(status, 0, stderr);
      assert.deepEqual(config, { apiBaseUrl: expected });
    });
  }

  for (const [value, message] of [
    [undefined, /not set/],
    ['', /not set/],
    ['   ', /not set/],
    ['not a url', /not a valid URL/],
    ['https://', /not a valid URL/],
    ['https://api.nextera.energy:80x/api', /not a valid URL/],
    ['https://api.nextera.energy/a"pi', /not a valid URL/],
    ['https://api.nextera.energy/\\api', /not a valid URL/],
    ['https://api.nextera.energy/api\nhttps://evil.test/api', /not a valid URL/],
    ['http://api.nextera.energy/api', /must use https/],
    ['ftp://api.nextera.energy/api', /must use https/],
    ['https://user:pw@api.nextera.energy/api', /credentials/],
    ['https://api.example.com/api', /placeholder/],
    ['https://api.EXAMPLE.org/api', /placeholder/],
    ['https://example.net/api', /placeholder/],
    ['https://api.nextera.energy', /end with "\/api"/],
    ['https://api.nextera.energy/apix', /end with "\/api"/],
    ['https://api.nextera.energy/api?x=1', /end with "\/api"/],
    ['https://api.nextera.energy/api#x', /end with "\/api"/],
  ] as const) {
    it(`rejects ${JSON.stringify(value)} and writes no config`, () => {
      const { status, stderr, config } = run(value);
      assert.equal(status, 1);
      assert.match(stderr, message);
      assert.equal(config, undefined);
    });
  }
});
