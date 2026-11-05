import { Directive, Signal, computed, effect, inject, input, signal } from '@angular/core';
import { outputToObservable } from '@angular/core/rxjs-interop';
import { MatPaginator, MatPaginatorIntl, PageEvent } from '@angular/material/paginator';

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

// --- Cursor paging (server-side, next/previous only) --------------------------------------------

/** What `cursorPaging` is built from: the server's page and the two moves it allows. */
export interface CursorPagingSource {
  /** 0-based number of the page shown (counted by the client as it moves). */
  pageIndex: Signal<number>;
  pageSize: Signal<number>;
  /** Rows on the page shown. */
  count: Signal<number>;
  /** The total in words ("1,234" or "10,000+"), or null while unknown. */
  totalLabel: Signal<string | null>;
  hasNext: Signal<boolean>;
  hasPrevious: Signal<boolean>;
  next(): void;
  previous(): void;
}

/** One page of a server-paged list for a `<mat-paginator [appCursorPaging]>`: next/previous only. */
export interface CursorPaging {
  readonly pageIndex: Signal<number>;
  readonly pageSize: Signal<number>;
  /**
   * A length that makes Material enable "Next" exactly when the server has another page: the rows
   * through this page, plus one more page if there is one. Only the range label shows a real total.
   */
  readonly length: Signal<number>;
  /** "26 – 50 of 10,000+" (the paginator's range label). */
  readonly rangeLabel: Signal<string>;
  /** `(page)` handler of the paginator: one step forward or back. */
  onPage(event: PageEvent): void;
}

export function cursorPaging(source: CursorPagingSource): CursorPaging {
  const { pageIndex, pageSize, count } = source;
  return {
    pageIndex,
    pageSize,
    length: computed(
      () => pageIndex() * pageSize() + count() + (source.hasNext() ? pageSize() : 0),
    ),
    rangeLabel: computed(() => {
      const start = pageIndex() * pageSize() + 1;
      const total = source.totalLabel();
      if (count() === 0) return total === null ? '' : `0 of ${total}`;
      return `${start} – ${start + count() - 1}${total === null ? '' : ` of ${total}`}`;
    }),
    onPage(event) {
      if (event.pageIndex > event.previousPageIndex!) source.next();
      else if (event.pageIndex < event.previousPageIndex!) source.previous();
    },
  };
}

/** A paginator intl whose range label comes from the directive (the length is not the real total). */
class CursorPaginatorIntl extends MatPaginatorIntl {
  label = '';
  override getRangeLabel = () => this.label;
}

/**
 * Binds a `<mat-paginator>` to a `CursorPaging`: next and previous only (no page size choice, no
 * first/last buttons), with the range label from `rangeLabel`.
 */
@Directive({
  selector: 'mat-paginator[appCursorPaging]',
  providers: [{ provide: MatPaginatorIntl, useClass: CursorPaginatorIntl }],
})
export class CursorPagingDirective {
  readonly appCursorPaging = input.required<CursorPaging>();
  private readonly paginator = inject(MatPaginator);
  private readonly intl = inject(MatPaginatorIntl) as CursorPaginatorIntl;

  constructor() {
    this.paginator.hidePageSize = true;
    this.paginator.showFirstLastButtons = false;
    effect(() => {
      const paging = this.appCursorPaging();
      this.paginator.pageSize = paging.pageSize();
      this.paginator.length = paging.length();
      this.paginator.pageIndex = paging.pageIndex();
      this.intl.label = paging.rangeLabel();
      this.intl.changes.next();
    });
    outputToObservable<PageEvent>(this.paginator.page).subscribe((event) =>
      this.appCursorPaging().onPage(event),
    );
  }
}
