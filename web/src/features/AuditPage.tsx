/**
 * The audit trail.
 *
 * The rows have been written since the schema existed and there has never been
 * anywhere to read them: one generic trigger on eight tables, the actor threaded
 * through every transaction, fifty thousand rows, and no screen. That is worth
 * nothing until somebody can answer "who moved this person's bank details"
 * without opening psql.
 *
 * Laid out as a stream rather than a table because the interesting part of each
 * entry is a variable number of field changes, and a table cell containing four
 * lines of before-and-after is a table fighting its own shape.
 */
import { useState } from 'react';
import { Link } from 'react-router';

import { queryString } from '../lib/api.ts';
import { useResource, type Page } from '../lib/use_resource.ts';
import { useUrlState } from '../lib/use_url_state.ts';
import { formatDateTime, humanize } from '../lib/format.ts';
import { Badge, Panel, Toolbar } from '../components/Chrome.tsx';
import { Pagination } from '../components/DataTable.tsx';
import { ExportButtons } from '../components/ExportButtons.tsx';

type Change = { field: string; from: string | null; to: string | null };

type AuditEntry = {
  id: number;
  table_name: string;
  record_id: number;
  action: string;
  changed_at: string;
  actor_email: string | null;
  actor_name: string | null;
  actor_role: string | null;
  subject: string;
  subject_employee_id: number | null;
  changes: Change[];
};

type Actor = { id: number; email: string; role_name: string | null; changes: number };

/** The tables the triggers cover, in the words the interface uses elsewhere. */
const TABLES: { value: string; label: string }[] = [
  { value: 'employees', label: 'Employees' },
  { value: 'contracts', label: 'Contracts' },
  { value: 'attendance_records', label: 'Attendance' },
  { value: 'time_off_requests', label: 'Time off requests' },
  { value: 'time_off_allocations', label: 'Time off allocations' },
  { value: 'salary_rules', label: 'Salary rules' },
  { value: 'payruns', label: 'Payruns' },
  { value: 'payslips', label: 'Payslips' },
];

const TABLE_LABELS = new Map(TABLES.map((table) => [table.value, table.label]));

const ACTION_TONE: Record<string, string> = {
  insert: 'success',
  update: 'info',
  delete: 'danger',
};

/** insert / update / delete, said the way a person would say them. */
const ACTION_VERB: Record<string, string> = {
  insert: 'created',
  update: 'changed',
  delete: 'deleted',
};

const DEFAULTS = {
  table_name: '',
  action: '',
  actor_user_id: '',
  record_id: '',
  from: '',
  to: '',
  page: '1',
};

/** How many field changes to show before folding the rest away. */
const CHANGES_SHOWN = 4;

export function AuditPage() {
  const { values, patch } = useUrlState(DEFAULTS);
  const page = Math.max(Number(values.page) || 1, 1);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  const setFilter = (next: Partial<typeof DEFAULTS>): void => patch({ ...next, page: '1' });

  const query = {
    table_name: values.table_name,
    action: values.action,
    actor_user_id: values.actor_user_id,
    record_id: values.record_id,
    from: values.from,
    to: values.to,
  };

  const { data, loading, error } = useResource<Page<AuditEntry>>(
    `/audit${queryString({ ...query, page, page_size: 25 })}`,
  );
  const actors = useResource<{ rows: Actor[] }>('/audit/actors');

  const toggle = (id: number): void => setExpanded((open) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <>
      <div className="page__header">
        <div className="page__title">
          <h1>Audit trail</h1>
          <span className="page__subtitle">
            Every change to an employee, contract, attendance record, leave request, salary rule,
            payrun or payslip — who made it, when, and what moved.
          </span>
        </div>
      </div>

      {values.record_id !== '' && (
        <div className="alert alert--info">
          <span>
            Showing the history of one {TABLE_LABELS.get(values.table_name) ?? 'record'} only.
          </span>
          <button className="linklike" onClick={() => setFilter({ record_id: '', table_name: '' })}>
            Show everything
          </button>
        </div>
      )}
      {error !== null && <div className="error-box">{error}</div>}

      <Panel flush>
        <Toolbar
          right={
            <>
              <span className="toolbar__count">{data?.total ?? 0} changes</span>
              <ExportButtons path="/audit/export" name="audit-trail" query={query} />
            </>
          }
        >
          <select className="select" style={{ width: 'auto' }} value={values.table_name}
            onChange={(event) => setFilter({ table_name: event.target.value })}
            aria-label="Filter by record type">
            <option value="">All records</option>
            {TABLES.map((table) => (
              <option key={table.value} value={table.value}>{table.label}</option>
            ))}
          </select>
          <select className="select" style={{ width: 'auto' }} value={values.action}
            onChange={(event) => setFilter({ action: event.target.value })}
            aria-label="Filter by what happened">
            <option value="">Anything</option>
            <option value="insert">Created</option>
            <option value="update">Changed</option>
            <option value="delete">Deleted</option>
          </select>
          <select className="select" style={{ width: 'auto' }} value={values.actor_user_id}
            onChange={(event) => setFilter({ actor_user_id: event.target.value })}
            aria-label="Filter by who made the change">
            <option value="">Anyone</option>
            {actors.data?.rows.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.email} ({actor.changes.toLocaleString('en-IN')})
              </option>
            ))}
          </select>
          <input className="input" style={{ width: 'auto' }} type="date" value={values.from}
            onChange={(event) => setFilter({ from: event.target.value })} aria-label="From date" />
          <input className="input" style={{ width: 'auto' }} type="date" value={values.to}
            onChange={(event) => setFilter({ to: event.target.value })} aria-label="To date" />
        </Toolbar>

        {loading ? (
          <div className="loading">Loading the trail…</div>
        ) : (data?.rows.length ?? 0) === 0 ? (
          <div className="table__empty">No changes match these filters.</div>
        ) : (
          <ol className="trail">
            {data?.rows.map((entry) => {
              const open = expanded.has(entry.id);
              const shown = open ? entry.changes : entry.changes.slice(0, CHANGES_SHOWN);
              const hidden = entry.changes.length - shown.length;

              return (
                <li key={entry.id} className="trail__entry">
                  <div className="trail__head">
                    <time className="trail__when" dateTime={entry.changed_at}>
                      {formatDateTime(entry.changed_at)}
                    </time>
                    <Badge variant={ACTION_TONE[entry.action] ?? 'info'}>
                      {ACTION_VERB[entry.action] ?? entry.action}
                    </Badge>
                    <span className="trail__what">
                      {TABLE_LABELS.get(entry.table_name) ?? entry.table_name}
                      {' — '}
                      {entry.subject_employee_id === null ? (
                        <strong>{entry.subject}</strong>
                      ) : (
                        <Link to={`/employees/${entry.subject_employee_id}`}>
                          <strong>{entry.subject}</strong>
                        </Link>
                      )}
                    </span>
                    <span className="trail__spacer" />
                    <span className="trail__who">
                      {/* A change with no actor came from a migration or a seed,
                          not from a person. Saying "system" is more honest than
                          leaving the column blank and letting it read as unknown. */}
                      {entry.actor_email === null ? (
                        <span className="muted">system</span>
                      ) : (
                        <>
                          {entry.actor_name ?? entry.actor_email}
                          {entry.actor_role !== null && (
                            <span className="muted"> · {entry.actor_role}</span>
                          )}
                        </>
                      )}
                    </span>
                    <button
                      className="linklike trail__history"
                      onClick={() => setFilter({
                        table_name: entry.table_name,
                        record_id: String(entry.record_id),
                      })}
                    >
                      History
                    </button>
                  </div>

                  {shown.length > 0 && (
                    <dl className="trail__changes">
                      {shown.map((change) => (
                        <div key={change.field} className="trail__change">
                          <dt>{humanize(change.field)}</dt>
                          <dd>
                            <span className="trail__from">{change.from ?? '—'}</span>
                            <span className="trail__arrow" aria-label="became">→</span>
                            <span className="trail__to">{change.to ?? '—'}</span>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}

                  {hidden > 0 && (
                    <button className="linklike trail__more" onClick={() => toggle(entry.id)}>
                      {hidden} more field{hidden === 1 ? '' : 's'}
                    </button>
                  )}
                  {open && entry.changes.length > CHANGES_SHOWN && (
                    <button className="linklike trail__more" onClick={() => toggle(entry.id)}>
                      Show less
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        <Pagination
          page={data?.page ?? 1}
          totalPages={data?.total_pages ?? 1}
          total={data?.total ?? 0}
          onPageChange={(next) => patch({ page: String(next) })}
        />
      </Panel>
    </>
  );
}
