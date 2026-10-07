import { MatPaginator } from '@angular/material/paginator';
import {
  MatCell,
  MatCellDef,
  MatColumnDef,
  MatHeaderCell,
  MatHeaderCellDef,
  MatHeaderRow,
  MatHeaderRowDef,
  MatNoDataRow,
  MatRow,
  MatRowDef,
  MatTable,
} from '@angular/material/table';
import { PagingDirective } from './paging';
import { TableFrame } from './table-frame';

/**
 * What a page needs for a `<table mat-table>` with a `<mat-paginator>` (`[appPaging]`), optionally in
 * an `<app-table-frame>` (spread into the component's `imports`). Paging is client-side, from signals: see `paginate()` in `./paging`.
 */
export const TABLE_IMPORTS = [
  MatTable,
  MatColumnDef,
  MatHeaderCell,
  MatHeaderCellDef,
  MatHeaderRow,
  MatHeaderRowDef,
  MatCell,
  MatCellDef,
  MatRow,
  MatRowDef,
  MatNoDataRow,
  MatPaginator,
  PagingDirective,
  TableFrame,
] as const;
