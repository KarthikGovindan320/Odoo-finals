/**
 * Salary structures and rules.
 *
 * Read is separated from write by permission, which is exactly how the spec
 * defines the two payroll roles: HR Payroll User may look at the configuration,
 * HR Payroll Manager may change it.
 *
 * Formulas are validated by parsing them before they are stored, so a typo is
 * caught on the configuration screen rather than at 2am during a payrun.
 */
import { notFound } from '../errors/app_error.ts';
import { query, queryOne, withTransaction } from '../db/pool.ts';
import { createGuardedRouter } from './guarded_router.ts';
import { parseOrThrow, validateBody } from '../middleware/validate.ts';
import { identifier } from '../../../shared/schemas/common.ts';
import { salaryRuleInput, salaryStructureInput } from '../../../shared/schemas/payroll.ts';
import { parse } from '../services/payroll/expression/parser.ts';
import { ExpressionSyntaxError } from '../services/payroll/expression/lexer.ts';
import { AppError } from '../errors/app_error.ts';

const config = createGuardedRouter();

/** Parses without evaluating, so a malformed rule never reaches the database. */
function assertParses(expression: string | null | undefined, field: string, label: string): void {
  if (!expression) {
    return;
  }
  try {
    parse(expression);
  } catch (error) {
    if (error instanceof ExpressionSyntaxError) {
      throw new AppError(
        'validation_failed',
        `${label} is not a valid expression: ${error.message}`,
        { fields: [{ field, message: error.message }] },
      );
    }
    throw error;
  }
}

config.get('/structures', 'salary_config:read', async (_request, response) => {
  const rows = await query(
    `SELECT s.id, s.code, s.name, s.currency_code, s.description, s.is_active,
            (SELECT count(*)::int FROM salary_structure_rules sr WHERE sr.salary_structure_id = s.id) AS rule_count,
            (SELECT count(*)::int FROM contracts c
              WHERE c.salary_structure_id = s.id AND c.state = 'running') AS employee_count
       FROM salary_structures s
      ORDER BY s.name`,
  );
  response.json({ rows });
});

config.get('/structures/:id', 'salary_config:read', async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);
  const structure = await queryOne(
    'SELECT id, code, name, currency_code, description, is_active FROM salary_structures WHERE id = $1',
    [id],
  );
  if (structure === null) {
    throw notFound('Salary structure', id);
  }

  const rules = await query(
    `SELECT sr.id AS link_id, sr.sequence,
            r.id, r.code, r.name, r.computation_type, r.amount_fixed, r.percentage,
            r.percentage_base_code, r.formula_expression, r.condition_type,
            r.condition_expression, r.appears_on_payslip, r.note,
            c.code AS category_code, c.name AS category_name, c.sign AS category_sign
       FROM salary_structure_rules sr
       JOIN salary_rules r           ON r.id = sr.salary_rule_id
       JOIN salary_rule_categories c ON c.id = r.category_id
      WHERE sr.salary_structure_id = $1
      ORDER BY sr.sequence`,
    [id],
  );

  response.json({ ...(structure as object), rules });
});

config.post('/structures', 'salary_config:write', validateBody(salaryStructureInput), async (request, response) => {
  const input = request.body as typeof salaryStructureInput._output;

  const id = await withTransaction(async (client) => {
    const created = await client.queryOne<{ id: number }>(
      `INSERT INTO salary_structures (code, name, currency_code, description)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.code, input.name, input.currency_code, input.description ?? ''],
    );
    const structureId = (created as { id: number }).id;

    for (const rule of input.rules) {
      await client.query(
        `INSERT INTO salary_structure_rules (salary_structure_id, salary_rule_id, sequence)
         VALUES ($1, $2, $3)`,
        [structureId, rule.salary_rule_id, rule.sequence],
      );
    }
    return structureId;
  }, request.auth?.userId);

  response.status(201).json({ id });
});

config.patch('/structures/:id', 'salary_config:write', validateBody(salaryStructureInput), async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);
  const input = request.body as typeof salaryStructureInput._output;

  await withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE salary_structures SET code = $2, name = $3, currency_code = $4, description = $5
        WHERE id = $1 RETURNING id`,
      [id, input.code, input.name, input.currency_code, input.description ?? ''],
    );
    if (updated.length === 0) {
      throw notFound('Salary structure', id);
    }

    // Membership and sequence are replaced wholesale. Existing payslips are
    // unaffected -- their lines are snapshots, not references to this table.
    await client.query('DELETE FROM salary_structure_rules WHERE salary_structure_id = $1', [id]);
    for (const rule of input.rules) {
      await client.query(
        `INSERT INTO salary_structure_rules (salary_structure_id, salary_rule_id, sequence)
         VALUES ($1, $2, $3)`,
        [id, rule.salary_rule_id, rule.sequence],
      );
    }
  }, request.auth?.userId);

  response.json({ id });
});

config.get('/rules', 'salary_config:read', async (_request, response) => {
  const rows = await query(
    `SELECT r.id, r.code, r.name, r.computation_type, r.amount_fixed, r.percentage,
            r.percentage_base_code, r.formula_expression, r.condition_type,
            r.condition_expression, r.appears_on_payslip, r.is_active, r.note,
            r.category_id, c.code AS category_code, c.name AS category_name, c.sign AS category_sign,
            (SELECT count(*)::int FROM salary_structure_rules sr WHERE sr.salary_rule_id = r.id) AS structure_count
       FROM salary_rules r
       JOIN salary_rule_categories c ON c.id = r.category_id
      ORDER BY c.sequence, r.code`,
  );
  response.json({ rows });
});

config.post('/rules', 'salary_config:write', validateBody(salaryRuleInput), async (request, response) => {
  const input = request.body as typeof salaryRuleInput._output;
  assertParses(input.formula_expression, 'formula_expression', 'The formula');
  assertParses(input.condition_expression, 'condition_expression', 'The condition');

  const row = await withTransaction(
    (client) =>
      client.queryOne<{ id: number }>(
        `INSERT INTO salary_rules
           (code, name, category_id, computation_type, amount_fixed, percentage,
            percentage_base_code, formula_expression, condition_type, condition_expression,
            appears_on_payslip, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          input.code, input.name, input.category_id, input.computation_type,
          input.amount_fixed ?? null, input.percentage ?? null, input.percentage_base_code || null,
          input.formula_expression || null, input.condition_type, input.condition_expression || null,
          input.appears_on_payslip, input.note ?? '',
        ],
      ),
    request.auth?.userId,
  );

  response.status(201).json(row);
});

config.patch('/rules/:id', 'salary_config:write', validateBody(salaryRuleInput), async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);
  const input = request.body as typeof salaryRuleInput._output;
  assertParses(input.formula_expression, 'formula_expression', 'The formula');
  assertParses(input.condition_expression, 'condition_expression', 'The condition');

  await withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE salary_rules
          SET code = $2, name = $3, category_id = $4, computation_type = $5,
              amount_fixed = $6, percentage = $7, percentage_base_code = $8,
              formula_expression = $9, condition_type = $10, condition_expression = $11,
              appears_on_payslip = $12, note = $13
        WHERE id = $1 RETURNING id`,
      [
        id, input.code, input.name, input.category_id, input.computation_type,
        input.amount_fixed ?? null, input.percentage ?? null, input.percentage_base_code || null,
        input.formula_expression || null, input.condition_type, input.condition_expression || null,
        input.appears_on_payslip, input.note ?? '',
      ],
    );
    if (updated.length === 0) {
      throw notFound('Salary rule', id);
    }
  }, request.auth?.userId);

  response.json({ id });
});

export const salaryConfigRouter = config.router;
