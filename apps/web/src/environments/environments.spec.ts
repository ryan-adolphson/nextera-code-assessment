import { environment as replaced } from './environment';
import { environment as docker } from './environment.docker';
import { environment as development } from './environment.development';

// angular.json swaps environment.ts for one of these files (fileReplacements), so they must stay
// interchangeable. Note: `ng test` builds with the development configuration, so importing
// './environment' here yields environment.development.ts; the production values can't be asserted.
// Production has no URL at build time: it is runtime config (/config.json, core/runtime-config.ts).
describe('environments', () => {
  it('development targets the API on the host (npm run dev:api)', () => {
    expect(development).toEqual({ production: false, apiBaseUrl: 'http://localhost:3000/api' });
  });

  it('docker targets the compose api container (API_PORT 8080)', () => {
    expect(docker).toEqual({ production: false, apiBaseUrl: 'http://localhost:8080/api' });
  });

  it('docker has the same shape as the file it replaces', () => {
    expect(Object.keys(docker).sort()).toEqual(Object.keys(development).sort());
  });

  it('tests run with the development replacement of environment.ts', () => {
    expect(replaced).toEqual(development);
  });
});
