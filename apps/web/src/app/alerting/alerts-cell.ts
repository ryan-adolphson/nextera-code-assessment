import { Component, computed, input } from '@angular/core';
import { MatTooltip } from '@angular/material/tooltip';
import { Telemetry } from '../fleet/fleet.model';
import { AlertLevelBadge } from './alert-level-badge';
import { describeTriggerWithLevel } from './alert-text';

/**
 * A readings-table cell for the rules a reading triggered: the worst level's pill and the count,
 * with every rule (worst first, with the reading's value) in a Material tooltip that is also the
 * button's accessible description; a click/tap shows it. "–" when the reading triggered nothing.
 * Test hooks: `alerts-cell-trigger` on the button.
 */
@Component({
  selector: 'app-alerts-cell',
  imports: [AlertLevelBadge, MatTooltip],
  template: `
    @if (reading().alerts.length) {
      <button
        #tip="matTooltip"
        type="button"
        class="inline-flex cursor-default items-center gap-1.5 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        data-testid="alerts-cell-trigger"
        matTooltipClass="app-tooltip"
        matTooltipPosition="above"
        [matTooltip]="lines()"
        (click)="tip.show()"
      >
        <app-alert-level-badge [level]="reading().alerts[0].alertLevel" />
        <span class="tabular-nums">{{ reading().alerts.length }}</span>
      </button>
    } @else {
      <span class="text-muted">–</span>
    }
  `,
})
export class AlertsCell {
  readonly reading = input.required<Telemetry>();
  /** One line per triggered rule, e.g. "Error: Gearbox temperature 126.5 °C > 120". */
  protected readonly lines = computed(() => {
    const reading = this.reading();
    return reading.alerts.map((rule) => describeTriggerWithLevel(reading, rule)).join('\n');
  });
}
