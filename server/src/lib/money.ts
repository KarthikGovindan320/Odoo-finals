/**
 * Money arithmetic for payroll.
 *
 * Every salary rule's result is rounded to two decimals the moment it is
 * computed, and the rounded value is what later rules read. Rounding once at the
 * end instead would let the printed lines fail to sum to the printed total --
 * the one failure a payslip cannot survive.
 *
 * JavaScript's Math.round is half-up on the number line, which rounds -0.5 to -0.
 * Payroll wants half-away-from-zero so that a deduction and an earning of the
 * same magnitude round symmetrically, hence the explicit sign handling.
 *
 * The epsilon nudge corrects the classic binary-float artefact where a value that
 * is mathematically 1.005 is stored as 1.00499999999999989, which would round
 * down and lose a paisa.
 */
const MINOR_UNITS = 100;
const EPSILON = 1e-9;

export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot round a non-finite amount: ${value}`);
  }

  const scaled = value * MINOR_UNITS;
  const sign = scaled < 0 ? -1 : 1;
  const magnitude = Math.abs(scaled);

  return (sign * Math.round(magnitude + EPSILON)) / MINOR_UNITS;
}

/** Formats an amount for display. Grouping follows the Indian numbering system. */
export function formatMoney(value: number, currencyCode = 'INR'): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: 2,
  }).format(value);
}

/**
 * The same amount, written for a PDF: 'INR 1,23,456.50' rather than
 * '₹1,23,456.50'.
 *
 * PDFKit's built-in Helvetica is WinAnsi-encoded and has no glyph for U+20B9.
 * Asked to draw one it emits byte 0xB9, which renders as a superscript one — so
 * every amount on every payslip printed as '¹1,23,456.50'.
 *
 * The alternative is embedding a Unicode TTF, which means either shipping a
 * binary font in the repository or reading one from a system path that is not
 * guaranteed to exist. Writing the ISO currency code costs nothing, is portable
 * to any machine, and is the conventional form on a formal financial document
 * anyway. The screen keeps the symbol, where the web font supports it.
 */
export function formatMoneyForPrint(value: number, currencyCode = 'INR'): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: currencyCode,
    currencyDisplay: 'code',
    minimumFractionDigits: 2,
  }).format(value);
}
