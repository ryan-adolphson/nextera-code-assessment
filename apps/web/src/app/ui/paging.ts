import { Directive, Signal, computed, effect, inject, input, signal } from '@angular/core';
import { outputToObservable } from '@angular/core/rxjs-interop';
import { MatPaginator, PageEvent } from '@angular/material/paginator';

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
 * <mat-paginator [appPaging]="paging" aria-label="…" />
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

/**
 * Binds a `<mat-paginator>` to a `Paging`: pushes its length, page index, page size and size
 * options into the paginator, and its `page` events back (`[appPaging]="paging"`). The `page`
 * output is read with `outputToObservable`, which completes when the paginator is destroyed (a
 * `(page)` host listener would be typed as a DOM `Event`).
 */
@Directive({ selector: 'mat-paginator[appPaging]' })
export class PagingDirective {
  readonly appPaging = input.required<Paging<unknown>>();
  private readonly paginator = inject(MatPaginator);

  constructor() {
    effect(() => {
      const paging = this.appPaging();
      const paginator = this.paginator;
      paginator.pageSizeOptions = [...paging.pageSizeOptions];
      paginator.pageSize = paging.pageSize();
      paginator.length = paging.length();
      paginator.pageIndex = paging.pageIndex();
    });
    outputToObservable<PageEvent>(this.paginator.page).subscribe((event) =>
      this.appPaging().onPage(event),
    );
  }
}
