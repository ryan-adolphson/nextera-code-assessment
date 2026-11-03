import { Component, input } from '@angular/core';
import { MatChip, MatChipSet } from '@angular/material/chips';
import { Telemetry } from '../fleet/fleet.model';
import { describeTriggerWithLevel } from './alert-text';

/**
 * The rules one reading triggered as level-coloured Material chips (`.alert-chip[data-level]`,
 * styled in `styles.css`), e.g. "Error: Gearbox temperature 126.5 °C > 120". Its own file so the
 * History page can `@defer` it: Material chips load only when a row is first expanded (a deferred
 * dependency from a package would make the compiler import the whole package module).
 *
 * A `mat-chip-set` is `role="presentation"` while it has chips and a `mat-chip` has no role, so
 * the set's `aria-label` would name nothing: both roles are set (Material inputs), making it a
 * list "Triggered alerts" with one item per rule.
 */
@Component({
  selector: 'app-alert-chips',
  imports: [MatChip, MatChipSet],
  template: `
    <mat-chip-set role="list" aria-label="Triggered alerts" data-testid="reading-alert-chips">
      @for (alert of reading().alerts; track alert.id) {
        <mat-chip
          class="alert-chip"
          role="listitem"
          disableRipple
          data-testid="alert-chip"
          [attr.data-level]="alert.alertLevel"
          >{{ describe(reading(), alert) }}</mat-chip
        >
      }
    </mat-chip-set>
  `,
})
export class AlertChips {
  readonly reading = input.required<Telemetry>();
  protected readonly describe = describeTriggerWithLevel;
}
