/**
 * Renders a payslip to PDF.
 *
 * PDFKit rather than headless Chrome: no browser binary to install, no page to
 * render, and generating 60 payslips for a bulk email is the same code path as
 * printing one. It streams into a Buffer so the caller can either send it as a
 * download or attach it to mail without touching the filesystem.
 *
 * Everything drawn here comes from the payslip's own snapshot columns, never from
 * live salary rules -- reprinting a June payslip in September must produce the
 * June document.
 */
import PDFDocument from 'pdfkit';

import { formatMoneyForPrint } from '../lib/money.ts';

export type PayslipDocumentData = {
  number: string;
  period_start: string;
  period_end: string;
  state: string;
  currency_code: string;
  employee_name: string;
  employee_number: string;
  department_name: string | null;
  job_title: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  contract_reference: string | null;
  structure_name: string;
  scheduled_days: number;
  worked_days: number;
  worked_hours: number;
  paid_leave_days: number;
  unpaid_leave_days: number;
  overtime_hours: number;
  gross_amount: number;
  net_amount: number;
  lines: Array<{
    rule_code: string;
    rule_name: string;
    category_code: string;
    category_sign: number;
    amount: number;
    source_expression: string;
  }>;
};

/** Lowest y a line may start at before the page is full. */
const LAST_LINE_Y = 700;

/** Height of the Gross row plus the net box, kept together on one page. */
const TOTALS_BLOCK_HEIGHT = 60;

const PLUM = '#714B67';
const TEAL = '#017E84';
const GRAY_600 = '#6C757D';
const GRAY_200 = '#E9ECEF';
const GRAY_900 = '#212529';

export function renderPayslipPdf(data: PayslipDocumentData): Promise<Buffer> {
  const document = new PDFDocument({ size: 'A4', margin: 48 });
  const chunks: Buffer[] = [];

  return new Promise((resolve, reject) => {
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);

    drawDocument(document, data);
    document.end();
  });
}

function drawDocument(document: PDFKit.PDFDocument, data: PayslipDocumentData): void {
  const left = 48;
  const right = 547;

  document.fillColor(PLUM).fontSize(18).font('Helvetica-Bold').text('PeoplePay360', left, 48);
  document.fillColor(GRAY_600).fontSize(9).font('Helvetica')
    .text('Payroll Statement', left, 70);

  document.fillColor(GRAY_900).fontSize(14).font('Helvetica-Bold')
    .text(data.number, left, 48, { width: right - left, align: 'right' });
  document.fillColor(GRAY_600).fontSize(9).font('Helvetica')
    .text(`${data.period_start} to ${data.period_end}`, left, 68, { width: right - left, align: 'right' })
    .text(data.state.toUpperCase(), left, 81, { width: right - left, align: 'right' });

  horizontalRule(document, 102);

  // Employee block
  let cursor = 118;
  document.fillColor(GRAY_600).fontSize(8).font('Helvetica-Bold').text('EMPLOYEE', left, cursor);
  cursor += 14;
  document.fillColor(GRAY_900).fontSize(11).font('Helvetica-Bold').text(data.employee_name, left, cursor);
  cursor += 15;

  const details: Array<[string, string]> = [
    ['Employee number', data.employee_number],
    ['Department', data.department_name ?? '—'],
    ['Position', data.job_title ?? '—'],
    ['Contract', data.contract_reference ?? '—'],
    ['Salary structure', data.structure_name],
    ['Bank', data.bank_account_number ? `${data.bank_name ?? ''} ····${data.bank_account_number.slice(-4)}` : 'Not on file'],
  ];

  document.fontSize(9).font('Helvetica');
  for (const [label, value] of details) {
    document.fillColor(GRAY_600).text(label, left, cursor, { width: 120 });
    document.fillColor(GRAY_900).text(value, left + 130, cursor, { width: 200 });
    cursor += 14;
  }

  // Worked-time block, in the right column
  let timeCursor = 118;
  document.fillColor(GRAY_600).fontSize(8).font('Helvetica-Bold').text('WORKED TIME', 330, timeCursor);
  timeCursor += 14;

  const timeRows: Array<[string, string]> = [
    ['Scheduled days', String(data.scheduled_days)],
    ['Worked days', String(data.worked_days)],
    ['Worked hours', String(data.worked_hours)],
    ['Paid leave days', String(data.paid_leave_days)],
    ['Unpaid leave days', String(data.unpaid_leave_days)],
    ['Overtime hours', String(data.overtime_hours)],
  ];

  document.fontSize(9).font('Helvetica');
  for (const [label, value] of timeRows) {
    document.fillColor(GRAY_600).text(label, 330, timeCursor, { width: 130 });
    document.fillColor(GRAY_900).text(value, 460, timeCursor, { width: 87, align: 'right' });
    timeCursor += 14;
  }

  cursor = Math.max(cursor, timeCursor) + 16;
  horizontalRule(document, cursor);
  cursor += 14;

  document.fillColor(GRAY_600).fontSize(8).font('Helvetica-Bold')
    .text('SALARY COMPUTATION', left, cursor);
  cursor += 18;

  document.fontSize(8).fillColor(GRAY_600)
    .text('CODE', left, cursor, { width: 60 })
    .text('DESCRIPTION', left + 62, cursor, { width: 240 })
    .text('CATEGORY', left + 305, cursor, { width: 90 })
    .text('AMOUNT', 460, cursor, { width: 87, align: 'right' });
  cursor += 12;
  horizontalRule(document, cursor);
  cursor += 8;

  document.fontSize(9);
  for (const line of data.lines) {
    // Deductions are stored positive with sign -1; they print with a minus so the
    // column adds up the way a person reads it.
    const signed = line.category_sign * line.amount;
    const isTotal = line.category_code === 'GROSS' || line.category_code === 'NET';

    document.font(isTotal ? 'Helvetica-Bold' : 'Helvetica');
    document.fillColor(isTotal ? GRAY_900 : GRAY_600).text(line.rule_code, left, cursor, { width: 60 });
    document.fillColor(GRAY_900).text(line.rule_name, left + 62, cursor, { width: 240 });
    document.fillColor(GRAY_600).text(line.category_code, left + 305, cursor, { width: 90 });
    document.fillColor(line.category_sign < 0 ? '#DC3545' : GRAY_900)
      .text(formatMoneyForPrint(signed, data.currency_code), 460, cursor, { width: 87, align: 'right' });

    cursor += 15;
    if (cursor > LAST_LINE_Y) {
      document.addPage();
      cursor = continuationHeader(document, data);
    }
  }

  // The totals block is 60pt tall including the net box. Checking only inside
  // the line loop meant a structure with enough rules ended near the bottom and
  // then drew Gross and NET PAYABLE over the footer.
  if (cursor + TOTALS_BLOCK_HEIGHT > LAST_LINE_Y) {
    document.addPage();
    cursor = continuationHeader(document, data);
  }

  cursor += 6;
  horizontalRule(document, cursor);
  cursor += 12;

  document.font('Helvetica').fontSize(9).fillColor(GRAY_600)
    .text('Gross', left + 305, cursor, { width: 90 });
  document.fillColor(GRAY_900)
    .text(formatMoneyForPrint(data.gross_amount, data.currency_code), 460, cursor, { width: 87, align: 'right' });
  cursor += 20;

  document.rect(left + 300, cursor - 6, 247, 28).fill(TEAL);
  document.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(11)
    .text('NET PAYABLE', left + 310, cursor + 2, { width: 100 })
    .text(formatMoneyForPrint(data.net_amount, data.currency_code), 440, cursor + 2, { width: 97, align: 'right' });

  document.fillColor(GRAY_600).font('Helvetica').fontSize(7)
    .text(
      'Computer-generated statement. Amounts are a snapshot taken when this payslip was computed ' +
      'and do not change if salary rules are edited later.',
      left, 780, { width: right - left, align: 'center' },
    );
}

/**
 * Identifies a continuation page and returns the y to resume drawing at.
 *
 * A payslip that runs to two pages previously carried nothing on the second but
 * the numbers -- no payslip number, no employee, no page marker -- so a loose
 * sheet could not be matched back to anyone.
 */
function continuationHeader(document: PDFKit.PDFDocument, data: PayslipDocumentData): number {
  document.fillColor(GRAY_600).fontSize(8).font('Helvetica')
    .text(`${data.number} — ${data.employee_name} (continued)`, 48, 40);
  horizontalRule(document, 54);
  return 68;
}

function horizontalRule(document: PDFKit.PDFDocument, y: number): void {
  document.moveTo(48, y).lineTo(547, y).lineWidth(0.5).strokeColor(GRAY_200).stroke();
}
