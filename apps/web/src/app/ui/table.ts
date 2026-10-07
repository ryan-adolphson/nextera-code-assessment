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

/**
 * What a page needs for a `<table mat-table>` with a `<mat-paginator>` (spread into the
 * component's `imports`). Paging is client-side, from signals: see `paginate()` in `./paging`.
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
] as const;
