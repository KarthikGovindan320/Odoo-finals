/**
 * Employee master: Kanban and List over the same records, both leading to the
 * same form. The view toggle changes presentation only -- the filters, search and
 * the underlying query are shared, so switching views never changes what you are
 * looking at.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { queryString } from '../lib/api.ts';
import { useResource, type Page } from '../lib/use_resource.ts';
import { useReference } from '../lib/use_reference.ts';
import { useDebounced } from '../lib/use_debounced.ts';
import { formatDate, formatMoney, stateVariant, humanize } from '../lib/format.ts';
import { useAuth } from '../lib/auth.tsx';
import { Badge, Panel, Toolbar } from '../components/Chrome.tsx';
import { DataTable, Pagination, type Column } from '../components/DataTable.tsx';
import { EmployeeFormModal } from './EmployeeFormModal.tsx';

export type EmployeeRow = {
  id: number;
  employee_number: string;
  first_name: string;
  last_name: string;
  work_email: string;
  work_phone: string | null;
  status: string;
  hire_date: string;
  department_name: string | null;
  job_title: string | null;
  employment_type_name: string | null;
  manager_name: string | null;
  schedule_name: string | null;
  current_wage: number | null;
};

type Reference = {
  departments: Array<{ id: number; name: string }>;
  employment_types: Array<{ id: number; name: string }>;
};

export function EmployeesPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [view, setView] = useState<'list' | 'kanban'>('list');
  // Kanban groups whatever the request returned, so its page size is the board's
  // capacity. It is paginated like the list rather than silently truncated.
  const pageSize = 60;
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [employmentTypeId, setEmploymentTypeId] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('employee_number:asc');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);

  const reference = useReference();
  // The typed value drives the input; the settled value drives the request.
  const settledSearch = useDebounced(search);
  const path = `/employees${queryString({
    q: settledSearch, department_id: departmentId, employment_type_id: employmentTypeId,
    status, sort, page, page_size: pageSize,
  })}`;
  const { data, loading, error, reload } = useResource<Page<EmployeeRow>>(path);

  const columns: Array<Column<EmployeeRow>> = [
    { key: 'employee_number', header: 'Number', sortable: true, width: '110px',
      render: (row) => <span className="mono">{row.employee_number}</span> },
    { key: 'name', header: 'Employee', sortable: true,
      render: (row) => (
        <div>
          <div style={{ fontWeight: 600 }}>{row.first_name} {row.last_name}</div>
          <div className="muted" style={{ fontSize: 12 }}>{row.work_email}</div>
        </div>
      ) },
    { key: 'department', header: 'Department', sortable: true,
      render: (row) => row.department_name ?? '—' },
    { key: 'job_title', header: 'Position', render: (row) => row.job_title ?? '—' },
    { key: 'employment_type', header: 'Type',
      render: (row) => row.employment_type_name ?? '—' },
    { key: 'manager', header: 'Manager', render: (row) => row.manager_name ?? '—' },
    { key: 'schedule', header: 'Schedule', render: (row) => row.schedule_name ?? '—' },
    { key: 'wage', header: 'Current wage', numeric: true,
      render: (row) => row.current_wage === null
        ? <span className="muted">No contract</span>
        : formatMoney(row.current_wage) },
    { key: 'hire_date', header: 'Hired', sortable: true,
      render: (row) => formatDate(row.hire_date) },
    { key: 'status', header: 'Status',
      render: (row) => <Badge variant={stateVariant(row.status)}>{humanize(row.status)}</Badge> },
  ];

  const resetPageThen = <Value,>(setter: (value: Value) => void) => (value: Value): void => {
    setPage(1);
    setter(value);
  };

  return (
    <>
      <div className="page__header">
        <div className="page__title">
          <h1>Employees</h1>
          <span className="page__subtitle">
            The central record. Contracts, attendance, time off and payslips all hang off it.
          </span>
        </div>
        <div className="page__actions">
          <div className="segmented">
            <button className={`btn btn--sm${view === 'list' ? ' btn--selected' : ''}`}
              onClick={() => setView('list')}>List</button>
            <button className={`btn btn--sm${view === 'kanban' ? ' btn--selected' : ''}`}
              onClick={() => setView('kanban')}>Kanban</button>
          </div>
          {can('employee:write') && (
            <button className="btn btn--primary" onClick={() => setCreating(true)}>New employee</button>
          )}
        </div>
      </div>

      {error !== null && <div className="error-box">{error}</div>}

      <Panel flush>
        <Toolbar
          search={search}
          onSearchChange={resetPageThen(setSearch)}
          searchPlaceholder="Search name, number or email…"
          right={<span className="toolbar__count">{data?.total ?? 0} employees</span>}
        >
          <select className="select" style={{ width: 'auto' }} value={departmentId}
            onChange={(event) => resetPageThen(setDepartmentId)(event.target.value)}
            aria-label="Filter by department">
            <option value="">All departments</option>
            {reference.data?.departments.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
          <select className="select" style={{ width: 'auto' }} value={employmentTypeId}
            onChange={(event) => resetPageThen(setEmploymentTypeId)(event.target.value)}
            aria-label="Filter by employee type">
            <option value="">All types</option>
            {reference.data?.employment_types.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
          <select className="select" style={{ width: 'auto' }} value={status}
            onChange={(event) => resetPageThen(setStatus)(event.target.value)}
            aria-label="Filter by status">
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="on_leave">On leave</option>
            <option value="terminated">Terminated</option>
          </select>
        </Toolbar>

        {view === 'list' ? (
          <>
            <DataTable
              columns={columns}
              rows={data?.rows ?? []}
              rowKey={(row) => row.id}
              onRowClick={(row) => navigate(`/employees/${row.id}`)}
              loading={loading}
              sort={sort}
              onSortChange={setSort}
              emptyMessage="No employees match these filters."
            />
            <Pagination
              page={data?.page ?? 1}
              totalPages={data?.total_pages ?? 1}
              total={data?.total ?? 0}
              onPageChange={setPage}
            />
          </>
        ) : (
          <>
            <div style={{ padding: 'var(--space-3)' }}>
              <KanbanByDepartment
                rows={data?.rows ?? []}
                loading={loading}
                onOpen={(id) => navigate(`/employees/${id}`)}
              />
            </div>
            {/* The board previously showed page one and offered no way to reach
                the rest, so past 60 employees whole departments were missing
                with nothing to say so. */}
            <Pagination
              page={data?.page ?? 1}
              totalPages={data?.total_pages ?? 1}
              total={data?.total ?? 0}
              onPageChange={setPage}
            />
          </>
        )}
      </Panel>

      {creating && (
        <EmployeeFormModal
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); reload(); }}
        />
      )}
    </>
  );
}

/** Kanban columns are departments -- the grouping HR actually thinks in. */
function KanbanByDepartment({
  rows, loading, onOpen,
}: {
  rows: EmployeeRow[];
  loading: boolean;
  onOpen: (id: number) => void;
}) {
  if (loading) return <div className="loading">Loading…</div>;
  if (rows.length === 0) return <div className="table__empty">No employees match these filters.</div>;

  const groups = new Map<string, EmployeeRow[]>();
  for (const row of rows) {
    const key = row.department_name ?? 'Unassigned';
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return (
    <div className="kanban">
      {[...groups.entries()].map(([department, members]) => (
        <div className="kanban__column" key={department}>
          <div className="kanban__column-header">
            <span>{department}</span>
            <span className="kanban__count">{members.length}</span>
          </div>
          <div className="kanban__cards">
            {members.map((row) => (
              <div className="kanban-card" key={row.id} onClick={() => onOpen(row.id)}>
                <div className="kanban-card__name">{row.first_name} {row.last_name}</div>
                <div className="kanban-card__meta">
                  {row.job_title ?? 'No position'}<br />
                  <span className="mono">{row.employee_number}</span>
                  {row.current_wage !== null && ` · ${formatMoney(row.current_wage)}`}
                </div>
                <div style={{ marginTop: 6 }}>
                  <Badge variant={stateVariant(row.status)}>{humanize(row.status)}</Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
