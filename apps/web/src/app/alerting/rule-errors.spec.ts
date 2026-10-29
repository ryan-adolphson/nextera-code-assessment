import { HttpErrorResponse } from '@angular/common/http';
import { AlertConfigInput } from './alert-config.model';
import { duplicateMessage, errorMessage, statusOf } from './rule-errors';

const input = (overrides: Partial<AlertConfigInput> = {}): AlertConfigInput => ({
  measurementMetric: 'gearboxTempC',
  comparison: 'above',
  valueMetric: 120,
  alertLevel: 'error',
  ...overrides,
});

const httpError = (status: number, error: unknown = null) =>
  new HttpErrorResponse({
    status,
    error,
    statusText: 'x',
    url: 'http://api.test/api/alert-configs',
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

describe('errorMessage', () => {
  it.each([
    ['a non-HTTP error', new Error('boom'), 'Something went wrong. Try again.'],
    [
      'a request that never reached the API (status 0)',
      new HttpErrorResponse({ status: 0, error: new ProgressEvent('error') }),
      'Could not reach the API. Check your connection and try again.',
    ],
    [
      "class-validator's list of messages",
      httpError(400, { message: ['valueMetric must be a number', 'alertLevel is invalid'] }),
      'valueMetric must be a number. alertLevel is invalid.',
    ],
    [
      'a message without a full stop',
      httpError(500, { message: 'Internal server error' }),
      'Internal server error.',
    ],
    [
      'a message that already ends in a full stop',
      httpError(409, { message: 'Disable the rule instead.' }),
      'Disable the rule instead.',
    ],
    ['an empty message', httpError(502, { message: '' }), 'The request failed (HTTP 502).'],
    [
      'an empty list of messages',
      httpError(400, { message: [] }),
      'The request failed (HTTP 400).',
    ],
    [
      'a body without a message',
      httpError(503, 'Service Unavailable'),
      'The request failed (HTTP 503).',
    ],
    ['no body at all', httpError(500), 'The request failed (HTTP 500).'],
  ])('explains %s', (_, error, expected) => {
    expect(errorMessage(error)).toBe(expected);
  });
});

describe('statusOf', () => {
  it('is the HTTP status of a failed request', () => {
    expect(statusOf(httpError(409))).toBe(409);
  });

  it('is 0 for anything that is not an HTTP error (it never reached the API)', () => {
    expect(statusOf(new Error('boom'))).toBe(0);
    expect(statusOf(undefined)).toBe(0);
  });
});
