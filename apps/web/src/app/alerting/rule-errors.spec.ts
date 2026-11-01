import { HttpErrorResponse } from '@angular/common/http';
import { RuleCondition } from './alert-config.model';
import {
  RULE_GONE_MESSAGE,
  duplicateMessage,
  toggleErrorMessage,
  triggeredMessage,
} from './rule-errors';

const input = (overrides: Partial<RuleCondition> = {}): RuleCondition => ({
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

describe('triggeredMessage (409 from DELETE /api/alert-configs/:id)', () => {
  it('offers to disable an enabled rule, and says a disabled one is already off', () => {
    expect(triggeredMessage(true)).toBe(
      'This rule has flagged readings, so it can’t be deleted — they keep their history. ' +
        'Disable it instead to stop it from being evaluated.',
    );
    expect(triggeredMessage(false)).toBe(
      'This rule has flagged readings, so it can’t be deleted — they keep their history. ' +
        'It’s already disabled, so it isn’t evaluated.',
    );
  });
});

describe('toggleErrorMessage', () => {
  const error = (status: number, message?: string) =>
    new HttpErrorResponse({ status, error: message ? { message } : null });

  it('names the rule and the action, and never the API’s id for a 404', () => {
    expect(toggleErrorMessage(error(404, 'Alert config abc not found'), true, input())).toBe(
      `Could not enable “Gearbox temperature above 120 °C”. ${RULE_GONE_MESSAGE}`,
    );
    expect(toggleErrorMessage(error(500, 'Internal server error'), false, input())).toBe(
      'Could not disable “Gearbox temperature above 120 °C”. Internal server error.',
    );
  });
});
