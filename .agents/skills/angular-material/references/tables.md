# Tables, sorting and pagination (Material 22.2)

Verified against `material/types/{table,sort,_sort-chunk,_sort-direction-chunk,paginator,_paginator-chunk,table-testing,sort-testing,paginator-testing}.d.ts`, `cdk/types/table.d.ts`, `material/fesm2022/{table,sort,paginator}.mjs` and `cdk/fesm2022/table.mjs`.

## What a page imports

```ts
import { TABLE_IMPORTS } from '../ui/table';
@Component({ imports: [...TABLE_IMPORTS, MatSort, MatSortHeader /* only if sortable */] })
```

`TABLE_IMPORTS` (`src/app/ui/table.ts`) = `MatTable`, `MatColumnDef`, `MatHeaderCell`, `MatHeaderCellDef`, `MatHeaderRow`, `MatHeaderRowDef`, `MatCell`, `MatCellDef`, `MatRow`, `MatRowDef`, `MatNoDataRow`, `MatPaginator`, `PagingDirective`, `TableFrame`. Add `MatFooterRow`/`MatFooterRowDef`/`MatFooterCell(Def)` yourself if you need a footer.

## `mat-table` API

| Directive | Selector | Inputs |
|---|---|---|
| `MatTable` (extends `CdkTable`) | `mat-table`, `table[mat-table]` (export `matTable`) | `dataSource` (array, Observable or `DataSource`), `trackBy`, `multiTemplateDataRows`, `fixedLayout`, `recycleRows`; output `contentChanged` |
| `MatColumnDef` | `[matColumnDef]` | `matColumnDef` (name), `sticky`, `stickyEnd` |
| `MatHeaderRowDef` / `MatFooterRowDef` | `[matHeaderRowDef]` / `[matFooterRowDef]` | columns, `sticky` (`*matHeaderRowDef="cols; sticky: true"`) |
| `MatRowDef` | `[matRowDef]` | `columns`, `when` (predicate for several row templates) |
| `MatNoDataRow` | `ng-template[matNoDataRow]` | shown when no data rows render |
| `MatHeaderCellDef`/`MatCellDef` | `[matHeaderCellDef]`/`[matCellDef]` | structural, `let row` |
| `MatTextColumn` | `mat-text-column` | simple text column (not used) |

Always use the **native-table form** (`<table mat-table>`, `<th mat-header-cell>`, `<td mat-cell>`, `<tr mat-row>`): real table semantics for screen readers, and specs can query `tbody tr` / `td`. The display-based `<mat-table>` element form needs ARIA roles and loses native table semantics.

Repo rules:
- `[dataSource]="paging.page()"` (an array from a signal) and `[trackBy]="trackById"`: rows are reused across live updates, so the `animate-flash` highlight (`data-updated`) only plays on the row that changed.
- Row hooks live on `<tr mat-row>`: `data-testid`, `data-turbine-id`, `data-level`, `data-expanded`. Cells get `data-testid` where specs read them.
- Cells are `px-3` and never wrap (global rule on `.mat-mdc-table .mat-mdc-header-cell, .mat-mdc-cell` in `styles.css`); wide tables scroll inside their wrapper. Right-aligned numbers: `class="text-right! tabular-nums"` on the `td` (`!` because Material sets `text-align`).
- `sr-only` text inside cells is `position: absolute`: the scroll wrapper must be `relative` (it is in `TableFrame`; add it to any other `overflow-x-auto` wrapper) or the text widens the page on phones.
- Sticky header: `*matHeaderRowDef="columns; sticky: true"` (Material makes each `th` `position: sticky`) + `class="bg-page"` on the header row, so rows scrolling under it are hidden by a page-coloured header.
- No `MatTableDataSource`: filtering, sorting and paging are `computed` signals in the component.

### Empty and no-match states

```html
<tr class="mat-mdc-no-data-row" *matNoDataRow>
  <td class="mat-mdc-cell px-3 py-2 text-muted" data-testid="no-matches"
      [attr.colspan]="columnKeys().length">No turbines match the filters.</td>
</tr>
```

Material itself adds `mat-mdc-no-data-row mat-mdc-row mdc-data-table__row` to the no-data row's root and `mat-mdc-cell mdc-data-table__cell mat-no-data-cell` to its cells at runtime; the explicit classes are kept for consistency with existing tables. Use `colspan` = the visible column count. A completely empty dataset (no turbines at all) is usually a separate state outside the table (`no-turbines`).

### Expandable rows (Alert history, Unallocated pending)

```html
<table mat-table multiTemplateDataRows [dataSource]="paging.page()" [trackBy]="trackById">
  …columns…
  <ng-container matColumnDef="detail">
    <td mat-cell *matCellDef="let t" [attr.colspan]="columns.length" [id]="'history-detail-' + t.turbineId">…</td>
  </ng-container>
  <tr mat-header-row *matHeaderRowDef="columns; sticky: true" class="bg-page"></tr>
  <tr mat-row *matRowDef="let t; columns: columns" data-testid="history-turbine"
      [attr.data-expanded]="isExpanded(t.turbineId) ? '' : null" (click)="toggle(t.turbineId)"></tr>
  <tr mat-row *matRowDef="let t; columns: ['detail']" class="history-detail-row"
      data-testid="history-detail" [attr.hidden]="isExpanded(t.turbineId) ? null : ''"></tr>
</table>
```

- `multiTemplateDataRows` renders every matching row def per item (summary + detail).
- `tr.mat-mdc-row.history-detail-row` / `.detail-row` in `styles.css`: `height: auto`, and `[hidden]` → `display: none` (Material gives every row a fixed height and `display`, so the `hidden` attribute alone doesn't hide it).
- The row's `(click)` is a mouse shortcut; the keyboard path is a real `<button>` in the summary row (`history-expand`) with `aria-expanded`, `aria-controls` pointing at the detail cell id, and an `aria-label` "Show|Hide readings for …"; a `chevron-right` icon rotates with `rotate-90`. Links inside the row call `$event.stopPropagation()`.
- `expanded` is a `Set` signal (several open), reset on reload. Heavy detail content can be `@defer (when isExpanded(…))`.

## Sorting (`@angular/material/sort`)

| Directive | Selector | Inputs / outputs |
|---|---|---|
| `MatSort` | `[matSort]` (export `matSort`) | `matSortActive`, `matSortDirection` (`'asc' \| 'desc' \| ''`), `matSortStart` (`'asc' \| 'desc'`), `matSortDisableClear`, `matSortDisabled`; output `matSortChange` (`Sort { active, direction }`) |
| `MatSortHeader` | `[mat-sort-header]` (export `matSortHeader`) | `mat-sort-header` (column id; defaults to the column name), `arrowPosition` (`'before' \| 'after'`), `start`, `disabled`, `disableClear`, `sortActionDescription` (default "Sort"); custom arrow via `[matSortHeaderIcon]` |

Accessibility (from the compiled template): every sortable `th` gets `aria-sort` (`ascending`/`descending`, `none` when not sorted); the header content sits in a `div.mat-sort-header-container` with `role="button"` and `tabindex="0"` (Enter/Space sort); `sortActionDescription` is added as an `aria-describedby` description through `AriaDescriber`.

Repo pattern (Turbines table): MatSort is a **controlled view of a signal**; the comparator stays in the component (turbines without readings last, ties by id, status by `STALENESS_ORDER`):

```html
<table mat-table matSort matSortDisableClear [dataSource]="paging.page()" [trackBy]="trackById"
       [matSortActive]="sort().key" [matSortDirection]="sort().dir" (matSortChange)="onSort($event)">
  <th mat-header-cell *matHeaderCellDef mat-sort-header data-testid="sort-id">Turbine</th>
  <!-- numeric: arrow before, header right-aligned -->
  <th mat-header-cell *matHeaderCellDef mat-sort-header arrowPosition="before"
      class="[&_.mat-sort-header-container]:justify-end">…</th>
```

`matSortDisableClear` keeps the two-state cycle (no unsorted third click). `onSort` sets the signal and calls `paging.reset()`. Token: `--mat-sort-arrow-color`.

## Pagination (`@angular/material/paginator` + `ui/paging.ts`)

`MatPaginator` (`mat-paginator`, export `matPaginator`): inputs `pageIndex`, `length`, `pageSize` (default: the first of `pageSizeOptions`, else 50), `pageSizeOptions`, `hidePageSize`, `showFirstLastButtons`, `selectConfig` (for its internal `MatSelect`), `disabled`; output `page` (`PageEvent { pageIndex, previousPageIndex?, pageSize, length }`). Labels come from `MatPaginatorIntl` (`itemsPerPageLabel` "Items per page:", `nextPageLabel` "Next page", `previousPageLabel` "Previous page", `firstPageLabel`, `lastPageLabel`, `getRangeLabel` → "1 – 25 of 100", `changes` Subject). The page-size picker is a `mat-select` overlay.

Repo: never bind those inputs by hand. Use `paginate()` + `PagingDirective`:

```ts
protected readonly paging = paginate(this.rows, 25);                       // (10/25/50/100)
protected readonly readings = paginate(this.filtered, 50, [25, 50, 100, 250]);
```
```html
<table mat-table [dataSource]="paging.page()">…</table>
<mat-paginator [appPaging]="paging" aria-label="Turbine table pages" data-testid="turbines-paginator" />
```

- `paginate(rows, pageSize, pageSizeOptions?)` returns `page`, `pageIndex` (clamped, so a shrinking list never shows an empty page), `pageSize`, `length`, `pageSizeOptions`, `onPage(event)`, `reset()`. Call `reset()` on a filter, sort or range change.
- `PagingDirective` (`mat-paginator[appPaging]`) pushes length/index/size/options into the paginator in an `effect` and feeds its `page` output back with `outputToObservable` (completes with the paginator).
- Sizes (as in the code): Turbines, Rules, Alert history, Unallocated pending/blocked 25; the turbine page's and Reporting's readings 50 with `[25, 50, 100, 250]`. The farms table on `/farms` is not paginated (every farm is on the map above).
- Every paginator has an `aria-label` naming its table and a `data-testid="<table>-paginator"`.
- Tokens: `--mat-paginator-container-background-color`, `-container-text-color`, `-enabled-icon-color`, `-disabled-icon-color`, `-container-size`, `-form-field-container-height`, `-page-size-select-width`…

## `TableFrame` (window-high pages)

Routes with `data: { fillViewport: true }` make the page a viewport-high flex column; the table goes in `<app-table-frame label="Turbines" testId="turbines-frame" scrollTestId="turbines-scroll">`. The frame is a bordered column (`min-h-48`) whose inner `role="region"`, `tabindex="0"`, `aria-label` = `label` scrolls both ways under the sticky header, with the projected `mat-paginator` (or `[table-footer]`) pinned below. It projects only `table` and `mat-paginator, [table-footer]`. The host component and its parents need `flex min-h-0 flex-1 flex-col` to hand the height down.

## Tokens (all real in 22.2)

`--mat-table-background-color`, `-header-container-height`, `-row-item-container-height`, `-footer-container-height`, `-row-item-outline-color`, `-row-item-outline-width`, `-header-headline-color/-font/-size/-weight/-line-height/-tracking`, `-row-item-label-text-color/-font/-size/-weight/-line-height/-tracking`, `-footer-supporting-text-*`. The repo sets 40px rows, hairline `--border` dividers and text colours. A muted row (disabled rule, `alert-rules-page.html`): `[attr.data-enabled]="isEnabled(rule)"` + `class="data-[enabled=false]:[--mat-table-row-item-label-text-color:var(--muted)]"` on the `tr`: a token override, not a `text-*` utility.

## Harnesses

- `MatTableHarness` (`getRows`, `getHeaderRows`, `getFooterRows`, `getNoDataRow`, `getCellTextByIndex`, `getCellTextByColumnName`), `MatRowHarness`/`MatHeaderRowHarness`/`MatNoDataRowHarness` (`getCells`, `getCellTextByIndex`, `getCellTextByColumnName`), `MatCellHarness` (`getText`, `getColumnName`).
- `MatSortHarness` (`getSortHeaders`, `getActiveHeader`), `MatSortHeaderHarness` (`getLabel`, `getSortDirection`, `isActive`, `isDisabled`, `click`).
- `MatPaginatorHarness` (`goToNextPage`, `goToPreviousPage`, `goToFirstPage`, `goToLastPage`, `isNextPageDisabled`, `isPreviousPageDisabled`, `setPageSize`, `getPageSize`, `getRangeLabel`). Use `.with({ selector: '[data-testid=turbines-paginator]' })` when a page has several. `setPageSize` opens the internal `mat-select` overlay. `largeFleetFixture(n)` (`fleet/testing.ts`) gives enough rows to page.
- The repo's specs mostly read rows with DOM queries (`tr[data-turbine-id=…]`, `td` text) and use harnesses for sort headers and the paginator.

## Pitfalls

- `[hidden]` on a `mat-row` does nothing without the `styles.css` rule (Material sets `display`).
- Tailwind `text-right` on a cell loses to Material's alignment: `text-right!`.
- Don't put `display` utilities on `<table mat-table>` or `<tr mat-row>`.
- Header text for zone-dependent columns comes from `tz.tag()` ("Last reading (UTC)"): never hard-code "(UTC)".
