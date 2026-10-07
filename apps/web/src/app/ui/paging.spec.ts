import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatPaginator } from '@angular/material/paginator';
import { PagingDirective, paginate } from './paging';

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
