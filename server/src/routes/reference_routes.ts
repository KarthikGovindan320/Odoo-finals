/**
 * Read-only lookups that populate every dropdown in the UI: departments, job
 * positions, employment types, working schedules, time off types, salary
 * structures. One request fills a whole form.
 */
import { query } from '../db/pool.ts';
import { createGuardedRouter } from './guarded_router.ts';

const reference = createGuardedRouter();

reference.get('/', 'employee:read', async (_request, response) => {
  const [departments, jobPositions, employmentTypes, schedules, timeOffTypes, structures, categories] =
    await Promise.all([
      query(`SELECT id, code, name, manager_employee_id FROM departments WHERE is_active ORDER BY name`),
      query(`SELECT id, title, department_id FROM job_positions WHERE is_active ORDER BY title`),
      query(`SELECT id, code, name FROM employment_types WHERE is_active ORDER BY id`),
      query(`SELECT id, name, schedule_type, hours_per_week FROM working_schedules WHERE is_active ORDER BY name`),
      query(`SELECT id, code, name, unit, requires_allocation, is_paid, color_token
               FROM time_off_types WHERE is_active ORDER BY name`),
      query(`SELECT id, code, name, currency_code FROM salary_structures WHERE is_active ORDER BY name`),
      query(`SELECT id, code, name, sequence, sign FROM salary_rule_categories ORDER BY sequence`),
    ]);

  response.json({
    departments,
    job_positions: jobPositions,
    employment_types: employmentTypes,
    working_schedules: schedules,
    time_off_types: timeOffTypes,
    salary_structures: structures,
    salary_rule_categories: categories,
  });
});

export const referenceRouter = reference.router;
