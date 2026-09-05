/**
 * The list view used by every module.
 *
 * One component means search, sort, pagination and the empty state behave the
 * same everywhere, which is most of what "consistent UI" actually means in a
 * business application.
 */
import type { ReactNode } from 'react';

export type Column<Row> = {
  key: string;
  header: string;
  sortable?: boolean;
  numeric?: boolean;
  width?: string;
  render: (row: Row) => ReactNode;
};

type DataTableProps<Row> = {
  columns: Array<Column<Row>>;
  rows: Row[];
  rowKey: (row: Row) => string | number;
  onRowClick?: (row: Row) => void;
  loading?: boolean;
  emptyMessage?: string;
  sort?: string;
  onSortChange?: (sort: string) => void;
};

export function DataTable<Row>({
  columns, rows, rowKey, onRowClick, loading, emptyMessage, sort, onSortChange,
}: DataTableProps<Row>) {
  const [sortKey, sortDirection] = (sort ?? '').split(':');

  const toggleSort = (key: string): void => {
    if (onSortChange === undefined) return;
    onSortChange(sortKey === key && sortDirection === 'asc' ? `${key}:desc` : `${key}:asc`);
  };

  if (loading === true) {
    return <div className="loading">Loading…</div>;
  }

  if (rows.length === 0) {
    return <div className="table__empty">{emptyMessage ?? 'Nothing to show yet.'}</div>;
  }

  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                style={column.width === undefined ? undefined : { width: column.width }}
                className={column.numeric === true ? 'table__num' : undefined}
                data-sortable={column.sortable === true && onSortChange !== undefined ? '' : undefined}
                onClick={column.sortable === true ? () => toggleSort(column.key) : undefined}
              >
                {column.header}
                {sortKey === column.key && (sortDirection === 'desc' ? ' ↓' : ' ↑')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              data-clickable={onRowClick === undefined ? undefined : ''}
              onClick={onRowClick === undefined ? undefined : () => onRowClick(row)}
            >
              {columns.map((column) => (
                <td key={column.key} className={column.numeric === true ? 'table__num' : undefined}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type PaginationProps = {
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
};

export function Pagination({ page, totalPages, total, onPageChange }: PaginationProps) {
  if (total === 0) return null;

  return (
    <div className="pagination">
      <span>{total.toLocaleString('en-IN')} record{total === 1 ? '' : 's'}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button className="btn btn--sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          Previous
        </button>
        <span>Page {page} of {totalPages}</span>
        <button
          className="btn btn--sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </button>
      </span>
    </div>
  );
}
