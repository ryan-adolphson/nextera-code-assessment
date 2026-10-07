import { Component, computed, input } from '@angular/core';
import { MatTooltip } from '@angular/material/tooltip';
import { Telemetry } from '../fleet/fleet.model';
import { AlertLevelBadge } from './alert-level-badge';
import { countByLevel, describeTriggerWithLevel } from './alert-text';

/** How the cell sums up a reading's alerts. */
export type AlertsCellFormat =
  /** The worst level's pill and the total count, "Error 2" (Reporting). */
  | 'worst'
  /** One "Level: count" pill per level triggered, worst first, like /alerting/history (turbine page). */
  | 'levels';

/**
 * A readings-table cell for the rules a reading triggered, summed up as `format` says, with every
 * rule (worst first, with the reading's value) in a Material tooltip that is also the button's
 * accessible description; a click/tap shows it. "–" when the reading triggered nothing.
 * Test hooks: `alerts-cell-trigger` on the button; `alert-level` (worst) or `level-count`
 * (levels) on the pills.
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
        @if (format() === 'levels') {
          @for (l of levelCounts(); track l.level) {
            <app-alert-level-badge testId="level-count" [level]="l.level" [count]="l.count" />
          }
        } @else {
          <app-alert-level-badge [level]="reading().alerts[0].alertLevel" />
          <span class="tabular-nums">{{ reading().alerts.length }}</span>
        }
      </button>
    } @else {
      <span class="text-muted">–</span>
    }
  `,
})
export class AlertsCell {
  readonly reading = input.required<Telemetry>();
  readonly format = input<AlertsCellFormat>('worst');
  /** The levels triggered with their counts, worst first (the `levels` format). */
  protected readonly levelCounts = computed(() => countByLevel(this.reading().alerts));
  /** One line per triggered rule, e.g. "Error: Gearbox temperature 126.5 °C > 120". */
  protected readonly lines = computed(() => {
    const reading = this.reading();
    return reading.alerts.map((rule) => describeTriggerWithLevel(reading, rule)).join('\n');
  });
}
