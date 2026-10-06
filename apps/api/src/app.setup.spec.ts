import { corsOrigins } from './app.setup.js';

describe('corsOrigins', () => {
  it('splits, trims and drops empty entries', () => {
    expect(
      corsOrigins(
        ' https://app.example.com, https://nextera-web-123.us-central1.run.app ,,',
      ),
    ).toEqual([
      'https://app.example.com',
      'https://nextera-web-123.us-central1.run.app',
    ]);
  });

  it('allows no origins when unset', () => {
    expect(corsOrigins('')).toEqual([]);
  });
});
