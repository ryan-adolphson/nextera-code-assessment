import { Component, signal } from '@angular/core';
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { TestBed } from '@angular/core/testing';
import { MatTooltipHarness } from '@angular/material/tooltip/testing';
import { Telemetry } from '../fleet/fleet.model';
import { reading } from '../fleet/testing';
import { AlertConfig } from './alert-config.model';
import { AlertsCell, AlertsCellFormat } from './alerts-cell';

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
  template: `<app-alerts-cell [reading]="reading()" [format]="format()" />`,
})
class Host {
  readonly reading = signal<Telemetry>(reading());
  readonly format = signal<AlertsCellFormat>('worst');
}

describe('AlertsCell', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<Host>>;
  const render = async (r: Telemetry, format: AlertsCellFormat = 'worst') => {
    fixture = TestBed.createComponent(Host);
    fixture.componentInstance.reading.set(r);
    fixture.componentInstance.format.set(format);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  };
  const trigger = (el: Element) =>
    el.querySelector<HTMLButtonElement>('[data-testid=alerts-cell-trigger]')!;
  const description = (button: Element) =>
    document.getElementById(button.getAttribute('aria-describedby')!)?.textContent;
  /** The `levels` pills: [data-level, text]. */
  const pills = (el: Element) =>
    [...el.querySelectorAll('[data-testid=level-count]')].map((p) => [
      p.getAttribute('data-level'),
      text(p),
    ]);
  /** One reading that triggered an error, two warnings and an info rule (worst first, as stored). */
  const mixed = () =>
    reading({
      gearboxTempC: 126.5,
      powerOutputKw: 40,
      alerts: [
        rule({ id: 'e' }),
        rule({ id: 'w1', valueMetric: 100, alertLevel: 'warn' }),
        rule({ id: 'w2', valueMetric: 90, alertLevel: 'warn' }),
        rule({
          id: 'i',
          measurementMetric: 'powerOutputKw',
          comparison: 'below',
          valueMetric: 50,
          alertLevel: 'info',
        }),
      ],
    });
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

  describe('levels format (turbine page)', () => {
    it('shows one "Level: count" pill per level triggered, worst first, like Alert history', async () => {
      const el = await render(mixed(), 'levels');
      expect(pills(el)).toEqual([
        ['error', 'Error: 1'],
        ['warn', 'Warning: 2'],
        ['info', 'Info: 1'],
      ]);
      // Only the pills: no worst-level badge and no separate total.
      expect(text(trigger(el))).toBe('Error: 1 Warning: 2 Info: 1');
      expect(el.querySelector('[data-testid=alert-level]')).toBeNull();
    });

    it('shows only the levels triggered (a single level)', async () => {
      const el = await render(
        reading({
          gearboxTempC: 126.5,
          alerts: [
            rule({ id: 'w1', valueMetric: 100, alertLevel: 'warn' }),
            rule({ id: 'w2', valueMetric: 90, alertLevel: 'warn' }),
          ],
        }),
        'levels',
      );
      expect(pills(el)).toEqual([['warn', 'Warning: 2']]);
    });

    it('shows a dash for a reading that triggered nothing', async () => {
      const el = await render(reading({ alerts: [] }), 'levels');
      expect(text(el)).toBe('–');
      expect(el.querySelector('[data-testid=alerts-cell-trigger]')).toBeNull();
      expect(pills(el)).toEqual([]);
    });

    it('keeps every rule in the tooltip, on a focusable button that a click opens', async () => {
      const el = await render(mixed(), 'levels');
      const button = trigger(el);
      expect([button.tagName, button.type]).toEqual(['BUTTON', 'button']);
      expect(description(button)).toBe(
        'Error: Gearbox temperature 126.5 °C > 120\n' +
          'Warning: Gearbox temperature 126.5 °C > 100\n' +
          'Warning: Gearbox temperature 126.5 °C > 90\n' +
          'Info: Power output 40 kW < 50',
      );

      const tooltip = await TestbedHarnessEnvironment.loader(fixture).getHarness(MatTooltipHarness);
      expect(await tooltip.isOpen()).toBe(false);
      button.click(); // a tap
      await fixture.whenStable();
      expect(await tooltip.isOpen()).toBe(true);
      expect(await tooltip.getTooltipText()).toContain('Info: Power output 40 kW < 50');
    });
  });
});
