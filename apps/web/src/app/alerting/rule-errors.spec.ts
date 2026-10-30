import { AlertConfigInput } from './alert-config.model';
import { duplicateMessage } from './rule-errors';

const input = (overrides: Partial<AlertConfigInput> = {}): AlertConfigInput => ({
  measurementMetric: 'gearboxTempC',
  comparison: 'above',
  valueMetric: 120,
  alertLevel: 'error',
  ...overrides,
});

describe('duplicateMessage (409 from /api/alert-configs)', () => {
  it.each([
    ['error', 'An Error rule'],
    ['info', 'An Info rule'],
    ['warn', 'A Warning rule'],
  ] as const)('names a %s rule with the right article', (alertLevel, start) => {
    expect(duplicateMessage(input({ alertLevel }))).toBe(
      `${start} for “Gearbox temperature above” already exists. ` +
        'Edit that rule, or choose another condition or level.',
    );
  });

  it('names the metric and the condition in words', () => {
    expect(
      duplicateMessage(input({ measurementMetric: 'powerOutputKw', comparison: 'below' })),
    ).toContain('“Power output below”');
  });
});
