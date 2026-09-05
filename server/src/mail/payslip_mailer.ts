/**
 * Sends payslips by email.
 *
 * Points at Mailpit from docker-compose: real SMTP, real MIME, real attachments,
 * and no third-party mail provider to depend on or explain. The whole flow works
 * with the network unplugged, and the inbox is inspectable at localhost:8025.
 *
 * Every send is recorded in email_deliveries, success or failure. A bulk send of
 * sixty payslips where four bounce is a normal outcome, and the payroll officer
 * needs to know which four.
 */
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

import { config } from '../config/env.ts';
import { formatMoney } from '../lib/money.ts';

let cachedTransport: Transporter | null = null;

function transport(): Transporter {
  if (cachedTransport === null) {
    cachedTransport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      // Mailpit speaks plain SMTP on the local network. There is no credential to
      // send and nothing to negotiate.
      secure: false,
      ignoreTLS: true,
    });
  }
  return cachedTransport;
}

export type PayslipMail = {
  toEmail: string;
  employeeName: string;
  payslipNumber: string;
  periodStart: string;
  periodEnd: string;
  netAmount: number;
  currencyCode: string;
  pdf: Buffer;
};

export type DeliveryOutcome = {
  toEmail: string;
  subject: string;
  status: 'sent' | 'failed';
  errorMessage: string | null;
};

export async function sendPayslip(mail: PayslipMail): Promise<DeliveryOutcome> {
  const subject = `Payslip ${mail.payslipNumber} — ${mail.periodStart} to ${mail.periodEnd}`;

  try {
    await transport().sendMail({
      from: config.smtp.from,
      to: mail.toEmail,
      subject,
      text:
        `Hello ${mail.employeeName},\n\n` +
        `Your payslip for ${mail.periodStart} to ${mail.periodEnd} is attached.\n\n` +
        `Net payable: ${formatMoney(mail.netAmount, mail.currencyCode)}\n` +
        `Reference: ${mail.payslipNumber}\n\n` +
        'If anything looks wrong, reply to this message and the payroll team will review it.\n\n' +
        'PeoplePay360 Payroll',
      attachments: [
        {
          filename: `${mail.payslipNumber.replace(/\//g, '-')}.pdf`,
          content: mail.pdf,
          contentType: 'application/pdf',
        },
      ],
    });

    return { toEmail: mail.toEmail, subject, status: 'sent', errorMessage: null };
  } catch (error) {
    // A bounce is data, not a crash: the run continues and the failure is
    // recorded per recipient so it can be retried.
    return {
      toEmail: mail.toEmail,
      subject,
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : 'Unknown mail transport error.',
    };
  }
}
