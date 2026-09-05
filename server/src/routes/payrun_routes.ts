/**
 * Payruns and payslips.
 *
 * The wizard's shape is deliberate and matches the spec closely: step 1 and step 2
 * are client state, /eligible-employees is a read-only preview that creates
 * nothing, and the batch springs into existence only on POST /payruns.
 */
import { z } from 'zod';

import { notFound, workflowViolation } from '../errors/app_error.ts';
import { query, queryOne, withTransaction } from '../db/pool.ts';
import type { QueryParameter } from '../db/pool.ts';
import { createGuardedRouter } from './guarded_router.ts';
import { requireOwnEmployee, scopedEmployeeId } from '../middleware/authorize.ts';
import { parseOrThrow, validateBody } from '../middleware/validate.ts';
import { identifier, paginationQuery } from '../../../shared/schemas/common.ts';
import { payrunCreateInput, payrunScopeInput } from '../../../shared/schemas/payroll.ts';
import { computePayrun } from '../services/payroll/payslip_service.ts';
import { explainPayslip } from '../services/payroll/explain.ts';
import type { PayrunRow } from '../services/payroll/payslip_service.ts';
import {
  createPayrun,
  findEligibleEmployees,
  markPayrunPaid,
  validatePayrun,
} from '../services/payroll/payrun_service.ts';
import { renderPayslipPdf } from '../pdf/payslip_document.ts';
import type { PayslipDocumentData } from '../pdf/payslip_document.ts';
import { sendPayslip } from '../mail/payslip_mailer.ts';

const payruns = createGuardedRouter();

async function loadPayrun(id: number): Promise<PayrunRow> {
  const payrun = await queryOne<PayrunRow>(
    `SELECT id, name, salary_structure_id, period_start::text, period_end::text, state
       FROM payruns WHERE id = $1`,
    [id],
  );
  if (payrun === null) {
    throw notFound('Payrun', id);
  }
  return payrun;
}

/**
 * A payrun is a batch, so "read a payrun" is not one question but two: may this
 * caller see the batch, and which of its payslips are theirs? A caller at scope
 * 'own' sees only the runs they appear in, and inside one, only their own row --
 * including in every aggregate, because a company-wide total is exactly the
 * figure the scope exists to withhold.
 */
payruns.get('/', 'payrun:read', async (request, response) => {
  const filters = parseOrThrow(
    paginationQuery.safeExtend({
      state: z.enum(['draft', 'computed', 'validated', 'paid', 'cancelled']).optional(),
    }),
    request.query,
  );

  const restrictTo = scopedEmployeeId(request);
  const params: QueryParameter[] = [];
  const conditions = ['true'];

  // Bound once and reused by every aggregate below, so a scoped caller cannot be
  // shown a count or a total that spans employees they may not see.
  let onlyMine = '';
  if (restrictTo !== null) {
    params.push(restrictTo);
    onlyMine = ` AND ps.employee_id = $${params.length}`;
    conditions.push(
      `EXISTS (SELECT 1 FROM payslips ps WHERE ps.payrun_id = p.id${onlyMine})`,
    );
  }

  if (filters.state) {
    params.push(filters.state);
    conditions.push(`p.state = $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    conditions.push(`p.name ILIKE $${params.length}`);
  }
  const where = conditions.join(' AND ');

  // Warnings belong to a payslip, so scoping them means scoping to the payslips
  // the caller may see rather than to the payrun.
  const warningScope =
    restrictTo === null
      ? ''
      : ` AND EXISTS (SELECT 1 FROM payslips ps
                       WHERE ps.id = w.payslip_id${onlyMine})`;

  const totalRow = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total FROM payruns p WHERE ${where}`,
    params,
  );

  const rows = await query(
    `SELECT p.id, p.name, p.period_start::text, p.period_end::text, p.state,
            s.name AS structure_name,
            (SELECT count(*)::int FROM payslips ps
              WHERE ps.payrun_id = p.id${onlyMine}) AS payslip_count,
            (SELECT COALESCE(SUM(ps.net_amount), 0) FROM payslips ps
              WHERE ps.payrun_id = p.id AND ps.state <> 'cancelled'${onlyMine}) AS total_net,
            (SELECT count(*)::int FROM payslip_warnings w
              WHERE w.payrun_id = p.id AND w.severity = 'blocker'${warningScope}) AS blocker_count,
            (SELECT count(*)::int FROM payslip_warnings w
              WHERE w.payrun_id = p.id AND w.severity = 'warning'${warningScope}) AS warning_count
       FROM payruns p
       JOIN salary_structures s ON s.id = p.salary_structure_id
      WHERE ${where}
      ORDER BY p.period_start DESC, p.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.page_size, (filters.page - 1) * filters.page_size],
  );

  response.json({
    rows, page: filters.page, page_size: filters.page_size, total: totalRow?.total ?? 0,
    total_pages: Math.max(Math.ceil((totalRow?.total ?? 0) / filters.page_size), 1),
  });
});

payruns.get('/:id', 'payrun:read', async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);
  const payrun = await loadPayrun(id);

  const restrictTo = scopedEmployeeId(request);
  const params: QueryParameter[] = [id];
  let onlyMine = '';
  if (restrictTo !== null) {
    params.push(restrictTo);
    onlyMine = ` AND ps.employee_id = $${params.length}`;
  }

  const [structure, payslips, warnings] = await Promise.all([
    queryOne('SELECT id, name, code FROM salary_structures WHERE id = $1', [payrun.salary_structure_id]),
    query(
      `SELECT ps.id, ps.number, ps.employee_id,
              e.first_name || ' ' || e.last_name AS employee_name,
              e.employee_number,
              d.name AS department_name,
              ps.state, ps.worked_days, ps.scheduled_days, ps.unpaid_leave_days,
              ps.overtime_hours, ps.gross_amount, ps.net_amount, ps.currency_code,
              c.reference AS contract_reference
         FROM payslips ps
         JOIN employees e ON e.id = ps.employee_id
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN contracts c   ON c.id = ps.contract_id
        WHERE ps.payrun_id = $1${onlyMine}
        ORDER BY e.employee_number`,
      params,
    ),
    query(
      `SELECT w.id, w.payslip_id, w.severity, w.code, w.message,
              ps.number AS payslip_number,
              e.first_name || ' ' || e.last_name AS employee_name
         FROM payslip_warnings w
         ${restrictTo === null ? 'LEFT JOIN' : 'JOIN'} payslips ps ON ps.id = w.payslip_id
         LEFT JOIN employees e ON e.id = ps.employee_id
        WHERE w.payrun_id = $1${onlyMine}
        ORDER BY CASE w.severity WHEN 'blocker' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, w.id`,
      params,
    ),
  ]);

  // A scoped caller with no payslip in this batch has nothing to see here. 404
  // rather than 403: whether a payrun they are not part of exists is itself not
  // theirs to learn.
  if (restrictTo !== null && payslips.length === 0) {
    throw notFound('Payrun', id);
  }

  response.json({ ...payrun, structure, payslips, warnings });
});

/** Wizard step 2. A preview: this endpoint writes nothing. */
payruns.post('/eligible-employees', 'payrun:write', validateBody(payrunScopeInput), async (request, response) => {
  const scope = request.body as typeof payrunScopeInput._output;

  const rows = await withTransaction((client) =>
    findEligibleEmployees(client, {
      periodStart: scope.period_start,
      periodEnd: scope.period_end,
      departmentId: scope.scope_department_id,
      employmentTypeId: scope.scope_employment_type_id,
    }),
  );

  response.json({
    rows,
    eligible_count: rows.filter((row) => row.is_eligible).length,
    ineligible_count: rows.filter((row) => !row.is_eligible).length,
  });
});

payruns.post('/', 'payrun:write', validateBody(payrunCreateInput), async (request, response) => {
  const input = request.body as typeof payrunCreateInput._output;

  const id = await withTransaction(
    (client) =>
      createPayrun(client, {
        name: input.name,
        salaryStructureId: input.salary_structure_id,
        periodStart: input.period_start,
        periodEnd: input.period_end,
        departmentId: input.scope_department_id,
        employmentTypeId: input.scope_employment_type_id,
        employeeIds: input.employee_ids,
        createdByUserId: request.auth?.userId ?? null,
      }),
    request.auth?.userId,
  );

  response.status(201).json({ id });
});

payruns.post('/:id/compute', 'payrun:write', async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);
  const payrun = await loadPayrun(id);

  const summary = await withTransaction(
    (client) => computePayrun(client, payrun),
    request.auth?.userId,
  );

  response.json(summary);
});

payruns.post('/:id/validate', 'payrun:validate', async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);
  const result = await withTransaction((client) => validatePayrun(client, id), request.auth?.userId);
  response.json({ id, state: 'validated', ...result });
});

payruns.post('/:id/mark-paid', 'payrun:validate', async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);
  const result = await withTransaction((client) => markPayrunPaid(client, id), request.auth?.userId);
  response.json({ id, state: 'paid', ...result });
});

payruns.post('/:id/send-payslips', 'payrun:validate', async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);
  const payrun = await loadPayrun(id);

  if (payrun.state !== 'validated' && payrun.state !== 'paid') {
    throw workflowViolation(
      'Payslips can only be sent once the payrun is validated. Draft figures are still subject to change.',
    );
  }

  const payslips = await query<{ id: number; work_email: string | null; already_sent: boolean }>(
    `SELECT ps.id, e.work_email,
            EXISTS (SELECT 1 FROM email_deliveries d
                     WHERE d.payslip_id = ps.id AND d.status = 'sent') AS already_sent
       FROM payslips ps
       JOIN employees e ON e.id = ps.employee_id
      WHERE ps.payrun_id = $1 AND ps.state IN ('validated', 'paid')
      ORDER BY e.employee_number`,
    [id],
  );

  // Skip anyone who already received theirs. Sending a second copy of a payslip
  // reads as a correction and generates support tickets.
  const alreadySent = payslips.filter((row) => row.already_sent);
  // An employee with no work email cannot be sent to. Reported separately rather
  // than counted as a failure, because nothing went wrong with the send -- there
  // is a gap in the employee record, and that is a different thing to fix.
  const undeliverable = payslips.filter(
    (row) => !row.already_sent && (row.work_email === null || row.work_email.trim() === ''),
  );
  const pending = payslips.filter(
    (row) => !row.already_sent && row.work_email !== null && row.work_email.trim() !== '',
  );

  const outcomes = {
    sent: 0,
    failed: 0,
    skipped: alreadySent.length,
    no_email: undeliverable.length,
  };

  for (const row of pending) {
    const data = await loadPayslipDocument(row.id);
    if (data === null) {
      continue;
    }

    const outcome = await sendPayslip({
      toEmail: row.work_email as string,
      employeeName: data.employee_name,
      payslipNumber: data.number,
      periodStart: data.period_start,
      periodEnd: data.period_end,
      netAmount: data.net_amount,
      currencyCode: data.currency_code,
      pdf: await renderPayslipPdf(data),
    });

    await withTransaction((client) =>
      client.query(
        `INSERT INTO email_deliveries (payslip_id, to_email, subject, status, error_message, sent_at)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 = 'sent' THEN now() ELSE NULL END)`,
        [row.id, outcome.toEmail, outcome.subject, outcome.status, outcome.errorMessage],
      ),
    );

    if (outcome.status === 'sent') {
      outcomes.sent += 1;
    } else {
      outcomes.failed += 1;
    }
  }

  response.json(outcomes);
});

export const payrunRouter = payruns.router;

/* ------------------------------------------------------------- payslips --- */

const payslips = createGuardedRouter();

async function loadPayslipDocument(id: number): Promise<PayslipDocumentData | null> {
  const payslip = await queryOne<PayslipDocumentData>(
    `SELECT ps.number, ps.period_start::text, ps.period_end::text, ps.state, ps.currency_code,
            e.first_name || ' ' || e.last_name AS employee_name,
            e.employee_number, e.bank_name, e.bank_account_number,
            d.name  AS department_name,
            j.title AS job_title,
            c.reference AS contract_reference,
            s.name  AS structure_name,
            ps.scheduled_days, ps.worked_days, ps.worked_hours,
            ps.paid_leave_days, ps.unpaid_leave_days, ps.overtime_hours,
            ps.gross_amount, ps.net_amount
       FROM payslips ps
       JOIN employees e ON e.id = ps.employee_id
       JOIN salary_structures s ON s.id = ps.salary_structure_id
       LEFT JOIN departments d   ON d.id = e.department_id
       LEFT JOIN job_positions j ON j.id = e.job_position_id
       LEFT JOIN contracts c     ON c.id = ps.contract_id
      WHERE ps.id = $1`,
    [id],
  );

  if (payslip === null) {
    return null;
  }

  const lines = await query<PayslipDocumentData['lines'][number]>(
    `SELECT rule_code, rule_name, category_code, category_sign, amount, source_expression
       FROM payslip_lines WHERE payslip_id = $1 ORDER BY sequence`,
    [id],
  );

  return { ...payslip, lines };
}

payslips.get('/', 'payrun:read', async (request, response) => {
  const filters = parseOrThrow(
    paginationQuery.safeExtend({
      employee_id: identifier.optional(),
      payrun_id: identifier.optional(),
      state: z.string().max(20).optional(),
    }),
    request.query,
  );

  const conditions = ['true'];
  const params: QueryParameter[] = [];

  const restrictTo = scopedEmployeeId(request) ?? filters.employee_id;
  if (restrictTo != null) {
    params.push(restrictTo);
    conditions.push(`ps.employee_id = $${params.length}`);
  }
  if (filters.payrun_id !== undefined) {
    params.push(filters.payrun_id);
    conditions.push(`ps.payrun_id = $${params.length}`);
  }
  if (filters.state) {
    params.push(filters.state);
    conditions.push(`ps.state = $${params.length}`);
  }

  const where = conditions.join(' AND ');
  const totalRow = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total FROM payslips ps WHERE ${where}`,
    params,
  );

  const rows = await query(
    `SELECT ps.id, ps.number, ps.employee_id,
            e.first_name || ' ' || e.last_name AS employee_name,
            e.employee_number,
            p.name AS payrun_name, s.name AS structure_name,
            ps.period_start::text, ps.period_end::text, ps.state,
            ps.worked_days, ps.gross_amount, ps.net_amount, ps.currency_code
       FROM payslips ps
       JOIN employees e ON e.id = ps.employee_id
       JOIN payruns p   ON p.id = ps.payrun_id
       JOIN salary_structures s ON s.id = ps.salary_structure_id
      WHERE ${where}
      ORDER BY ps.period_start DESC, e.employee_number
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.page_size, (filters.page - 1) * filters.page_size],
  );

  response.json({
    rows, page: filters.page, page_size: filters.page_size, total: totalRow?.total ?? 0,
    total_pages: Math.max(Math.ceil((totalRow?.total ?? 0) / filters.page_size), 1),
  });
});

payslips.get('/:id', 'payrun:read', async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);

  const payslip = await queryOne<{ employee_id: number }>(
    'SELECT employee_id FROM payslips WHERE id = $1',
    [id],
  );
  if (payslip === null) {
    throw notFound('Payslip', id);
  }
  requireOwnEmployee(request, payslip.employee_id);

  const detail = await loadPayslipDocument(id);
  const meta = await queryOne(
    `SELECT ps.id, ps.payrun_id, ps.employee_id, ps.contract_id, ps.proration_factor,
            p.name AS payrun_name, p.state AS payrun_state
       FROM payslips ps JOIN payruns p ON p.id = ps.payrun_id
      WHERE ps.id = $1`,
    [id],
  );

  response.json({ ...detail, ...(meta as object) });
});

payslips.get('/:id/pdf', 'payrun:read', async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);

  const owner = await queryOne<{ employee_id: number }>(
    'SELECT employee_id FROM payslips WHERE id = $1',
    [id],
  );
  if (owner === null) {
    throw notFound('Payslip', id);
  }
  requireOwnEmployee(request, owner.employee_id);

  const data = await loadPayslipDocument(id);
  if (data === null) {
    throw notFound('Payslip', id);
  }

  const pdf = await renderPayslipPdf(data);
  response.setHeader('Content-Type', 'application/pdf');
  response.setHeader(
    'Content-Disposition',
    `inline; filename="${data.number.replace(/\//g, '-')}.pdf"`,
  );
  response.send(pdf);
});

/**
 * The arithmetic behind one payslip.
 *
 * Guarded by requireOwnEmployee like the payslip itself rather than by a
 * payroll-only permission: the person best served by an explanation of a number
 * is the person it was paid to. An employee can already read this payslip, and
 * showing them how it was reached reveals nothing further about anyone else.
 */
payslips.get('/:id/explain', 'payrun:read', async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);

  const owner = await queryOne<{ employee_id: number }>(
    'SELECT employee_id FROM payslips WHERE id = $1',
    [id],
  );
  if (owner === null) {
    throw notFound('Payslip', id);
  }
  requireOwnEmployee(request, owner.employee_id);

  // Read-only, so no transaction: the pool helpers already satisfy the shape the
  // service asks for, and wrapping this in BEGIN/COMMIT would hold a connection
  // for a screen that only reads.
  response.json(await explainPayslip({ query, queryOne }, id));
});

export const payslipRouter = payslips.router;
