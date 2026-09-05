/** Payload schemas for salary configuration and payrun processing. */
import { z } from 'zod';

import { identifier, isoDate, optionalText, requiredText } from './common.ts';

export const salaryRuleInput = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]*$/, 'A rule code is uppercase letters, digits and underscores, e.g. HRA_METRO.')
    .max(30),
  name: requiredText('Rule name', 120),
  category_id: identifier,
  computation_type: z.enum(['fixed', 'percentage', 'formula']),
  amount_fixed: z.coerce.number().nullable().optional(),
  percentage: z.coerce.number().min(-1000).max(1000).nullable().optional(),
  percentage_base_code: z.string().trim().max(30).nullable().optional(),
  formula_expression: z.string().trim().max(500).nullable().optional(),
  condition_type: z.enum(['always', 'formula']).default('always'),
  condition_expression: z.string().trim().max(500).nullable().optional(),
  appears_on_payslip: z.boolean().default(true),
  note: optionalText(500),
}).superRefine((value, ctx) => {
  // Mirrors the check constraints on salary_rules: each computation type must
  // carry the inputs it needs, so the form says so before the database does.
  if (value.computation_type === 'fixed' && value.amount_fixed == null) {
    ctx.addIssue({ code: 'custom', path: ['amount_fixed'], message: 'A fixed rule needs an amount.' });
  }
  if (value.computation_type === 'percentage') {
    if (value.percentage == null) {
      ctx.addIssue({ code: 'custom', path: ['percentage'], message: 'A percentage rule needs a rate.' });
    }
    if (!value.percentage_base_code) {
      ctx.addIssue({
        code: 'custom',
        path: ['percentage_base_code'],
        message: 'A percentage rule needs a base — the code of an earlier rule or category, e.g. BASIC.',
      });
    }
  }
  if (value.computation_type === 'formula' && !value.formula_expression) {
    ctx.addIssue({
      code: 'custom',
      path: ['formula_expression'],
      message: 'A formula rule needs an expression, e.g. contract.wage * 0.4',
    });
  }
  if (value.condition_type === 'formula' && !value.condition_expression) {
    ctx.addIssue({
      code: 'custom',
      path: ['condition_expression'],
      message: 'A conditional rule needs a condition, e.g. worked.overtime_hours > 0',
    });
  }
});

export const salaryStructureInput = z.object({
  code: requiredText('Structure code', 30),
  name: requiredText('Structure name', 120),
  currency_code: z.string().trim().regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, e.g. INR.').default('INR'),
  description: optionalText(500),
  rules: z
    .array(z.object({ salary_rule_id: identifier, sequence: z.coerce.number().int().positive() }))
    .default([]),
}).superRefine((value, ctx) => {
  const sequences = value.rules.map((rule) => rule.sequence);
  if (new Set(sequences).size !== sequences.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['rules'],
      message: 'Two rules cannot share the same sequence number — the sequence decides execution order.',
    });
  }
});

/** Step 1 of the payrun wizard. Creates nothing; it only scopes the search. */
export const payrunScopeInput = z.object({
  salary_structure_id: identifier,
  period_start: isoDate,
  period_end: isoDate,
  scope_department_id: identifier.nullable().optional(),
  scope_employment_type_id: identifier.nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.period_end < value.period_start) {
    ctx.addIssue({
      code: 'custom',
      path: ['period_end'],
      message: 'A payroll period cannot end before it starts.',
    });
  }
});

/** Step 2 adds the explicit employee selection and actually creates the batch. */
export const payrunCreateInput = payrunScopeInput.safeExtend({
  name: requiredText('Payrun name', 60),
  employee_ids: z.array(identifier).min(1, 'Select at least one employee to include in this payrun.'),
});

export type SalaryRuleInput = z.infer<typeof salaryRuleInput>;
export type SalaryStructureInput = z.infer<typeof salaryStructureInput>;
export type PayrunScopeInput = z.infer<typeof payrunScopeInput>;
export type PayrunCreateInput = z.infer<typeof payrunCreateInput>;
