import { Signal, computed, signal } from '@angular/core';
import { PageEvent } from '@angular/material/paginator';

/** One page of `rows` for a `<mat-paginator>`, driven by signals. */
export interface Paging<T> {
  /** The rows on the current page (bind as the table's dataSource). */
  readonly page: Signal<T[]>;
  /** The current page, clamped: a filter or live update that shrinks `rows` never leaves an empty page. */
  readonly pageIndex: Signal<number>;
  readonly pageSize: Signal<number>;
  readonly length: Signal<number>;
  readonly pageSizeOptions: readonly number[];
  /** `(page)` handler of the paginator. */
  onPage(event: PageEvent): void;
  /** Back to the first page (after a filter or sort change). */
  reset(): void;
}

/**
 * Client-side pagination of a signal of rows (already filtered and sorted). Call it in a field
 * initializer: `protected readonly paging = paginate(this.rows, 25);`, then
 *
 * ```html
 * <table mat-table [dataSource]="paging.page()">…</table>
 * <mat-paginator [length]="paging.length()" [pageIndex]="paging.pageIndex()"
 *   [pageSize]="paging.pageSize()" [pageSizeOptions]="paging.pageSizeOptions"
 *   (page)="paging.onPage($event)" />
 * ```
 */
export function paginate<T>(
  rows: Signal<T[]>,
  pageSize: number,
  pageSizeOptions: readonly number[] = [10, 25, 50, 100],
): Paging<T> {
  const requested = signal(0);
  const size = signal(pageSize);
  const length = computed(() => rows().length);
  const pageIndex = computed(() =>
    Math.min(requested(), Math.max(0, Math.ceil(length() / size()) - 1)),
  );
  const page = computed(() => {
    const start = pageIndex() * size();
    return rows().slice(start, start + size());
  });
  return {
    page,
    pageIndex,
    pageSize: size.asReadonly(),
    length,
    pageSizeOptions,
    onPage(event) {
      size.set(event.pageSize);
      requested.set(event.pageIndex);
    },
    reset() {
      requested.set(0);
    },
  };
}
