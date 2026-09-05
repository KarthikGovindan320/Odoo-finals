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
                aria-sort={
                  column.sortable !== true || sortKey !== column.key
                    ? undefined
                    : sortDirection === 'desc' ? 'descending' : 'ascending'
                }
              >
                {/* A real button, not a click handler on the <th>. The header was
                    previously unreachable by keyboard and announced no sort
                    state, so sorting existed only for mouse users. */}
                {column.sortable === true && onSortChange !== undefined ? (
                  <button type="button" className="table__sort" onClick={() => toggleSort(column.key)}>
                    {column.header}
                    <span aria-hidden="true">
                      {sortKey === column.key ? (sortDirection === 'desc' ? ' ↓' : ' ↑') : ''}
                    </span>
                  </button>
                ) : (
                  column.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              data-clickable={onRowClick === undefined ? undefined : ''}
              // Rows are the only route into every detail page, so they have to
              // be operable from the keyboard as well as the mouse.
              tabIndex={onRowClick === undefined ? undefined : 0}
              role={onRowClick === undefined ? undefined : 'button'}
              onClick={onRowClick === undefined ? undefined : () => onRowClick(row)}
              onKeyDown={
                onRowClick === undefined
                  ? undefined
                  : (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onRowClick(row);
                      }
                    }
              }
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
