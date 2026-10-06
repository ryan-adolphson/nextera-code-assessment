import { openFleet } from '../fleet/testing';

describe('ReportingPage', () => {
  it('says reports are coming soon', async () => {
    const app = await openFleet('/reporting', () => Date.parse('2026-01-03T00:00:00.000Z'));
    expect(app.text(app.root().querySelector('h1'))).toBe('Reporting');
    expect(app.text(app.root().querySelector('[data-testid=reports-coming-soon]'))).toBe(
      'Reports are coming soon.',
    );
  });
});
