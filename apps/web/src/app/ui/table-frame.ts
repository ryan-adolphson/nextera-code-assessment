import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The frame of a table on a window-high page (route data `fillViewport`): a bordered column as
 * tall as its rows and at most the height left in the window (min 12rem). The projected `<table>`
 * scrolls (both ways) in a focusable, labelled region under its sticky header row; a projected
 * `<mat-paginator>` (or `[table-footer]`) stays below it, always visible.
 *
 * ```html
 * <app-table-frame class="mt-4" label="Turbines" testId="turbines-frame" scrollTestId="turbines-scroll">
 *   <table mat-table …>… <tr mat-header-row *matHeaderRowDef="cols; sticky: true" class="bg-page">
 *   <mat-paginator [appPaging]="paging" aria-label="…" />
 * </app-table-frame>
 * ```
 */
@Component({
  selector: 'app-table-frame',
  host: {
    class:
      'flex min-h-48 flex-col overflow-hidden rounded-lg border border-line [&>[table-footer]]:shrink-0 [&>[table-footer]]:border-t [&>[table-footer]]:border-line [&>mat-paginator]:shrink-0 [&>mat-paginator]:border-t [&>mat-paginator]:border-line',
    '[attr.data-testid]': 'testId()',
  },
  template: `
    <!-- relative: contains the cells' absolutely positioned sr-only text (no page overflow) -->
    <div
      class="relative min-h-0 flex-1 overflow-auto"
      role="region"
      tabindex="0"
      [attr.aria-label]="label()"
      [attr.data-testid]="scrollTestId()"
    >
      <ng-content select="table" />
    </div>
    <ng-content select="mat-paginator, [table-footer]" />
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TableFrame {
  /** Accessible name of the scrolling region, e.g. "Turbines". */
  readonly label = input.required<string>();
  /** `data-testid` of the frame and of its scrolling region. */
  readonly testId = input<string | null>(null);
  readonly scrollTestId = input<string | null>(null);
}
