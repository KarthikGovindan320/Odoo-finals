/**
 * Working schedules.
 *
 * Weekly hours are never accepted from the client. The schedule's lines are the
 * truth, a generated column turns each line into minutes, and a trigger sums them
 * into hours_per_week. A payload claiming 40 hours for a 20-hour pattern is
 * simply ignored, because there is no column to put it in.
 */
import { notFound } from '../errors/app_error.ts';
import { query, queryOne, withTransaction, insertedId } from '../db/pool.ts';
import { createGuardedRouter } from './guarded_router.ts';
import { parseOrThrow, validateBody } from '../middleware/validate.ts';
import { workingScheduleInput } from '../../../shared/schemas/hr.ts';
import { identifier } from '../../../shared/schemas/common.ts';

type ScheduleRow = {
  id: number;
  name: string;
  schedule_type: string;
  timezone: string;
  hours_per_week: number;
  employee_count: number;
};

const schedules = createGuardedRouter();

schedules.get('/', 'schedule:read', async (_request, response) => {
  const rows = await query<ScheduleRow>(
    `SELECT w.id, w.name, w.schedule_type, w.timezone, w.hours_per_week,
            (SELECT count(*)::int FROM employees e WHERE e.working_schedule_id = w.id) AS employee_count
       FROM working_schedules w
      WHERE w.is_active
      ORDER BY w.name`,
  );
  response.json({ rows });
});

schedules.get('/:id', 'schedule:read', async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);
  // employee_count used to be a literal 0 here, which the detail screen then
  // displayed as fact. Either report the real number or do not claim one.
  const schedule = await queryOne<ScheduleRow>(
    `SELECT w.id, w.name, w.schedule_type, w.timezone, w.hours_per_week,
            (SELECT count(*)::int FROM employees e WHERE e.working_schedule_id = w.id)
              AS employee_count
       FROM working_schedules w WHERE w.id = $1`,
    [id],
  );
  if (schedule === null) {
    throw notFound('Working schedule', id);
  }

  const lines = await query(
    `SELECT id, day_of_week, start_time::text, end_time::text, break_minutes, worked_minutes
       FROM working_schedule_lines WHERE working_schedule_id = $1
      ORDER BY day_of_week, start_time`,
    [id],
  );

  response.json({ ...schedule, lines });
});

schedules.post('/', 'schedule:write', validateBody(workingScheduleInput), async (request, response) => {
  const input = request.body as typeof workingScheduleInput._output;

  const id = await withTransaction(async (client) => {
    const created = await client.queryOne<{ id: number }>(
      `INSERT INTO working_schedules (name, schedule_type, timezone)
       VALUES ($1, $2, $3) RETURNING id`,
      [input.name, input.schedule_type, input.timezone],
    );
    const scheduleId = insertedId(created, 'a working schedule');

    for (const line of input.lines) {
      await client.query(
        `INSERT INTO working_schedule_lines
           (working_schedule_id, day_of_week, start_time, end_time, break_minutes)
         VALUES ($1, $2, $3, $4, $5)`,
        [scheduleId, line.day_of_week, line.start_time, line.end_time, line.break_minutes],
      );
    }
    return scheduleId;
  }, request.auth?.userId);

  const created = await queryOne(
    'SELECT id, name, schedule_type, timezone, hours_per_week FROM working_schedules WHERE id = $1',
    [id],
  );
  response.status(201).json(created);
});

schedules.patch('/:id', 'schedule:write', validateBody(workingScheduleInput), async (request, response) => {
  const id = parseOrThrow(identifier, request.params.id);
  const input = request.body as typeof workingScheduleInput._output;

  await withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE working_schedules SET name = $2, schedule_type = $3, timezone = $4
        WHERE id = $1 RETURNING id`,
      [id, input.name, input.schedule_type, input.timezone],
    );
    if (updated.length === 0) {
      throw notFound('Working schedule', id);
    }

    // Replacing the lines wholesale keeps the trigger's arithmetic simple and
    // means a removed day cannot survive as a stale row.
    await client.query('DELETE FROM working_schedule_lines WHERE working_schedule_id = $1', [id]);
    for (const line of input.lines) {
      await client.query(
        `INSERT INTO working_schedule_lines
           (working_schedule_id, day_of_week, start_time, end_time, break_minutes)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, line.day_of_week, line.start_time, line.end_time, line.break_minutes],
      );
    }
  }, request.auth?.userId);

  response.json(
    await queryOne(
      'SELECT id, name, schedule_type, timezone, hours_per_week FROM working_schedules WHERE id = $1',
      [id],
    ),
  );
});

export const scheduleRouter = schedules.router;
