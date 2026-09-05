/**
 * Seeds a realistic company.
 *
 * Volume is the point. Filters, pagination, search and dashboard aggregates only
 * mean anything over data that has spread in it, and the spec's first demand of a
 * dashboard is that it show live metrics -- which requires there to be metrics.
 *
 * Run with: npm run db:seed   (or npm run db:reset to migrate from scratch first)
 */
import { withTransaction, closePool } from '../server/src/db/pool.ts';
import { createRandom } from './seeds/random.ts';
import { toIsoDate } from './seeds/dates.ts';
import { seedReferenceData } from './seeds/reference_data.ts';
import { DEMO_ACCOUNTS, DEMO_PASSWORD, seedPeople } from './seeds/people.ts';
import { seedAttendance, seedTimeOff } from './seeds/operations.ts';
import { seedPayrollHistory } from './seeds/payroll_history.ts';

const RANDOM_SEED = 20260905;
const MONTHS_OF_PAYROLL_HISTORY = 3;

async function main(): Promise<void> {
  const random = createRandom(RANDOM_SEED);
  const today = toIsoDate(new Date());

  await withTransaction(async (client) => {
    const existing = await client.queryOne<{ total: number }>(
      'SELECT count(*)::int AS total FROM employees',
    );
    if ((existing?.total ?? 0) > 0) {
      throw new Error(
        'The database already contains employees. Run `npm run db:reset` to rebuild it from scratch.',
      );
    }

    console.log('  reference data ...');
    const reference = await seedReferenceData(client);

    console.log('  employees and contracts ...');
    const { employees, contracts } = await seedPeople(client, reference, random, today);

    const adminUser = await client.queryOne<{ id: number }>(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'admin'`,
    );
    const hrUser = await client.queryOne<{ id: number }>(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'hr_manager'`,
    );
    const payrollUser = await client.queryOne<{ id: number }>(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'hr_payroll_manager'`,
    );

    console.log('  attendance ...');
    const attendanceRows = await seedAttendance(
      client, employees, random, today, (hrUser as { id: number }).id,
    );

    console.log('  time off ...');
    const timeOff = await seedTimeOff(
      client, reference, employees, random, today, (hrUser as { id: number }).id,
    );

    console.log('  payroll history ...');
    const payroll = await seedPayrollHistory(
      client,
      reference.salaryStructureIds.REGULAR as number,
      (payrollUser as { id: number }).id,
      today,
      MONTHS_OF_PAYROLL_HISTORY,
    );

    console.log('');
    console.log(`  ${employees.length} employees, ${contracts.length} contracts`);
    console.log(`  ${attendanceRows} attendance records`);
    console.log(
      `  ${timeOff.allocations} allocations, ${timeOff.requests} requests ` +
        `(${timeOff.approved} approved and consuming balance)`,
    );
    console.log(
      `  ${payroll.payruns} payruns, ${payroll.payslips} payslips, ` +
        `net paid ${payroll.totalNet.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`,
    );
    void adminUser;
  });

  console.log('');
  console.log('  Sign in with any of these (all share the same password):');
  for (const account of DEMO_ACCOUNTS) {
    console.log(`    ${account.email.padEnd(38)} ${account.role}`);
  }
  console.log(`    password: ${DEMO_PASSWORD}`);
}

main()
  .catch((error: unknown) => {
    console.error('\nseed failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
