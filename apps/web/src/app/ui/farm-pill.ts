import { Component, input } from '@angular/core';
import { MatChip } from '@angular/material/chips';

/**
 * A farm's id as a small neutral Material chip (`.farm-pill` in `styles.css`), e.g. FARM01. Read-only:
 * a chip with no actions has no role, tab stop or click handler, so it reads as plain text and a
 * click goes through to the row around it. No `mat-chip-set`: one id is not a list (the set would
 * only add a `role="presentation"` wrapper, or a one-item list). Put it after the farm's name with
 * `&ngsp;` (or text) before it, so the two stay separate words; outside the name's link, not in it.
 */
@Component({
  selector: 'app-farm-pill',
  imports: [MatChip],
  host: { class: 'ml-1' },
  template: `<mat-chip class="farm-pill" disableRipple data-testid="farm-pill">{{
    farmId()
  }}</mat-chip>`,
})
export class FarmPill {
  readonly farmId = input.required<string>();
}
