/**
 * CSV, to RFC 4180.
 *
 * Quoting is unconditional rather than conditional on the field containing a
 * comma. Conditional quoting is the version everyone writes and it is the
 * version that breaks on the field nobody tested -- a name with a comma in it, a
 * note containing a newline, an address with a quotation mark. Quoting
 * everything costs two bytes a field and cannot be got wrong.
 *
 * A UTF-8 byte order mark leads the file. Without it Excel on Windows reads the
 * bytes as the system's legacy codepage, and every rupee sign and every name
 * outside ASCII arrives as mojibake -- which reads as the export being broken
 * rather than as a decoding default.
 */
import { cellsFor } from './sheet.ts';
import type { Sheet } from './sheet.ts';

const BOM = '﻿';

function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function toCsv<Row>(sheet: Sheet<Row>): Buffer {
  const lines = [sheet.columns.map((column) => quote(column.header)).join(',')];

  for (const row of cellsFor(sheet)) {
    lines.push(row.map((cell) => ('number' in cell ? String(cell.number) : quote(cell.text))).join(','));
  }

  // CRLF, which is what the format says and what Excel expects.
  return Buffer.from(BOM + lines.join('\r\n') + '\r\n', 'utf8');
}
