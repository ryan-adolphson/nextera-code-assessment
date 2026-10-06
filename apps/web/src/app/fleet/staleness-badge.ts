import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { STALENESS_LABELS, Staleness } from './staleness';

/**
 * A turbine's reporting state as a small pill: "Reporting" (green dot), "No data in 15/30/60 min"
 * (solid yellow / orange / red with a contrasting text token, WCAG AA in both themes) or "No
 * readings yet" (grey dot). The text always names the state, so colour is never the only cue.
 */
@Component({
  selector: 'app-staleness-badge',
  host: {
    class:
      'inline-flex items-center gap-1.5 rounded-full bg-surface px-2 py-0.5 text-xs font-medium whitespace-nowrap text-ink data-[staleness=stale-15]:bg-caution data-[staleness=stale-15]:text-on-caution data-[staleness=stale-30]:bg-warn data-[staleness=stale-30]:text-on-warn data-[staleness=stale-60]:bg-danger data-[staleness=stale-60]:text-on-danger',
    'data-testid': 'staleness',
    '[attr.data-staleness]': 'staleness()',
  },
  template: `
    @if (staleness() === 'ok' || staleness() === 'empty') {
      <span
        class="size-2 rounded-full"
        [class]="staleness() === 'ok' ? 'bg-ok' : 'bg-muted'"
        aria-hidden="true"
      ></span>
    }
    {{ label() }}
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StalenessBadge {
  readonly staleness = input.required<Staleness>();
  protected readonly label = computed(() => STALENESS_LABELS[this.staleness()]);
}
