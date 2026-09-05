/**
 * The recognisable furniture of a business record: a status bar across the top
 * showing where it is in its workflow, smart buttons linking to related records
 * with counts, and a search/filter toolbar above every list.
 *
 * These three are what make separate modules feel like one system rather than
 * three screens behind three menu items.
 */
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
