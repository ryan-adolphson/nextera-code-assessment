import { HttpErrorResponse } from '@angular/common/http';
import {
  UnallocatedResolution,
  farmLabel,
  importedText,
  isEntryGone,
  outcomeNotice,
} from './unallocated.model';

const resolution = (overrides: Partial<UnallocatedResolution> = {}): UnallocatedResolution => ({
  action: 'assigned',
  id: 'e1',
  turbine: { id: 'TURB990', farmId: 'FARM01', latitude: 1, longitude: 2, commissioned: false },
  imported: 12,
  duplicates: 0,
  ...overrides,
});
const entry = { turbineId: 'TURB990', reportedFarmId: 'FARM05' };
const names = (id: string) => ({ FARM01: 'Prairie Ridge' })[id] ?? null;
const notFound = (message: unknown) =>
  new HttpErrorResponse({ status: 404, error: message === undefined ? null : { message } });

describe('unallocated model', () => {
  it('labels a farm by name and id, or as unknown', () => {
    expect(farmLabel({ id: 'FARM01', name: 'Prairie Ridge' }, 'FARM01')).toBe(
      'Prairie Ridge (FARM01)',
    );
    expect(farmLabel(null, 'FARM99')).toBe('Unknown farm FARM99');
  });

  it('counts imported readings and duplicates', () => {
    expect(importedText(resolution({ imported: 1 }))).toBe('1 reading imported');
    expect(importedText(resolution({ imported: 3, duplicates: 2 }))).toBe(
      '3 readings imported, 2 already stored',
    );
  });

  it.each([
    [
      { kind: 'resolved', resolution: resolution() },
      'TURB990 assigned to Prairie Ridge (FARM01): 12 readings imported.',
    ],
    [
      { kind: 'resolved', resolution: resolution({ action: 'kept' }) },
      'TURB990 kept in Prairie Ridge (FARM01): 12 readings imported.',
    ],
    [
      {
        kind: 'resolved',
        resolution: resolution({
          action: 'moved',
          turbine: { ...resolution().turbine, farmId: 'FARM07' },
        }),
      },
      'TURB990 moved to FARM07: 12 readings imported.',
    ],
    [{ kind: 'blocked' }, 'Readings for TURB990 from FARM05 are now blocked.'],
    [
      { kind: 'unblocked' },
      'TURB990 from FARM05 unblocked: its next reading will show under Pending.',
    ],
    [{ kind: 'gone' }, 'TURB990 from FARM05 was already resolved elsewhere.'],
  ] as const)('announces %o', (outcome, text) => {
    expect(outcomeNotice(entry, outcome, names)).toBe(text);
  });

  it('treats a 404 as a gone entry, except an unknown farm', () => {
    expect(isEntryGone(notFound('Unallocated turbine e1 not found'))).toBe(true);
    expect(isEntryGone(notFound(undefined))).toBe(true);
    expect(isEntryGone(notFound('Farm FARM09 not found'))).toBe(false);
    expect(isEntryGone(new HttpErrorResponse({ status: 409 }))).toBe(false);
    expect(isEntryGone(new Error('boom'))).toBe(false);
  });
});
