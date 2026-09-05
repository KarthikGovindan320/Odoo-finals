/**
 * A real .xlsx, written by hand.
 *
 * The alternative was to serve a CSV with a .xlsx extension, which opens in
 * Excel and is a lie: the file is not a workbook, numeric columns arrive as
 * text, and anyone who inspects it finds out. A dependency was the other option,
 * and this is a zip container holding six small XML files -- less code than
 * reviewing a package would be, and the same instinct as the expression parser
 * two directories over.
 *
 * The container is the minimum OOXML that Excel, LibreOffice and Google Sheets
 * all open: a content-type map, two relationship files, a style sheet, a
 * workbook naming one sheet, and the sheet. Strings are written inline rather
 * than through a shared string table -- the table saves space on repetitive data
 * and costs a whole second index to get wrong.
 */
import { deflateRawSync } from 'node:zlib';

import { cellsFor } from './sheet.ts';
import type { Cell, Sheet } from './sheet.ts';

/**
 * XML text escaping, and the removal of characters XML 1.0 cannot carry at all.
 *
 * A stray control character in a free-text note does not produce a warning in
 * Excel -- it produces "we found a problem with some content", and the workbook
 * does not open. Stripping them is the only option that yields a file.
 */
function escapeXml(value: string): string {
  return value
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A1, B1 ... Z1, AA1. Columns are base-26 with no zero digit, hence the -1. */
function reference(columnIndex: number, rowNumber: number): string {
  let name = '';
  let remaining = columnIndex;
  while (remaining >= 0) {
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26) - 1;
  }
  return `${name}${rowNumber}`;
}

function cellXml(cell: Cell, columnIndex: number, rowNumber: number, style?: number): string {
  const at = reference(columnIndex, rowNumber);
  const styled = style === undefined ? '' : ` s="${style}"`;

  if ('number' in cell) {
    return `<c r="${at}"${styled}><v>${cell.number}</v></c>`;
  }
  if (cell.text === '') {
    return `<c r="${at}"${styled}/>`;
  }
  // xml:space="preserve" so leading and trailing spaces survive the round trip.
  return `<c r="${at}"${styled} t="inlineStr"><is><t xml:space="preserve">`
    + `${escapeXml(cell.text)}</t></is></c>`;
}

/**
 * Excel refuses a sheet name containing any of : \ / ? * [ ] or longer than 31
 * characters -- by declining to open the file, not by complaining about it.
 */
function safeSheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*\[\]]/g, ' ').trim();
  return (cleaned === '' ? 'Sheet1' : cleaned).slice(0, 31);
}

function sheetXml<Row>(sheet: Sheet<Row>): string {
  const rows = cellsFor(sheet);

  const header = `<row r="1">${sheet.columns
    .map((column, index) => cellXml({ text: column.header }, index, 1, 1))
    .join('')}</row>`;

  const body = rows
    .map((cells, rowIndex) =>
      `<row r="${rowIndex + 2}">${cells
        .map((cell, columnIndex) => cellXml(cell, columnIndex, rowIndex + 2))
        .join('')}</row>`)
    .join('');

  // Widths come from the header and the first hundred rows rather than from all
  // of them: measuring forty thousand values to size a column costs more than
  // the column width is worth, and the first hundred are representative.
  const widths = sheet.columns.map((column, index) => {
    const sample = rows.slice(0, 100).map((cells) => {
      const cell = cells[index];
      return cell === undefined ? 0 : ('number' in cell ? String(cell.number) : cell.text).length;
    });
    const width = Math.min(Math.max(column.header.length + 2, ...sample, 8), 46);
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join('');

  const lastCell = reference(Math.max(sheet.columns.length - 1, 0), rows.length + 1);

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<dimension ref="A1:${lastCell}"/>`
    // Freezes the header row, so scrolling a long export keeps the column names.
    + '<sheetViews><sheetView workbookViewId="0">'
    + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
    + '</sheetView></sheetViews>'
    + `<cols>${widths}</cols>`
    + `<sheetData>${header}${body}</sheetData>`
    // Turns the header into a filter row, which is the first thing anybody does
    // to an exported table anyway.
    + `<autoFilter ref="A1:${lastCell}"/>`
    + '</worksheet>';
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
  + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
  + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
  + '</Types>';

const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
  + '</Relationships>';

const WORKBOOK_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '</Relationships>';

/** Two formats: the default, and a bold one for the header row. */
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border/></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
  + '</styleSheet>';

// ---------------------------------------------------------------------------
// The zip container.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = -1;
  for (const byte of data) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] as number);
  }
  return (crc ^ -1) >>> 0;
}

type Entry = { name: string; body: Buffer };

/**
 * Writes a zip with one deflated entry per part.
 *
 * Deliberately minimal: no directory entries, no zip64, no data descriptors,
 * and a fixed 1980 timestamp. A workbook whose bytes change every time it is
 * generated cannot be compared against a previous one, and nothing here needs to
 * record when it was written -- the report says that in its own columns.
 */
function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.body, { level: 9 });
    const checksum = crc32(entry.body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(20, 4);      // version needed to extract
    local.writeUInt16LE(0x0800, 6);  // flags: names and text are UTF-8
    local.writeUInt16LE(8, 8);       // method: deflate
    local.writeUInt16LE(0, 10);      // time
    local.writeUInt16LE(0x21, 12);   // date: 1980-01-01, fixed on purpose
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02_01_4b_50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(0x21, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(entry.body.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);

    offset += local.length + name.length + compressed.length;
  }

  const directoryBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directoryBytes, end]);
}

export function toXlsx<Row>(sheet: Sheet<Row>): Buffer {
  const name = escapeXml(safeSheetName(sheet.name));

  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  return zip([
    { name: '[Content_Types].xml', body: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', body: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'xl/workbook.xml', body: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', body: Buffer.from(WORKBOOK_RELS, 'utf8') },
    { name: 'xl/styles.xml', body: Buffer.from(STYLES, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', body: Buffer.from(sheetXml(sheet), 'utf8') },
  ]);
}
