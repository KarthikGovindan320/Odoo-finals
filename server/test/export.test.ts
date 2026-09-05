/**
 * The export writers.
 *
 * Both are hand-written, and both have exactly one job that is easy to get
 * subtly wrong: putting arbitrary user text into a format with delimiters. A
 * name with a comma, a note with a newline, an address with a quotation mark and
 * a stray control character from a paste are all ordinary in an HR database and
 * all fatal to a naive writer -- the CSV gains a column, or Excel declines to
 * open the workbook at all and says only that it found a problem with some
 * content.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inflateRawSync } from 'node:zlib';

import { toCsv } from '../src/export/csv.ts';
import { toXlsx } from '../src/export/xlsx.ts';
import type { Sheet } from '../src/export/sheet.ts';

type Row = { name: string; note: string; wage: number | null };

const HOSTILE = 'Comma, quote " and' + String.fromCharCode(10) + 'newline'
  + String.fromCharCode(7) + 'bell';

const SHEET: Sheet<Row> = {
  name: 'Employees',
  columns: [
    { header: 'Name', value: (row) => row.name },
    { header: 'Note', value: (row) => row.note },
    { header: 'Wage', type: 'number', value: (row) => row.wage },
  ],
  rows: [
    { name: 'Kabir Raghavan', note: 'Ordinary', wage: 78000 },
    { name: 'O’Brien, "Ishita" <tag> & co', note: HOSTILE, wage: 60000.55 },
    { name: 'No contract', note: '', wage: null },
  ],
};

/** Reads a stored/deflated zip entry back out, by scanning local headers. */
function unzip(archive: Buffer): Map<string, Buffer> {
  const parts = new Map<string, Buffer>();
  let at = 0;

  while (at + 4 <= archive.length && archive.readUInt32LE(at) === 0x04_03_4b_50) {
    const compressedSize = archive.readUInt32LE(at + 18);
    const nameLength = archive.readUInt16LE(at + 26);
    const extraLength = archive.readUInt16LE(at + 28);
    const name = archive.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extraLength;
    parts.set(name, inflateRawSync(archive.subarray(start, start + compressedSize)));
    at = start + compressedSize;
  }

  return parts;
}

describe('CSV export', () => {
  const text = toCsv(SHEET).toString('utf8');

  it('leads with a byte order mark', () => {
    // Without it Excel on Windows reads the bytes as the system codepage, and
    // every name outside ASCII arrives as mojibake -- which reads as a broken
    // export rather than as a decoding default.
    assert.equal(text.charCodeAt(0), 0xfe_ff);
  });

  it('keeps every row on one record despite a newline inside a field', () => {
    // Splitting on the line ending is exactly what a consumer does, so a field
    // containing one must stay inside its quotes. Four records: a header and
    // three rows, whatever the notes contain.
    const records = text.slice(1).split('\r\n').filter((line) => line !== '');
    assert.equal(records.filter((line) => line.startsWith('"')).length, records.length);
    assert.equal((text.match(/\r\n/g) ?? []).length, 4);
  });

  it('doubles quotation marks rather than dropping them', () => {
    assert.ok(text.includes('"O’Brien, ""Ishita"" <tag> & co"'));
  });

  it('writes numbers unquoted and blanks as empty quoted fields', () => {
    assert.ok(text.includes(',78000'), 'a number is a number');
    assert.ok(text.includes('"No contract","",'), 'a missing value is an empty field');
  });
});

describe('XLSX export', () => {
  const parts = unzip(toXlsx(SHEET));
  const sheet = parts.get('xl/worksheets/sheet1.xml')?.toString('utf8') ?? '';

  it('is a zip carrying the parts a workbook needs', () => {
    for (const name of [
      '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml',
    ]) {
      assert.ok(parts.has(name), `${name} should be in the archive`);
    }
  });

  it('escapes the five characters XML reserves', () => {
    assert.ok(sheet.includes('&amp;'), 'ampersand');
    assert.ok(sheet.includes('&lt;tag&gt;'), 'angle brackets');
    assert.ok(!sheet.includes('<tag>'), 'and does not leave the raw form behind');
  });

  it('strips control characters XML cannot carry', () => {
    // Excel does not warn about these. It declines to open the file.
    assert.ok(!sheet.includes(String.fromCharCode(7)), 'the bell is gone');
    assert.ok(sheet.includes('bell'), 'but the text around it survives');
    assert.ok(sheet.includes(String.fromCharCode(10)), 'a newline is legal and is kept');
  });

  it('writes numbers as numbers and text as text', () => {
    assert.ok(sheet.includes('<v>78000</v>'), 'a wage is a numeric cell');
    assert.ok(sheet.includes('<v>60000.55</v>'), 'including a fractional one');
    assert.ok(!sheet.includes('t="inlineStr"><is><t xml:space="preserve">78000'),
      'and is not written as a string a spreadsheet cannot total');
  });

  it('gives the sheet a name Excel will accept', () => {
    const workbook = parts.get('xl/workbook.xml')?.toString('utf8') ?? '';
    assert.ok(workbook.includes('name="Employees"'));

    const awkward = unzip(toXlsx({ ...SHEET, name: 'Time off / requests [2026]' }));
    const renamed = awkward.get('xl/workbook.xml')?.toString('utf8') ?? '';
    // Excel refuses : \\ / ? * [ ] by declining to open the file, not by saying so.
    assert.ok(!/name="[^"]*[:\\/?*\[\]]/.test(renamed), renamed);
  });

  it('numbers the cells across and down', () => {
    assert.ok(sheet.includes('r="A1"') && sheet.includes('r="C1"'), 'the header row');
    assert.ok(sheet.includes('r="A4"'), 'and the last of three data rows');
  });
});
