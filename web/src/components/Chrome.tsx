/**
 * The recognisable furniture of a business record: a status bar across the top
 * showing where it is in its workflow, smart buttons linking to related records
 * with counts, and a search/filter toolbar above every list.
 *
 * These three are what make separate modules feel like one system rather than
 * three screens behind three menu items.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { humanize } from '../lib/format.ts';

/* ------------------------------------------------------------- status bar -- */

type StatusBarProps = {
  steps: string[];
  current: string;
  /** States that end the workflow early, drawn in red wherever they occur. */
  terminal?: string[];
};

export function StatusBar({ steps, current, terminal = ['cancelled', 'refused'] }: StatusBarProps) {
  if (terminal.includes(current)) {
    return (
      <div className="statusbar">
        <span className="statusbar__step statusbar__step--cancelled">{humanize(current)}</span>
      </div>
    );
  }

  const currentIndex = steps.indexOf(current);

  return (
    <div className="statusbar" role="status" aria-label={`Status: ${humanize(current)}`}>
      {steps.map((step, index) => (
        <span
          key={step}
          className={[
            'statusbar__step',
            index < currentIndex ? 'statusbar__step--done' : '',
            index === currentIndex ? 'statusbar__step--current' : '',
          ].filter(Boolean).join(' ')}
        >
          {humanize(step)}
        </span>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------- smart button -- */

type SmartButtonProps = {
  count: number | string;
  label: string;
  to: string;
};

export function SmartButton({ count, label, to }: SmartButtonProps) {
  return (
    <Link className="smart-button" to={to}>
      <span className="smart-button__count">{count}</span>
      <span className="smart-button__label">{label}</span>
    </Link>
  );
}

/* --------------------------------------------------------------- toolbar --- */

type ToolbarProps = {
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  children?: ReactNode;
  right?: ReactNode;
};

export function Toolbar({
  search, onSearchChange, searchPlaceholder, children, right,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      {onSearchChange !== undefined && (
        <input
          className="input toolbar__search"
          type="search"
          value={search ?? ''}
          placeholder={searchPlaceholder ?? 'Search…'}
          onChange={(event) => onSearchChange(event.target.value)}
          aria-label="Search"
        />
      )}
      {children}
      <span className="toolbar__spacer" />
      {right}
    </div>
  );
}

/* ---------------------------------------------------------------- badges --- */

export function Badge({ children, variant }: { children: ReactNode; variant?: string }) {
  return (
    <span className={`badge${variant !== undefined && variant !== '' ? ` badge--${variant}` : ''}`}>
      {children}
    </span>
  );
}

/* ----------------------------------------------------------------- panel --- */

type PanelProps = {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
};

export function Panel({ title, actions, children, flush }: PanelProps) {
  return (
    <section className="panel">
      {(title !== undefined || actions !== undefined) && (
        <header className="panel__header">
          {/* Rendered only when there is something to say. An <h2></h2> with no
              text put an empty heading into the document outline. */}
          {title !== undefined && <h2 className="panel__title">{title}</h2>}
          {actions}
        </header>
      )}
      <div className={flush === true ? 'panel__body panel__body--flush' : 'panel__body'}>
        {children}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- modal --- */

type ModalProps = {
  title: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  wide?: boolean;
};

/**
 * A dialog that behaves like one.
 *
 * role="dialog" and aria-modal were already set, but none of what they promise
 * was implemented: Escape did nothing, focus was never moved in or restored on
 * close, Tab walked straight out into the page behind, and the body kept
 * scrolling. Every create and edit flow in the application runs through here.
 */
export function Modal({ title, onClose, footer, children, wide }: ModalProps) {
  const titleId = useId();
  const surface = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocusTo.current = document.activeElement as HTMLElement | null;

    // Move focus in, preferring the first control over the dialog itself.
    const focusable = surface.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    (focusable?.[0] ?? surface.current)?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
      returnFocusTo.current?.focus();
    };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }

    if (event.key !== 'Tab') {
      return;
    }

    // Keep Tab inside the dialog by wrapping at either end.
    const focusable = [
      ...(surface.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ].filter((element) => element.offsetParent !== null);

    if (focusable.length === 0) {
      return;
    }

    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;

    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
  };

  return (
    <div
      className="modal-backdrop"
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={wide === true ? 'modal modal--wide' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={surface}
      >
        <header className="modal__header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn btn--sm" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="modal__body">{children}</div>
        {footer !== undefined && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- alerts --- */

export function AlertList({
  items,
}: {
  items: Array<{ severity: string; code: string; message: string }>;
}) {
  if (items.length === 0) {
    return <p className="muted">No issues found.</p>;
  }

  return (
    <div>
      {items.map((item, index) => (
        <div key={`${item.code}-${index}`} className={`alert alert--${item.severity}`}>
          <span className="alert__code">{item.code}</span>
          <span>{item.message}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Warnings, grouped by kind rather than listed one per row.
 *
 * A payrun of sixty people routinely produces forty warnings, and thirty of them
 * are the same sentence with a different name in it. Listing them flat buries
 * both the blocking issues and the payslip table underneath. Grouping by code
 * answers the question the payroll officer actually has -- *what kinds of problem
 * does this run have, and how many of each* -- and keeps the individual names one
 * click away.
 *
 * Blockers are never collapsed: they stop the run, so they are not something to
 * go looking for.
 */
export function WarningDigest({
  items,
}: {
  items: Array<{ severity: string; code: string; message: string }>;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (items.length === 0) {
    return (
      <p className="muted" style={{ margin: 0 }}>
        No issues found. This payrun is clean.
      </p>
    );
  }

  const groups = new Map<string, { severity: string; code: string; messages: string[] }>();
  for (const item of items) {
    const group = groups.get(item.code) ?? { severity: item.severity, code: item.code, messages: [] };
    group.messages.push(item.message);
    groups.set(item.code, group);
  }

  const severityRank: Record<string, number> = { blocker: 0, warning: 1, info: 2 };
  const ordered = [...groups.values()].sort(
    (first, second) =>
      (severityRank[first.severity] ?? 3) - (severityRank[second.severity] ?? 3) ||
      second.messages.length - first.messages.length,
  );

  const toggle = (code: string): void =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });

  return (
    <div className="digest">
      {ordered.map((group) => {
        const isOpen = group.severity === 'blocker' || expanded.has(group.code);
        const count = group.messages.length;

        return (
          <div key={group.code} className={`digest__group digest__group--${group.severity}`}>
            <button
              type="button"
              className="digest__head"
              onClick={() => toggle(group.code)}
              aria-expanded={isOpen}
              disabled={group.severity === 'blocker'}
            >
              <span className="digest__code">{group.code}</span>
              <span className="digest__count">{count}</span>
              <span className="digest__summary">{group.messages[0]}</span>
              {group.severity !== 'blocker' && (
                <span className="digest__toggle" aria-hidden="true">{isOpen ? 'Hide' : `Show all ${count}`}</span>
              )}
            </button>

            {isOpen && count > 1 && (
              <ul className="digest__list">
                {group.messages.map((message, index) => (
                  <li key={index}>{message}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------- confirmation -- */

type ConfirmProps = {
  title: string;
  /** The one-line question. */
  question: string;
  /** What the reader needs to know before answering, if anything. */
  detail?: ReactNode;
  confirmLabel: string;
  /** Marks the action as one that cannot be taken back. */
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Stands in front of an action that cannot be undone.
 *
 * Validate freezes a payrun at the database level, Mark paid asserts money has
 * moved, and Send payslips emails salary documents to the whole workforce. All
 * three were single unguarded clicks, adjacent to one another, with no undo to
 * offer afterwards.
 *
 * The confirm button carries the verb rather than the word "OK", so the last
 * thing read before committing says what is about to happen.
 */
export function ConfirmDialog({
  title, question, detail, confirmLabel, destructive, busy, onConfirm, onCancel,
}: ConfirmProps) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={busy === true}>
            Cancel
          </button>
          <button
            type="button"
            className={destructive === true ? 'btn btn--danger' : 'btn btn--primary'}
            onClick={onConfirm}
            disabled={busy === true}
          >
            {busy === true ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <p className="confirm__body">{question}</p>
      {detail !== undefined && <div className="confirm__detail">{detail}</div>}
    </Modal>
  );
}

/* --------------------------------------------------------------- details -- */

/**
 * A label/value pair inside a <dl>.
 *
 * Previously copy-pasted into EmployeeDetailPage and PayslipDetailPage, where
 * the two copies were identical and free to drift.
 */
export function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd>
        {value === null || value === undefined || value === '' ? <span className="muted">—</span> : value}
      </dd>
    </div>
  );
}

/** The payrun and payslip lifecycle, named once. */
export const PAYROLL_WORKFLOW = ['draft', 'computed', 'validated', 'paid'];
