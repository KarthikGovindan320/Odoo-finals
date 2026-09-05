/**
 * Configuration a working HR department would have set up before anyone is
 * hired: departments, positions, schedules, leave policy and salary structures.
 *
 * The salary rules here are the demo's whole point, so they are chosen to
 * exercise every computation type and to make the dependency chain visible:
 * a percentage that reads an earlier rule, a formula that reads a category total,
 * a statutory cap that needs min(), and two conditional rules that only appear
 * when something actually happened.
 */
import type { TransactionClient } from '../../server/src/db/pool.ts';

export type ReferenceIds = {
  departmentIds: Record<string, number>;
  jobPositionIds: Record<string, number>;
  employmentTypeIds: Record<string, number>;
  scheduleIds: Record<string, number>;
  timeOffTypeIds: Record<string, number>;
  salaryStructureIds: Record<string, number>;
};

const DEPARTMENTS = [
  { code: 'ENG', name: 'Engineering' },
  { code: 'SAL', name: 'Sales' },
  { code: 'FIN', name: 'Finance' },
  { code: 'HR', name: 'People Operations' },
  { code: 'MKT', name: 'Marketing' },
  { code: 'SUP', name: 'Customer Support' },
];

const JOB_POSITIONS: Array<{ title: string; department: string }> = [
  { title: 'Software Engineer', department: 'ENG' },
  { title: 'Senior Software Engineer', department: 'ENG' },
  { title: 'Engineering Manager', department: 'ENG' },
  { title: 'QA Engineer', department: 'ENG' },
  { title: 'Account Executive', department: 'SAL' },
  { title: 'Sales Manager', department: 'SAL' },
  { title: 'Accountant', department: 'FIN' },
  { title: 'Finance Manager', department: 'FIN' },
  { title: 'HR Generalist', department: 'HR' },
  { title: 'HR Manager', department: 'HR' },
  { title: 'Marketing Associate', department: 'MKT' },
  { title: 'Content Strategist', department: 'MKT' },
  { title: 'Support Specialist', department: 'SUP' },
  { title: 'Support Lead', department: 'SUP' },
];

/** day_of_week, start, end, break minutes. 1 = Monday. */
const SCHEDULES: Array<{
  name: string;
  type: string;
  lines: Array<[number, string, string, number]>;
}> = [
  {
    name: 'Standard 40 Hours',
    type: 'full_time',
    lines: [1, 2, 3, 4, 5].map((day) => [day, '09:00', '18:00', 60] as [number, string, string, number]),
  },
  {
    name: 'Four Day Week',
    type: 'full_time',
    lines: [1, 2, 3, 4].map((day) => [day, '09:00', '19:00', 60] as [number, string, string, number]),
  },
  {
    name: 'Part Time Mornings',
    type: 'part_time',
    lines: [1, 2, 3, 4, 5].map((day) => [day, '09:00', '13:00', 0] as [number, string, string, number]),
  },
  {
    name: 'Support Shift',
    type: 'full_time',
    lines: [
      [1, '12:00', '21:00', 45],
      [2, '12:00', '21:00', 45],
      [3, '12:00', '21:00', 45],
      [4, '12:00', '21:00', 45],
      [6, '10:00', '18:00', 45],
    ],
  },
];

const TIME_OFF_TYPES = [
  { code: 'PAID', name: 'Paid Time Off', unit: 'day', allocation: true, paid: true, color: 'teal' },
  { code: 'SICK', name: 'Sick Leave', unit: 'day', allocation: true, paid: true, color: 'amber' },
  { code: 'CASUAL', name: 'Casual Leave', unit: 'day', allocation: true, paid: true, color: 'plum' },
  { code: 'UNPAID', name: 'Unpaid Leave', unit: 'day', allocation: false, paid: false, color: 'gray' },
  { code: 'PARENTAL', name: 'Parental Leave', unit: 'day', allocation: true, paid: true, color: 'indigo' },
  { code: 'COMP', name: 'Compensatory Off', unit: 'day', allocation: true, paid: true, color: 'green' },
];

type RuleSeed = {
  code: string;
  name: string;
  category: string;
  sequence: number;
  computation: 'fixed' | 'percentage' | 'formula';
  amount?: number;
  percentage?: number;
  base?: string;
  formula?: string;
  condition?: string;
  note: string;
};

const REGULAR_SALARY_RULES: RuleSeed[] = [
  {
    code: 'BASIC', name: 'Basic Salary', category: 'BASIC', sequence: 10, computation: 'formula',
    formula: 'contract.wage * (worked.paid_days / worked.scheduled_days)',
    note: 'Contract wage prorated by paid days over scheduled days, so a mid-month joiner is paid for what they worked.',
  },
  {
    code: 'HRA', name: 'House Rent Allowance', category: 'ALW', sequence: 20, computation: 'percentage',
    percentage: 40, base: 'BASIC',
    note: 'A percentage of an earlier rule. Demonstrates that sequence is a dependency, not just a sort order.',
  },
  {
    code: 'CONV', name: 'Conveyance Allowance', category: 'ALW', sequence: 30, computation: 'fixed',
    amount: 1600,
    note: 'Flat monthly amount, unaffected by attendance.',
  },
  {
    code: 'OT', name: 'Overtime', category: 'ALW', sequence: 40, computation: 'formula',
    formula: 'worked.overtime_hours * (contract.wage / (contract.schedule_hours_per_week * 4.33))',
    condition: 'worked.overtime_hours > 0',
    note: 'Hourly rate derived from the schedule. Conditional, so it appears only when overtime was actually worked.',
  },
  {
    code: 'GROSS', name: 'Gross Salary', category: 'GROSS', sequence: 50, computation: 'formula',
    formula: 'categories.BASIC + categories.ALW',
    note: 'Reads category totals rather than named rules, so adding an allowance needs no change here.',
  },
  {
    code: 'PF', name: 'Provident Fund', category: 'DED', sequence: 60, computation: 'formula',
    formula: 'min(rules.BASIC * 0.12, 1800)',
    note: 'Twelve percent of basic, capped at the statutory ceiling. The reason the language needs min().',
  },
  {
    code: 'PT', name: 'Professional Tax', category: 'DED', sequence: 70, computation: 'fixed',
    amount: 200,
    note: 'Flat state levy.',
  },
  {
    code: 'LWP', name: 'Loss of Pay', category: 'DED', sequence: 80, computation: 'formula',
    formula: '(contract.wage / worked.scheduled_days) * worked.unpaid_leave_days',
    condition: 'worked.unpaid_leave_days > 0',
    note: 'Where approved unpaid time off reaches payroll. One number touching four modules.',
  },
  {
    code: 'NET', name: 'Net Salary', category: 'NET', sequence: 90, computation: 'formula',
    formula: 'categories.GROSS - categories.DED',
    note: 'Deductions are stored positive and subtracted here, so a payslip reads the way people expect.',
  },
];

const INTERN_STIPEND_RULES: RuleSeed[] = [
  {
    code: 'STIPEND', name: 'Monthly Stipend', category: 'BASIC', sequence: 10, computation: 'formula',
    formula: 'contract.wage * (worked.paid_days / worked.scheduled_days)',
    note: 'Interns are paid a prorated stipend with no allowances.',
  },
  {
    code: 'INTERN_GROSS', name: 'Gross Stipend', category: 'GROSS', sequence: 20, computation: 'formula',
    formula: 'categories.BASIC',
    note: 'No allowances apply, so gross equals basic.',
  },
  {
    code: 'INTERN_PT', name: 'Professional Tax', category: 'DED', sequence: 30, computation: 'fixed',
    amount: 200,
    note: 'The one deduction that still applies.',
  },
  {
    code: 'INTERN_NET', name: 'Net Stipend', category: 'NET', sequence: 40, computation: 'formula',
    formula: 'categories.GROSS - categories.DED',
    note: 'Same shape as the regular structure, so the engine needs no special case.',
  },
];

async function insertRules(
  client: TransactionClient,
  structureId: number,
  rules: RuleSeed[],
): Promise<void> {
  const categories = await client.query<{ id: number; code: string }>(
    'SELECT id, code FROM salary_rule_categories',
  );
  const categoryIdByCode = new Map(categories.map((row) => [row.code, row.id]));

  for (const rule of rules) {
    const [inserted] = await client.query<{ id: number }>(
      `INSERT INTO salary_rules
         (code, name, category_id, computation_type, amount_fixed, percentage,
          percentage_base_code, formula_expression, condition_type, condition_expression, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        rule.code,
        rule.name,
        categoryIdByCode.get(rule.category) as number,
        rule.computation,
        rule.amount ?? null,
        rule.percentage ?? null,
        rule.base ?? null,
        rule.formula ?? null,
        rule.condition === undefined ? 'always' : 'formula',
        rule.condition ?? null,
        rule.note,
      ],
    );

    await client.query(
      `INSERT INTO salary_structure_rules (salary_structure_id, salary_rule_id, sequence)
       VALUES ($1, $2, $3)`,
      [structureId, (inserted as { id: number }).id, rule.sequence],
    );
  }
}

export async function seedReferenceData(client: TransactionClient): Promise<ReferenceIds> {
  const departmentIds: Record<string, number> = {};
  for (const department of DEPARTMENTS) {
    const [row] = await client.query<{ id: number }>(
      'INSERT INTO departments (code, name) VALUES ($1, $2) RETURNING id',
      [department.code, department.name],
    );
    departmentIds[department.code] = (row as { id: number }).id;
  }

  const jobPositionIds: Record<string, number> = {};
  for (const position of JOB_POSITIONS) {
    const [row] = await client.query<{ id: number }>(
      'INSERT INTO job_positions (title, department_id) VALUES ($1, $2) RETURNING id',
      [position.title, departmentIds[position.department] as number],
    );
    jobPositionIds[position.title] = (row as { id: number }).id;
  }

  const employmentTypes = await client.query<{ id: number; code: string }>(
    'SELECT id, code FROM employment_types',
  );
  const employmentTypeIds = Object.fromEntries(
    employmentTypes.map((row) => [row.code, row.id]),
  );

  const scheduleIds: Record<string, number> = {};
  for (const schedule of SCHEDULES) {
    const [row] = await client.query<{ id: number }>(
      'INSERT INTO working_schedules (name, schedule_type) VALUES ($1, $2) RETURNING id',
      [schedule.name, schedule.type],
    );
    const scheduleId = (row as { id: number }).id;
    scheduleIds[schedule.name] = scheduleId;

    for (const [day, start, end, breakMinutes] of schedule.lines) {
      await client.query(
        `INSERT INTO working_schedule_lines
           (working_schedule_id, day_of_week, start_time, end_time, break_minutes)
         VALUES ($1, $2, $3, $4, $5)`,
        [scheduleId, day, start, end, breakMinutes],
      );
    }
  }

  const timeOffTypeIds: Record<string, number> = {};
  for (const type of TIME_OFF_TYPES) {
    const [row] = await client.query<{ id: number }>(
      `INSERT INTO time_off_types
         (code, name, unit, requires_allocation, is_paid, payroll_rule_code, color_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        type.code,
        type.name,
        type.unit,
        type.allocation,
        type.paid,
        type.paid ? null : 'LWP',
        type.color,
      ],
    );
    timeOffTypeIds[type.code] = (row as { id: number }).id;
  }

  const salaryStructureIds: Record<string, number> = {};
  for (const structure of [
    { code: 'REGULAR', name: 'Regular Salary', description: 'Standard monthly payroll for salaried staff.', rules: REGULAR_SALARY_RULES },
    { code: 'INTERN', name: 'Intern Stipend', description: 'Simplified structure for interns: stipend and professional tax only.', rules: INTERN_STIPEND_RULES },
  ]) {
    const [row] = await client.query<{ id: number }>(
      'INSERT INTO salary_structures (code, name, description) VALUES ($1, $2, $3) RETURNING id',
      [structure.code, structure.name, structure.description],
    );
    const structureId = (row as { id: number }).id;
    salaryStructureIds[structure.code] = structureId;
    await insertRules(client, structureId, structure.rules);
  }

  return {
    departmentIds,
    jobPositionIds,
    employmentTypeIds,
    scheduleIds,
    timeOffTypeIds,
    salaryStructureIds,
  };
}
