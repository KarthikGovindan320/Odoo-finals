/**
 * Choosing an employee: a dropdown that can hold more names than a dropdown can.
 *
 * It reads as a select -- closed, showing the current choice, opening a list
 * when clicked -- because that is what the field is for and what people expect
 * beside the other selects in the same form. Underneath it is a combobox that
 * searches server-side, because a native <select> cannot do this job here: the
 * version before this one was fed /employees?page_size=200, so employee 201 was
 * unselectable with nothing on screen to say so, and 350 names in a native list
 * is not a control anybody can use.
 *
 * The earlier fix went the other way and left the search box and its results
 * permanently open in the form, which reads as a search screen wedged between
 * two dropdowns. This keeps the search and hides it until it is wanted.
 *
 * Scope rules apply through the same endpoint the Employees screen uses, so an
 * employee filing their own request sees exactly themselves.
 */
import { useEffect, useId, useRef, useState } from 'react';

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
  placeholder?: string;
};

function describe(employee: Employee): string {
  return `${employee.employee_number} — ${employee.first_name} ${employee.last_name}`;
}

export function EmployeePicker({
  label, value, onChange, error, required, placeholder = 'Select an employee…',
}: Props) {
  const fieldId = useId();
  const listboxId = `${fieldId}-listbox`;

  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const settled = useDebounced(term);

  const wrapper = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  /*
   * Only fetches while open, so a form with this field on it does not query the
   * employee list on mount just in case somebody opens the dropdown.
   */
  const { data, loading } = useResource<Page<Employee>>(
    open ? `/employees${queryString({ q: settled, page_size: 20 })}` : null,
  );

  /*
   * The chosen employee, fetched by id rather than found in the search results.
   * The closed control has to name who is selected, and the result set behind it
   * is a page of matches for whatever was last typed -- which need not contain
   * them, and does not at all before the dropdown has ever been opened.
   */
  const { data: chosen } = useResource<Employee>(
    value !== undefined && value !== '' ? `/employees/${value}` : null,
  );

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  useEffect(() => setActive(0), [settled]);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();

    const onPointerDown = (event: MouseEvent): void => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const choose = (employee: Employee): void => {
    onChange(String(employee.id));
    setOpen(false);
    setTerm('');
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActive((current) => {
        const next = current + (event.key === 'ArrowDown' ? 1 : -1);
        return Math.min(Math.max(next, 0), Math.max(rows.length - 1, 0));
      });
      return;
    }
    if (event.key === 'Enter' && open) {
      const picked = rows[active];
      if (picked !== undefined) {
        event.preventDefault();
        choose(picked);
      }
    }
  };

  return (
    <Field label={label} htmlFor={fieldId} required={required} error={error}>
      <div className="combo" ref={wrapper} onKeyDown={onKeyDown}>
        <button
          id={fieldId}
          type="button"
          className={`select combo__control${value ? '' : ' combo__control--empty'}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-invalid={error !== undefined && error !== ''}
          onClick={() => setOpen((was) => !was)}
        >
          <span className="combo__value">
            {chosen !== null && chosen !== undefined ? describe(chosen) : placeholder}
          </span>
          <span className="combo__caret" aria-hidden="true" />
        </button>

        {open && (
          <div className="combo__popover">
            <input
              ref={search}
              className="input combo__search"
              type="search"
              placeholder="Type a name or number…"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              aria-label={`Search ${label.toLowerCase()}`}
              aria-controls={listboxId}
            />

            <div className="combo__list" role="listbox" id={listboxId} aria-label={label}>
              {loading && rows.length === 0 ? (
                <div className="combo__empty">Searching…</div>
              ) : rows.length === 0 ? (
                <div className="combo__empty">No employees match that.</div>
              ) : (
                rows.map((row, index) => (
                  <button
                    key={row.id}
                    type="button"
                    role="option"
                    aria-selected={String(row.id) === value}
                    className={[
                      'combo__option',
                      String(row.id) === value ? 'combo__option--selected' : '',
                      index === active ? 'combo__option--active' : '',
                    ].filter(Boolean).join(' ')}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(row)}
                  >
                    <span className="mono">{row.employee_number}</span>
                    <span>{row.first_name} {row.last_name}</span>
                  </button>
                ))
              )}
            </div>

            {/* Says plainly that the list is a page of the matches, rather than
                silently truncating and letting the user conclude someone is
                missing. */}
            {total > rows.length && (
              <div className="combo__footer">
                Showing {rows.length} of {total}. Narrow the search to find someone else.
              </div>
            )}
          </div>
        )}
      </div>
    </Field>
  );
}
