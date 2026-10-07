import { Component, input } from '@angular/core';

/** A labelled headline number (fleet output, turbines reporting…). Project the value as content. */
@Component({
  selector: 'app-stat-tile',
  template: `
    <div class="grid h-full gap-1 rounded-lg border border-line p-4">
      <span class="text-xs text-muted">{{ label() }}</span>
      <span
        class="font-semibold"
        [class]="small() ? 'text-base' : 'text-2xl'"
        [attr.data-testid]="testId()"
      >
        <ng-content />
      </span>
    </div>
  `,
})
export class StatTile {
  readonly label = input.required<string>();
  readonly testId = input<string | null>(null);
  /** Smaller value text, for long values such as dates. */
  readonly small = input(false);
}
