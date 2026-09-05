/**
 * The shape of an exported table, independent of the file it becomes.
 *
 * One description of a report feeds both writers, so the CSV and the workbook
 * cannot drift into having different columns -- which is the failure people
 * notice only after they have reconciled two of them by hand.
 */
export type ColumnType = 'text' | 'number' | 'date';

export type SheetColumn<Row> = {
  header: string;
  type?: ColumnType;
  value: (row: Row) => string | number | null | undefined;
};

export type Sheet<Row> = {
  /** Becomes the worksheet tab name and the basis of the filename. */
  name: string;
  columns: SheetColumn<Row>[];
  rows: readonly Row[];
};

/**
 * Cells as the writers want them: a number stays a number so a spreadsheet can
 * total a column, and everything else is text.
 */
export type Cell = { text: string } | { number: number };

export function cellsFor<Row>(sheet: Sheet<Row>): Cell[][] {
  return sheet.rows.map((row) =>
    sheet.columns.map((column): Cell => {
      const raw = column.value(row);
      if (raw === null || raw === undefined || raw === '') return { text: '' };

      if (column.type === 'number') {
        const asNumber = typeof raw === 'number' ? raw : Number(raw);
        // A column declared numeric that turns out not to be is written as the
        // text it actually is, rather than as NaN or as a silent zero.
        return Number.isFinite(asNumber) ? { number: asNumber } : { text: String(raw) };
      }

      return { text: String(raw) };
    }));
}
