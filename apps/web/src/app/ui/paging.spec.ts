import { signal } from '@angular/core';
import { paginate } from './paging';

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
