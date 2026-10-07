import { HttpErrorResponse } from '@angular/common/http';
import { AlertConfigInput, levelLabel, metricOf } from './alert-config.model';

/** A 409 from /api/alert-configs: one rule per metric, condition and level, in words. */
export function duplicateMessage(rule: AlertConfigInput): string {
  const level = levelLabel(rule.alertLevel);
  const article = /^[AEIOU]/.test(level) ? 'An' : 'A';
  const metric = metricOf(rule.measurementMetric).label;
  return (
    `${article} ${level} rule for “${metric} ${rule.comparison}” already exists. ` +
    'Edit that rule, or choose another condition or level.'
  );
}

/** The API's message (a string or class-validator's list), or a generic one. */
export function errorMessage(error: unknown): string {
  if (!(error instanceof HttpErrorResponse)) return 'Something went wrong. Try again.';
  if (error.status === 0) return 'Could not reach the API. Check your connection and try again.';
  const message: unknown = error.error?.message;
  if (Array.isArray(message) && message.length) return message.join('. ') + '.';
  if (typeof message === 'string' && message)
    return message.endsWith('.') ? message : `${message}.`;
  return `The request failed (HTTP ${error.status}).`;
}

/** The HTTP status of a failed request (0 when it never reached the API). */
export function statusOf(error: unknown): number {
  return error instanceof HttpErrorResponse ? error.status : 0;
}
