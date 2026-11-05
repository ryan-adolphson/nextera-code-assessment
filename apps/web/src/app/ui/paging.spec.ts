import { Component, computed, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatPaginator } from '@angular/material/paginator';
import { MatPaginatorHarness } from '@angular/material/paginator/testing';
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import {
  CursorPaging,
  CursorPagingDirective,
  CursorPagingSource,
  PagingDirective,
  cursorPaging,
  paginate,
} from './paging';

describe('paginate', () => {
  const numbers = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it('slices the rows into pages', () => {
    const rows = signal(numbers(12));
    const paging = paginate(rows, 5);
    expect([paging.page(), paging.pageIndex(), paging.length()]).toEqual([[1, 2, 3, 4, 5], 0, 12]);

    paging.onPage({ pageIndex: 2, pageSize: 5, length: 12 });
    expect(paging.page()).toEqual([11, 12]);

    // Another page size: Material recomputes the index so the first row stays in view.
    paging.onPage({ pageIndex: 1, pageSize: 10, length: 12, previousPageIndex: 2 });
    expect([paging.pageSize(), paging.page()]).toEqual([10, [11, 12]]);
  });

  it('clamps to the last page when the rows shrink, and back when they grow', () => {
    const rows = signal(numbers(12));
    const paging = paginate(rows, 5);
    paging.onPage({ pageIndex: 2, pageSize: 5, length: 12 });

    rows.set(numbers(7)); // a filter leaves two pages
    expect([paging.pageIndex(), paging.page()]).toEqual([1, [6, 7]]);
    rows.set([]);
    expect([paging.pageIndex(), paging.page()]).toEqual([0, []]);
    rows.set(numbers(12)); // the requested page is remembered
    expect([paging.pageIndex(), paging.page()]).toEqual([2, [11, 12]]);

    paging.reset();
    expect([paging.pageIndex(), paging.page()]).toEqual([0, [1, 2, 3, 4, 5]]);
  });

  it('offers the default page sizes unless given', () => {
    expect(paginate(signal([]), 25).pageSizeOptions).toEqual([10, 25, 50, 100]);
    expect(paginate(signal([]), 50, [50, 100]).pageSizeOptions).toEqual([50, 100]);
  });
});

@Component({
  imports: [MatPaginator, PagingDirective],
  template: `<mat-paginator [appPaging]="paging" aria-label="Pages" />`,
})
class PagingHost {
  readonly rows = signal(Array.from({ length: 12 }, (_, i) => i + 1));
  readonly paging = paginate(this.rows, 5, [5, 10]);
  readonly paginator = viewChild.required(MatPaginator);
}

describe('PagingDirective', () => {
  it('pushes the paging state into the paginator and its page events back', async () => {
    const fixture = TestBed.createComponent(PagingHost);
    await fixture.whenStable();
    const { paginator, paging, rows } = fixture.componentInstance;
    const state = () => [
      paginator().length,
      paginator().pageIndex,
      paginator().pageSize,
      paginator().pageSizeOptions,
    ];
    expect(state()).toEqual([12, 0, 5, [5, 10]]);

    paginator().nextPage(); // a user click: emits `page`
    await fixture.whenStable();
    expect(paging.pageIndex()).toBe(1);
    expect(paging.page()).toEqual([6, 7, 8, 9, 10]);

    rows.set([1, 2, 3]); // the rows shrink: the clamped index flows back to the paginator
    await fixture.whenStable();
    expect(state()).toEqual([3, 0, 5, [5, 10]]);
  });

  it('stops listening to the paginator when it is destroyed', async () => {
    const fixture = TestBed.createComponent(PagingHost);
    await fixture.whenStable();
    const paginator = fixture.componentInstance.paginator();
    const onPage = vi.spyOn(fixture.componentInstance.paging, 'onPage');

    paginator.page.emit({ pageIndex: 1, pageSize: 5, length: 12 });
    expect(onPage).toHaveBeenCalledOnce();

    fixture.destroy();
    paginator.page.emit({ pageIndex: 2, pageSize: 5, length: 12 });
    expect(onPage).toHaveBeenCalledOnce(); // not again
    expect(paginator.page.observed).toBe(false);
  });
});

describe('cursorPaging', () => {
  /** A server-paged list of `total` rows, 10 per page, moved by next/previous only. */
  function source(total: number, label: string | null = String(total)) {
    const pageIndex = signal(0);
    const pageSize = signal(10);
    const count = computed(() => Math.min(10, Math.max(0, total - pageIndex() * 10)));
    const next = vi.fn(() => pageIndex.update((i) => i + 1));
    const previous = vi.fn(() => pageIndex.update((i) => i - 1));
    const src: CursorPagingSource = {
      pageIndex,
      pageSize,
      count,
      totalLabel: signal(label),
      hasNext: computed(() => (pageIndex() + 1) * 10 < total),
      hasPrevious: computed(() => pageIndex() > 0),
      next,
      previous,
    };
    return { src, pageIndex, next, previous, paging: cursorPaging(src) };
  }

  it('labels the range with the total in words', () => {
    const { paging, pageIndex } = source(25, '25');
    expect(paging.rangeLabel()).toBe('1 – 10 of 25');
    pageIndex.set(2);
    expect(paging.rangeLabel()).toBe('21 – 25 of 25');
  });

  it('labels a capped total as given', () => {
    expect(source(10_001, '10,000+').paging.rangeLabel()).toBe('1 – 10 of 10,000+');
  });

  it('leaves the total out while it is unknown', () => {
    expect(source(25, null).paging.rangeLabel()).toBe('1 – 10');
  });

  it('says "0 of N" for an empty page, and nothing before the first answer', () => {
    expect(source(0, '0').paging.rangeLabel()).toBe('0 of 0');
    expect(source(0, null).paging.rangeLabel()).toBe('');
  });

  it('makes the length enable Next exactly when the server has another page', () => {
    const { paging, pageIndex } = source(25);
    // Rows through this page, plus one more page: Material sees a page after this one.
    expect(paging.length()).toBe(20);
    pageIndex.set(1);
    expect(paging.length()).toBe(30);
    pageIndex.set(2); // the last page: 5 rows, nothing beyond
    expect(paging.length()).toBe(25);
  });

  it("exposes the source's page index and size", () => {
    const { paging, src } = source(25);
    expect([paging.pageIndex(), paging.pageSize()]).toEqual([0, 10]);
    expect(paging.pageIndex).toBe(src.pageIndex);
  });

  it('turns a page event into one step forward or back', () => {
    const { paging, next, previous } = source(25);

    paging.onPage({ pageIndex: 1, previousPageIndex: 0, pageSize: 10, length: 20 });
    expect([next.mock.calls.length, previous.mock.calls.length]).toEqual([1, 0]);

    paging.onPage({ pageIndex: 0, previousPageIndex: 1, pageSize: 10, length: 20 });
    expect([next.mock.calls.length, previous.mock.calls.length]).toEqual([1, 1]);

    paging.onPage({ pageIndex: 1, previousPageIndex: 1, pageSize: 10, length: 20 }); // no move
    expect([next.mock.calls.length, previous.mock.calls.length]).toEqual([1, 1]);
  });
});

@Component({
  imports: [MatPaginator, CursorPagingDirective],
  template: `<mat-paginator [appCursorPaging]="paging" aria-label="Pages" />`,
})
class CursorHost {
  readonly total = signal(25);
  readonly pageIndex = signal(0);
  readonly steps: string[] = [];
  readonly paging: CursorPaging = cursorPaging({
    pageIndex: this.pageIndex,
    pageSize: signal(10),
    count: computed(() => Math.min(10, this.total() - this.pageIndex() * 10)),
    totalLabel: computed(() => String(this.total())),
    hasNext: computed(() => (this.pageIndex() + 1) * 10 < this.total()),
    hasPrevious: computed(() => this.pageIndex() > 0),
    next: () => {
      this.steps.push('next');
      this.pageIndex.update((i) => i + 1);
    },
    previous: () => {
      this.steps.push('previous');
      this.pageIndex.update((i) => i - 1);
    },
  });
}

describe('CursorPagingDirective', () => {
  async function open() {
    const fixture = TestBed.createComponent(CursorHost);
    await fixture.whenStable();
    const pages = await TestbedHarnessEnvironment.loader(fixture).getHarness(MatPaginatorHarness);
    return { fixture, pages, host: fixture.componentInstance };
  }

  it('shows the range label from the paging, with next and previous only', async () => {
    const { fixture, pages } = await open();
    const el: HTMLElement = fixture.nativeElement;

    expect(await pages.getRangeLabel()).toBe('1 – 10 of 25');
    expect(el.querySelector('.mat-mdc-paginator-page-size')).toBeNull(); // no page size choice
    expect(el.querySelector('.mat-mdc-paginator-navigation-first')).toBeNull();
    expect(el.querySelector('.mat-mdc-paginator-navigation-last')).toBeNull();
    expect(await pages.isPreviousPageDisabled()).toBe(true);
    expect(await pages.isNextPageDisabled()).toBe(false);
  });

  it('steps forward and back through the paging, updating the label', async () => {
    const { pages, host } = await open();

    await pages.goToNextPage();
    expect(host.steps).toEqual(['next']);
    expect(await pages.getRangeLabel()).toBe('11 – 20 of 25');
    expect(await pages.isPreviousPageDisabled()).toBe(false);

    await pages.goToNextPage();
    expect(await pages.getRangeLabel()).toBe('21 – 25 of 25');
    expect(await pages.isNextPageDisabled()).toBe(true);

    await pages.goToPreviousPage();
    expect(host.steps).toEqual(['next', 'next', 'previous']);
    expect(await pages.getRangeLabel()).toBe('11 – 20 of 25');
  });

  it('follows the total when it changes', async () => {
    const { pages, host } = await open();

    host.total.set(8);

    expect(await pages.getRangeLabel()).toBe('1 – 8 of 8');
    expect(await pages.isNextPageDisabled()).toBe(true);
  });
});
