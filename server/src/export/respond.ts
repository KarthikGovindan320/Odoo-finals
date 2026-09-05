/**
 * Turning a sheet into a download.
 *
 * The export is of the filtered set, not of the page on screen. Exporting the
 * sixty rows somebody happens to be looking at, under a button labelled
 * "Export", is the kind of helpfulness that gets discovered during a reconcile.
 *
 * That makes an upper bound necessary, and the bound refuses rather than
 * truncates. A file that quietly stops at row 50,000 is indistinguishable from a
 * complete one, and the person who trusts it has no way to find out.
 */
import type { Response } from 'express';

import { AppError } from '../errors/app_error.ts';
import { toCsv } from './csv.ts';
import { toXlsx } from './xlsx.ts';
import type { Sheet } from './sheet.ts';

export type ExportFormat = 'csv' | 'xlsx';

/**
 * How many rows an export may carry.
 *
 * Set against the largest table this system holds -- attendance, at forty
 * thousand rows for a year of three hundred and fifty people -- so a whole
 * year exports in one go and nothing plausible is refused. Both writers build
 * the file in memory, which is what the ceiling is really protecting.
 */
export const EXPORT_ROW_LIMIT = 50_000;

export function assertExportable(total: number): void {
  if (total > EXPORT_ROW_LIMIT) {
    throw new AppError(
      'export_too_large',
      `That is ${total.toLocaleString('en-IN')} rows, and an export carries at most `
        + `${EXPORT_ROW_LIMIT.toLocaleString('en-IN')}. Narrow the filters -- by date range, `
        + 'department or employee -- and export in parts.',
      { total, limit: EXPORT_ROW_LIMIT },
    );
  }
}

/** A filename that survives Windows, macOS and a Content-Disposition header. */
function filenameFor(sheetName: string, format: ExportFormat): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const base = sheetName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${base || 'export'}-${stamp}.${format}`;
}

const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function sendSheet<Row>(
  response: Response,
  sheet: Sheet<Row>,
  format: ExportFormat,
): void {
  const body = format === 'xlsx' ? toXlsx(sheet) : toCsv(sheet);

  response.setHeader('Content-Type', CONTENT_TYPES[format]);
  response.setHeader('Content-Disposition', `attachment; filename="${filenameFor(sheet.name, format)}"`);
  response.setHeader('Content-Length', String(body.length));
  // The file is a snapshot of a query taken now; a cached copy would be a
  // different report wearing the same URL.
  response.setHeader('Cache-Control', 'no-store');
  response.send(body);
}
