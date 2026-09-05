/**
 * Choosing an employee.
 *
 * Replaces a plain <select> fed by /employees?page_size=200. That had two
 * problems: employee 201 could not be selected at all, with nothing to say so,
 * and a native select holding two hundred names is not a usable control even
 * below the cap.
 *
 * This searches server-side against the same endpoint and list the Employees
 * screen uses, so the scope rules apply here too -- an Employee filing their own
 * request sees exactly themselves.
 */
import { useId, useState } from 'react';

import { queryString } from '../lib/api.ts';
import { useResource, type Page } from '../lib/use_resource.ts';
import { useDebounced } from '../lib/use_debounced.ts';
import { Field } from './Field.tsx';

type Employee = {
  id: number;
  first_name: string;
  last_name: string;
  employee_number: string;
};

type Props = {
  label: string;
  /** Optional because the forms hold their state as Record<string, string>. */
  value: string | undefined;
  onChange: (employeeId: string) => void;
  error?: string | undefined;
  required?: boolean;
};

export function EmployeePicker({ label, value, onChange, error, required }: Props) {
  const listId = useId();
  const [term, setTerm] = useState('');
  const settled = useDebounced(term);

  const { data, loading } = useResource<Page<Employee>>(
    `/employees${queryString({ q: settled, page_size: 20 })}`,
  );

  const rows = data?.rows ?? [];
  const selected = rows.find((row) => String(row.id) === value);
  const total = data?.total ?? 0;

  return (
    <Field label={label} htmlFor={listId} required={required} error={error}
      hint={
        selected !== undefined
          ? `Selected: ${selected.employee_number} — ${selected.first_name} ${selected.last_name}`
          : 'Type a name or employee number to search.'
      }
    >
      <input
        id={listId}
        className="input"
        type="search"
        placeholder="Search employees…"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        aria-invalid={error !== undefined && error !== ''}
      />

      <div className="picker" role="listbox" aria-label={label}>
        {loading && rows.length === 0 ? (
          <div className="picker__empty">Searching…</div>
        ) : rows.length === 0 ? (
          <div className="picker__empty">No employees match that.</div>
        ) : (
          rows.map((row) => (
            <button
              key={row.id}
              type="button"
              role="option"
              aria-selected={String(row.id) === value}
              className={`picker__option${String(row.id) === value ? ' picker__option--selected' : ''}`}
              onClick={() => onChange(String(row.id))}
            >
              <span className="mono">{row.employee_number}</span>
              <span>{row.first_name} {row.last_name}</span>
            </button>
          ))
        )}
      </div>

      {/* Says plainly that the list is a page of the matches, rather than
          silently truncating and letting the user conclude someone is missing. */}
      {total > rows.length && (
        <span className="field__hint">
          Showing {rows.length} of {total}. Narrow the search to find someone else.
        </span>
      )}
    </Field>
  );
}
