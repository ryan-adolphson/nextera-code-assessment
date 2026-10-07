import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Telemetry } from '../fleet/fleet.model';
import { reading } from '../fleet/testing';
import { AlertConfig } from './alert-config.model';
import { AlertsCell } from './alerts-cell';

const rule = (overrides: Partial<AlertConfig>): AlertConfig => ({
  id: 'r',
  measurementMetric: 'gearboxTempC',
  comparison: 'above',
  valueMetric: 120,
  alertLevel: 'error',
  enabled: true,
  ...overrides,
});

@Component({
  imports: [AlertsCell],
  template: `<app-alerts-cell [reading]="reading()" />`,
})
class Host {
  readonly reading = signal<Telemetry>(reading());
}

describe('AlertsCell', () => {
  const render = async (r: Telemetry) => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.reading.set(r);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  };
  const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim();

  it('shows the worst level and the count, with every rule and value in the tooltip', async () => {
    const el = await render(
      reading({
        gearboxTempC: 126.5,
        alerts: [rule({ id: 'e' }), rule({ id: 'w', valueMetric: 90, alertLevel: 'warn' })],
      }),
    );
    const trigger = el.querySelector<HTMLButtonElement>('[data-testid=alerts-cell-trigger]')!;
    expect([trigger.tagName, trigger.type]).toEqual(['BUTTON', 'button']);
    expect(text(trigger)).toBe('Error 2');
    expect(trigger.querySelector('[data-testid=alert-level]')!.getAttribute('data-level')).toBe(
      'error',
    );
    // The tooltip is also the button's accessible description (Material's AriaDescriber).
    expect(document.getElementById(trigger.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Error: Gearbox temperature 126.5 °C > 120\nWarning: Gearbox temperature 126.5 °C > 90',
    );
  });

  it('shows a dash for a reading that triggered nothing', async () => {
    const el = await render(reading({ alerts: [] }));
    expect(text(el)).toBe('–');
    expect(el.querySelector('[data-testid=alerts-cell-trigger]')).toBeNull();
  });
});
