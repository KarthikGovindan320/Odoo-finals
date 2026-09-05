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
 *
 * A stream still needs structure, or twenty-five evenly weighted entries read as
 * one grey block. Three things give it that. Entries are gathered under the day
 * they happened on, so the date is stated once instead of twenty-five times and
 * only the clock time sits in the gutter. A hairline runs down the entries with
 * a marker on each, coloured by what happened, so the shape of a page -- a run
 * of creates, one deletion -- is visible before a word of it is read. And the
 * field changes hang off the entry they belong to rather than being pushed
 * across the page by a hardcoded indent that had to match the gutter's width.
 */
import { useState } from 'react';
import { Link } from 'react-router';

import { queryString } from '../lib/api.ts';
import { useResource, type Page } from '../lib/use_resource.ts';
import { useUrlState } from '../lib/use_url_state.ts';
import {
  dayKey, formatDate, formatDayName, formatNumber, formatTime, humanize,
} from '../lib/format.ts';
import { Panel, Toolbar } from '../components/Chrome.tsx';
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

/**
 * The tables the triggers cover, in the words the interface uses elsewhere.
 *
 * Each carries its singular too, because the scope banner talks about exactly
 * one of them and "the history of one Employees" is not a sentence.
 */
const TABLES: { value: string; label: string; one: string }[] = [
  { value: 'employees', label: 'Employees', one: 'employee' },
  { value: 'contracts', label: 'Contracts', one: 'contract' },
  { value: 'attendance_records', label: 'Attendance', one: 'attendance record' },
  { value: 'time_off_requests', label: 'Time off requests', one: 'time off request' },
  { value: 'time_off_allocations', label: 'Time off allocations', one: 'time off allocation' },
  { value: 'salary_rules', label: 'Salary rules', one: 'salary rule' },
  { value: 'payruns', label: 'Payruns', one: 'payrun' },
  { value: 'payslips', label: 'Payslips', one: 'payslip' },
];

const TABLE_LABELS = new Map(TABLES.map((table) => [table.value, table.label]));
const TABLE_SINGULARS = new Map(TABLES.map((table) => [table.value, table.one]));

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

/** What redact_audited_row() writes in place of a value it refuses to record. */
const REDACTED = '[redacted]';

/**
 * To the second, for the hover.
 *
 * The gutter shows the clock time to the minute, which is as much as anyone
 * scans. It is not always enough to order by: the seed writes forty thousand
 * attendance rows inside a few seconds, and a page of them all reads 04:42.
 */
const PRECISE = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium', timeStyle: 'medium', hour12: false,
});

/** Null and empty string are the same thing to a reader: nothing is there. */
function isBlank(value: string | null): boolean {
  return value === null || value === '';
}

/**
 * How much a field's line actually tells the reader, lowest first.
 *
 * The server sorts the changes alphabetically, which is the right default for a
 * complete list and the wrong one for a preview of four. An employee is created
 * with twenty-four columns and the first four in the alphabet are address,
 * bank_account_number, bank_ifsc and bank_name -- so the collapsed entry for a
 * new hire read "[redacted], [redacted], [redacted], Axis Bank" and said
 * nothing about who had been hired.
 *
 * Nothing is hidden by this: it decides which four surface first, and the rest
 * are one click away as before. Three kinds of line say least -- a column that
 * is empty on both sides, the primary key, which only repeats the record the
 * entry is already about, and a column the trail declined to record.
 */
function informativeness(change: Change): number {
  if (isBlank(change.from) && isBlank(change.to)) return 2;
  if (change.field === 'id') return 2;
  if (change.from === REDACTED || change.to === REDACTED) return 1;
  return 0;
}

/** Array.sort is stable, so equal ranks keep the server's alphabetical order. */
function ranked(changes: Change[]): Change[] {
  return [...changes].sort((first, second) => informativeness(first) - informativeness(second));
}

type Day = { key: string; entries: AuditEntry[] };

/**
 * The page, cut into days.
 *
 * Rows arrive newest first, so a day is a run of neighbours rather than
 * something to group and re-sort.
 */
function byDay(rows: AuditEntry[]): Day[] {
  const days: Day[] = [];

  for (const entry of rows) {
    const key = dayKey(entry.changed_at);
    const current = days.at(-1);

    if (current !== undefined && current.key === key) current.entries.push(entry);
    else days.push({ key, entries: [entry] });
  }

  return days;
}

/** Two letters standing in for a photograph this system does not hold. */
function initials(name: string | null, email: string): string {
  const words = (name ?? email.split('@')[0] ?? email).split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1
    ? `${words[0]?.charAt(0)}${words[1]?.charAt(0)}`
    : (words[0] ?? '?').slice(0, 2);

  return letters.toUpperCase();
}

/**
 * One side of a field change.
 *
 * '[redacted]' is not a value the column held; it is the trail stating that it
 * declined to record one. Set in the same monospace as an account number it
 * invites the reader to read it as data, so it is drawn as the annotation it is.
 */
function Value({ text, tone }: { text: string | null; tone: 'from' | 'to' }) {
  if (isBlank(text)) return <span className="trail__empty">—</span>;
  if (text === REDACTED) return <span className="trail__redacted">redacted</span>;

  return <span className={`trail__${tone}`}>{text}</span>;
}

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

  const filtered = Object.values(query).some((value) => value !== '');
  const clearFilters = (): void => setFilter({
    table_name: '', action: '', actor_user_id: '', record_id: '', from: '', to: '',
  });

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

  const rows = data?.rows ?? [];

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
            The whole life of one {TABLE_SINGULARS.get(values.table_name) ?? 'record'}
            {rows[0] !== undefined && <strong> — {rows[0].subject}</strong>}.
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
              <span className="toolbar__count">{formatNumber(data?.total)} changes</span>
              <ExportButtons path="/audit/export" name="audit-trail" query={query} />
            </>
          }
        >
          <select className="select toolbar__filter" value={values.table_name}
            onChange={(event) => setFilter({ table_name: event.target.value })}
            aria-label="Filter by record type">
            <option value="">All records</option>
            {TABLES.map((table) => (
              <option key={table.value} value={table.value}>{table.label}</option>
            ))}
          </select>
          <select className="select toolbar__filter" value={values.action}
            onChange={(event) => setFilter({ action: event.target.value })}
            aria-label="Filter by what happened">
            <option value="">Anything</option>
            <option value="insert">Created</option>
            <option value="update">Changed</option>
            <option value="delete">Deleted</option>
          </select>
          <select className="select toolbar__filter" value={values.actor_user_id}
            onChange={(event) => setFilter({ actor_user_id: event.target.value })}
            aria-label="Filter by who made the change">
            <option value="">Anyone</option>
            {actors.data?.rows.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.email} ({actor.changes.toLocaleString('en-IN')})
              </option>
            ))}
          </select>
          {/* Two bare date fields say which is which only by their order. The
              dash between them is what makes them read as one range. */}
          <span className="toolbar__range">
            <input className="input toolbar__filter" type="date" value={values.from}
              onChange={(event) => setFilter({ from: event.target.value })} aria-label="From date" />
            <span className="toolbar__range-sep" aria-hidden="true">–</span>
            <input className="input toolbar__filter" type="date" value={values.to}
              onChange={(event) => setFilter({ to: event.target.value })} aria-label="To date" />
          </span>
          {/* Not while the scope banner is up: with only a record in the filters
              its "Show everything" clears exactly the same two, and two links a
              hand's width apart doing one thing is a question, not an offer. */}
          {filtered && values.record_id === '' && (
            <button className="linklike toolbar__clear" onClick={clearFilters}>Clear</button>
          )}
        </Toolbar>

        {loading ? (
          /* Placeholder entries rather than a word, so the panel keeps its
             height and the page does not jump on every filter change. */
          <div className="trail" aria-busy="true" aria-label="Loading the trail">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="trail__ghost" aria-hidden="true">
                <span className="trail__ghost-bar" />
                <span className="trail__ghost-bar" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="trail__none">
            <p>Nothing in the trail matches these filters.</p>
            {filtered && (
              <button className="linklike" onClick={clearFilters}>Clear the filters</button>
            )}
          </div>
        ) : (
          <div className="trail">
            {byDay(rows).map((day) => (
              <section key={day.key} className="trail__day">
                <h3 className="trail__day-head">
                  <span className="trail__day-name">{formatDayName(day.entries[0]!.changed_at)}</span>
                  <span className="trail__day-date">{formatDate(day.entries[0]!.changed_at)}</span>
                </h3>

                <ol className="trail__entries">
                  {day.entries.map((entry) => {
                    const open = expanded.has(entry.id);
                    const changes = ranked(entry.changes);
                    const shown = open ? changes : changes.slice(0, CHANGES_SHOWN);
                    const hidden = changes.length - shown.length;

                    return (
                      <li key={entry.id} className="trail__entry">
                        <time
                          className="trail__when"
                          dateTime={entry.changed_at}
                          title={PRECISE.format(new Date(entry.changed_at))}
                        >
                          {formatTime(entry.changed_at)}
                        </time>
                        {/* The verb beside it says the same thing in words, so
                            the colour is never the only carrier. */}
                        <span
                          className={`trail__mark trail__mark--${entry.action}`}
                          aria-hidden="true"
                        />

                        <div className="trail__body">
                          <div className="trail__head">
                            <span className={`trail__verb trail__verb--${entry.action}`}>
                              {ACTION_VERB[entry.action] ?? entry.action}
                            </span>
                            <span className="trail__kind">
                              {TABLE_LABELS.get(entry.table_name) ?? entry.table_name}
                            </span>
                            {entry.subject_employee_id === null ? (
                              <span className="trail__subject">{entry.subject}</span>
                            ) : (
                              <Link
                                className="trail__subject"
                                to={`/employees/${entry.subject_employee_id}`}
                              >
                                {entry.subject}
                              </Link>
                            )}

                            <span className="trail__spacer" />

                            <span className="trail__who">
                              {/* A change with no actor came from a migration or
                                  a seed, not from a person. Saying "system" is
                                  more honest than leaving the column blank and
                                  letting it read as unknown. */}
                              {entry.actor_email === null ? (
                                <>
                                  <span className="trail__avatar trail__avatar--system" aria-hidden="true" />
                                  <span className="trail__actor muted">system</span>
                                </>
                              ) : (
                                <>
                                  <span className="trail__avatar" aria-hidden="true">
                                    {initials(entry.actor_name, entry.actor_email)}
                                  </span>
                                  <span className="trail__actor" title={entry.actor_email}>
                                    {entry.actor_name ?? entry.actor_email}
                                  </span>
                                  {entry.actor_role !== null && (
                                    <span className="trail__role">{entry.actor_role}</span>
                                  )}
                                </>
                              )}
                            </span>

                            <button
                              className="trail__history"
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
                                    {/* An insert has no "from" and a delete has
                                        no "to". Drawing the arrow anyway put an
                                        em dash and an arrow in front of every
                                        one of a new record's twenty-four
                                        fields, to say only that it is new. */}
                                    {entry.action !== 'insert' && (
                                      <Value text={change.from} tone="from" />
                                    )}
                                    {entry.action === 'update' && (
                                      <>
                                        <span className="visually-hidden"> became </span>
                                        <span className="trail__arrow" aria-hidden="true">→</span>
                                      </>
                                    )}
                                    {entry.action !== 'delete' && (
                                      <Value text={change.to} tone="to" />
                                    )}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          )}

                          {changes.length > CHANGES_SHOWN && (
                            <button
                              className="trail__more"
                              onClick={() => toggle(entry.id)}
                              aria-expanded={open}
                            >
                              {open
                                ? 'Show fewer fields'
                                : `${hidden} more field${hidden === 1 ? '' : 's'}`}
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </div>
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
