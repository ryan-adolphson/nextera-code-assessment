import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { TestBed } from '@angular/core/testing';
import { MatChipSetHarness } from '@angular/material/chips/testing';
import { Telemetry } from '../fleet/fleet.model';
import { reading } from '../fleet/testing';
import { AlertConfig } from './alert-config.model';
import { AlertChips } from './alert-chips';

const rule = (id: string, overrides: Partial<AlertConfig> = {}): AlertConfig => ({
  id,
  measurementMetric: 'gearboxTempC',
  comparison: 'above',
  valueMetric: 120,
  alertLevel: 'error',
  enabled: true,
  ...overrides,
});

describe('AlertChips', () => {
  async function render(r: Telemetry) {
    const fixture = TestBed.createComponent(AlertChips);
    fixture.componentRef.setInput('reading', r);
    await fixture.whenStable();
    const set = await TestbedHarnessEnvironment.loader(fixture).getHarness(MatChipSetHarness);
    return { el: fixture.nativeElement as HTMLElement, set };
  }

  it('is a list named "Triggered alerts" with one list item per rule (Material makes the set presentational)', async () => {
    const { el, set } = await render(
      reading({
        gearboxTempC: 126.5,
        bladePitchDeg: 44,
        alerts: [
          rule('a'),
          rule('b', { measurementMetric: 'bladePitchDeg', valueMetric: 30, alertLevel: 'warn' }),
        ],
      }),
    );

    const list = el.querySelector('[data-testid=reading-alert-chips]')!;
    expect(list.getAttribute('role')).toBe('list');
    expect(list.getAttribute('aria-label')).toBe('Triggered alerts');

    const chips = await set.getChips();
    expect(await Promise.all(chips.map((c) => c.getText()))).toEqual([
      'Error: Gearbox temperature 126.5 °C > 120',
      'Warning: Blade pitch 44° > 30',
    ]);
    const items = [...el.querySelectorAll('[data-testid=alert-chip]')];
    expect(items.map((c) => [c.getAttribute('role'), c.getAttribute('data-level')])).toEqual([
      ['listitem', 'error'],
      ['listitem', 'warn'],
    ]);
    // Read-only labels: nothing in the list takes focus.
    expect(list.querySelectorAll('[tabindex]:not([tabindex="-1"]), button')).toHaveLength(0);
  });
});
