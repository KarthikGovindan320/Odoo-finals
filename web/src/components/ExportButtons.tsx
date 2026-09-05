/**
 * Taking a filtered list away as a file.
 *
 * The two buttons send the *filters*, not the rows on screen. A button labelled
 * "Export" that hands over the sixty rows somebody happens to be looking at is
 * the kind of helpfulness that gets discovered during a reconcile, so the server
 * re-runs the same query without pagination and builds the file from all of it.
 *
 * Errors surface beside the buttons rather than as a tab of raw JSON: the most
 * likely one is the row limit, and its message says which filter to narrow.
 */
import { useState } from 'react';

import { downloadFile, queryString } from '../lib/api.ts';

type Props = {
  /** The export endpoint, e.g. '/employees/export'. */
  path: string;
  /** The list's current filters, sent verbatim so the file matches the screen. */
  query: Record<string, string | number | undefined | null>;
  /** Used only if the server does not name the file itself. */
  name: string;
};

const FORMATS = [
  { format: 'csv', label: 'Export CSV' },
  { format: 'xlsx', label: 'Export Excel' },
] as const;

export function ExportButtons({ path, query, name }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = (format: 'csv' | 'xlsx'): void => {
    setBusy(format);
    setError(null);
    void downloadFile(`${path}${queryString({ ...query, format })}`, `${name}.${format}`)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'The export could not be prepared.'))
      .finally(() => setBusy(null));
  };

  return (
    <span className="export">
      {FORMATS.map(({ format, label }) => (
        <button
          key={format}
          type="button"
          className="btn btn--sm"
          disabled={busy !== null}
          onClick={() => start(format)}
        >
          {busy === format ? 'Preparing…' : label}
        </button>
      ))}
      {error !== null && (
        <span className="export__error" role="alert">{error}</span>
      )}
    </span>
  );
}
