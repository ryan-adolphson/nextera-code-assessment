// Tests the container's startup check (docker/40-runtime-config.sh) with the system `sh`: the
// /config.json it writes and the API origin it writes for the CSP's connect-src (api-origin.map).
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
  const out = join(dir, `config-${n}.json`);
  const originOut = join(dir, `api-origin-${n++}.map`);
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    RUNTIME_CONFIG_FILE: out,
    RUNTIME_API_ORIGIN_FILE: originOut,
  };
  if (apiBaseUrl !== undefined) env['API_BASE_URL'] = apiBaseUrl;
  const result = spawnSync('sh', [script], { env, encoding: 'utf8' });
  return {
    status: result.status,
    stderr: result.stderr,
    config: existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as unknown) : undefined,
    originMap: existsSync(originOut) ? readFileSync(originOut, 'utf8') : undefined,
  };
}

describe('40-runtime-config.sh', () => {
  for (const [value, expected, origin] of [
    [
      'https://api.nextera.energy/api',
      'https://api.nextera.energy/api',
      'https://api.nextera.energy',
    ],
    [
      ' https://nextera-api-abc123-uc.a.run.app/api/ ',
      'https://nextera-api-abc123-uc.a.run.app/api',
      'https://nextera-api-abc123-uc.a.run.app',
    ],
    [
      'https://nextera-api-123456789.us-central1.run.app/api',
      'https://nextera-api-123456789.us-central1.run.app/api',
      'https://nextera-api-123456789.us-central1.run.app',
    ],
    // custom port kept, host lower-cased (origins compare hosts case-insensitively)
    [
      'https://API.Nextera.Energy:8443/v1/api',
      'https://API.Nextera.Energy:8443/v1/api',
      'https://api.nextera.energy:8443',
    ],
    // an empty port is the default port
    [
      'https://api.nextera.energy:/api',
      'https://api.nextera.energy:/api',
      'https://api.nextera.energy',
    ],
    // docker compose / local runs: http only for loopback hosts
    ['http://localhost:8080/api', 'http://localhost:8080/api', 'http://localhost:8080'],
    ['http://127.0.0.1:3000/api/', 'http://127.0.0.1:3000/api', 'http://127.0.0.1:3000'],
  ] as const) {
    it(`accepts ${JSON.stringify(value)}`, () => {
      const { status, stderr, config, originMap } = run(value);
      assert.equal(status, 0, stderr);
      assert.deepEqual(config, { apiBaseUrl: expected });
      // The nginx map entry default.conf.template includes for the CSP's connect-src.
      assert.equal(originMap, `default "${origin}";\n`);
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
    // a CSP source can't express an IPv6 literal
    ['http://[::1]:8080/api', /IPv6/],
    ['https://[2001:db8::1]/api', /IPv6/],
    // nothing in the host may end the CSP source, add a directive or reach nginx as a variable
    ['https://api.nextera.energy;script-src*/api', /not a valid URL/],
    ['https://api.nextera.energy,evil.test/api', /not a valid URL/],
    ['https://api$host.nextera.energy/api', /not a valid URL/],
    ["https://api.nextera.energy'unsafe-inline'/api", /not a valid URL/],
    ['https://api.nextera.energy%20evil.test/api', /not a valid URL/],
    ['https://*.nextera.energy/api', /not a valid URL/],
    ['https://-api.nextera.energy/api', /not a valid URL/],
    ['https://api..nextera.energy/api', /not a valid URL/],
    ['https://api.nextera.energy:8443;x/api', /not a valid URL/],
  ] as const) {
    it(`rejects ${JSON.stringify(value)} and writes no config`, () => {
      const { status, stderr, config, originMap } = run(value);
      assert.equal(status, 1);
      assert.match(stderr, message);
      assert.equal(config, undefined);
      assert.equal(originMap, undefined);
    });
  }
});
