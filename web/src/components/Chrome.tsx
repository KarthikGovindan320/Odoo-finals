/**
 * The recognisable furniture of a business record: a status bar across the top
 * showing where it is in its workflow, smart buttons linking to related records
 * with counts, and a search/filter toolbar above every list.
 *
 * These three are what make separate modules feel like one system rather than
 * three screens behind three menu items.
 */
import { useState } from 'react';
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
          <h2 className="panel__title">{title}</h2>
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

export function Modal({ title, onClose, footer, children, wide }: ModalProps) {
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={wide === true ? 'modal modal--wide' : 'modal'}>
        <header className="modal__header">
          <h2>{title}</h2>
          <button className="btn btn--sm" onClick={onClose} aria-label="Close">✕</button>
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
