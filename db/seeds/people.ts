/**
 * Employees, their login accounts, and their contract history.
 *
 * Contract history is the point of this module. Roughly a third of employees have
 * had more than one contract -- a raise, a promotion, a move from intern to
 * full-time -- so the exclusion constraint is exercised by real data and the
 * "which contract applies to this period?" question has a non-trivial answer.
 *
 * Two employees are seeded without bank details on purpose, so the MISSING_BANK
 * warning fires during the demo rather than being described.
 */
import { hashPassword } from '../../server/src/lib/password.ts';
import type { TransactionClient } from '../../server/src/db/pool.ts';
import { addDays, addMonths, type IsoDate } from './dates.ts';
import type { Random } from './random.ts';
import type { ReferenceIds } from './reference_data.ts';

/**
 * Name pools, sized for the headcount they have to fill.
 *
 * At 350 employees a 32x16 pool produces the same handful of names over and
 * over, which makes every list on every screen look obviously generated. These
 * give roughly 5,000 combinations, so repeats are occasional rather than the
 * rule -- and a repeated full name is harmless anyway, since the employee number
 * is the key and the work email carries an index.
 */
const FIRST_NAMES = [
  'Aarav', 'Priya', 'Rohan', 'Ananya', 'Vikram', 'Meera', 'Arjun', 'Kavya',
  'Siddharth', 'Nisha', 'Rahul', 'Divya', 'Karthik', 'Sneha', 'Aditya', 'Pooja',
  'Manish', 'Ritu', 'Sanjay', 'Ishita', 'Nikhil', 'Tara', 'Varun', 'Lakshmi',
  'Rajesh', 'Anjali', 'Suresh', 'Deepa', 'Amit', 'Shreya', 'Gaurav', 'Neha',
  'Aditi', 'Harsh', 'Sanya', 'Yash', 'Trisha', 'Devan', 'Mitali', 'Kunal',
  'Rhea', 'Ishaan', 'Nandini', 'Abhay', 'Sarika', 'Vivek', 'Charu', 'Om',
  'Bhavna', 'Rishi', 'Kiara', 'Naveen', 'Sonal', 'Tarun', 'Ayesha', 'Girish',
  'Payal', 'Mohit', 'Swati', 'Dhruv', 'Renuka', 'Akash', 'Vaishali', 'Imran',
  'Leela', 'Pranav', 'Sunita', 'Aniket', 'Madhuri', 'Kabir', 'Jaya', 'Rohit',
  'Preeti', 'Sameer', 'Anushka', 'Vinay', 'Gitanjali', 'Nitin', 'Rukmini', 'Zoya',
];

const LAST_NAMES = [
  'Sharma', 'Nair', 'Patel', 'Reddy', 'Iyer', 'Menon', 'Gupta', 'Desai',
  'Kulkarni', 'Bose', 'Chatterjee', 'Rao', 'Joshi', 'Malhotra', 'Verma', 'Pillai',
  'Banerjee', 'Mehta', 'Kapoor', 'Shetty', 'Krishnan', 'Qureshi', 'Rangan', 'Dutta',
  'Sengupta', 'Ahluwalia', 'Chauhan', 'Bhatt', 'Naidu', 'Varghese', 'Thakur', 'Saxena',
  'Mukherjee', 'Raghavan', 'Deshpande', 'Sinha', 'Chandra', 'Bhalla', 'Kaul', 'Prasad',
  'Ganguly', 'Subramanian', 'Trivedi', 'Waghmare', 'Fernandes', 'Bhattacharya', 'Rastogi', 'Anand',
  'Chakraborty', 'Balakrishnan', 'Hegde', 'Vaidya', 'Sridhar', 'Lal', 'Purohit', 'Chopra',
  'Ramachandran', 'Dixit', 'Kamath', 'Nambiar', 'Sarkar', 'Bajaj', 'Venkatesan', 'Grewal',
];

const BANKS = ['State Bank of India', 'HDFC Bank', 'ICICI Bank', 'Axis Bank', 'Kotak Mahindra Bank'];

/** Headcount to generate. SEED_EMPLOYEES overrides it. */
const DEFAULT_EMPLOYEES = 350;

function employeeCountFromEnv(): number {
  const raw = process.env.SEED_EMPLOYEES;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_EMPLOYEES;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < DEMO_ACCOUNTS.length || value > 20_000) {
    throw new Error(
      `SEED_EMPLOYEES must be a whole number between ${DEMO_ACCOUNTS.length} and 20000, ` +
        `got '${raw}'. The lower bound is the number of demo accounts, which all have to exist.`,
    );
  }
  return value;
}

/** The accounts a judge logs in with. One per role, so RBAC can be demonstrated. */
export const DEMO_ACCOUNTS = [
  { email: 'admin@peoplepay360.local', role: 'admin', first: 'Devika', last: 'Rangan', position: 'HR Manager', department: 'HR' },
  { email: 'payroll.manager@peoplepay360.local', role: 'hr_payroll_manager', first: 'Anand', last: 'Krishnan', position: 'Finance Manager', department: 'FIN' },
  { email: 'payroll.user@peoplepay360.local', role: 'hr_payroll_user', first: 'Farah', last: 'Qureshi', position: 'Accountant', department: 'FIN' },
  { email: 'hr.manager@peoplepay360.local', role: 'hr_manager', first: 'Rohini', last: 'Shetty', position: 'HR Generalist', department: 'HR' },
  { email: 'employee@peoplepay360.local', role: 'employee', first: 'Priya', last: 'Nair', position: 'Software Engineer', department: 'ENG' },
] as const;

export const DEMO_PASSWORD = 'Password123!';

export type SeededEmployee = {
  id: number;
  employeeNumber: string;
  fullName: string;
  departmentCode: string;
  employmentTypeCode: string;
  scheduleId: number;
  hireDate: IsoDate;
};

export type SeededContract = {
  id: number;
  employeeId: number;
  startDate: IsoDate;
  endDate: IsoDate | null;
  wage: number;
  scheduleId: number;
  salaryStructureId: number;
};

const POSITIONS_BY_DEPARTMENT: Record<string, string[]> = {
  ENG: ['Software Engineer', 'Senior Software Engineer', 'QA Engineer', 'Engineering Manager'],
  SAL: ['Account Executive', 'Sales Manager'],
  FIN: ['Accountant', 'Finance Manager'],
  HR: ['HR Generalist', 'HR Manager'],
  MKT: ['Marketing Associate', 'Content Strategist'],
  SUP: ['Support Specialist', 'Support Lead'],
};

const BASE_WAGE_BY_POSITION: Record<string, number> = {
  'Software Engineer': 65000,
  'Senior Software Engineer': 105000,
  'Engineering Manager': 155000,
  'QA Engineer': 58000,
  'Account Executive': 62000,
  'Sales Manager': 125000,
  Accountant: 55000,
  'Finance Manager': 130000,
  'HR Generalist': 52000,
  'HR Manager': 118000,
  'Marketing Associate': 48000,
  'Content Strategist': 60000,
  'Support Specialist': 42000,
  'Support Lead': 78000,
};

export async function seedPeople(
  client: TransactionClient,
  reference: ReferenceIds,
  random: Random,
  today: IsoDate,
): Promise<{ employees: SeededEmployee[]; contracts: SeededContract[] }> {
  const roles = await client.query<{ id: number; code: string }>('SELECT id, code FROM roles');
  const roleIdByCode = new Map(roles.map((row) => [row.code, row.id]));

  // Every demo account shares one password hash computation; scrypt is
  // deliberately slow, and hashing it sixty times would dominate seed time.
  const demoCredentials = await hashPassword(DEMO_PASSWORD);

  const employees: SeededEmployee[] = [];
  const contracts: SeededContract[] = [];
  const departmentCodes = Object.keys(reference.departmentIds);

  // Configurable so the demo can be run at whatever size suits the machine.
  // Everything else -- contracts, attendance, leave, payroll history -- is
  // generated per employee, so this one number scales the whole database.
  const totalEmployees = employeeCountFromEnv();
  const scheduleNames = Object.keys(reference.scheduleIds);

  for (let index = 0; index < totalEmployees; index += 1) {
    const demo = DEMO_ACCOUNTS[index];
    const departmentCode = demo?.department ?? random.pick(departmentCodes);
    const positions = POSITIONS_BY_DEPARTMENT[departmentCode] as string[];
    const positionTitle = demo?.position ?? random.pick(positions);

    const firstName = demo?.first ?? random.pick(FIRST_NAMES);
    const lastName = demo?.last ?? random.pick(LAST_NAMES);

    // Interns and part-timers exist so the employee-type dashboard filter has
    // something to separate.
    const employmentTypeCode = demo
      ? 'full_time'
      : random.chance(0.08)
        ? 'intern'
        : random.chance(0.1)
          ? 'part_time'
          : random.chance(0.1)
            ? 'contract'
            : 'full_time';

    const scheduleName =
      employmentTypeCode === 'part_time'
        ? 'Part Time Mornings'
        : departmentCode === 'SUP'
          ? 'Support Shift'
          : random.chance(0.15)
            ? 'Four Day Week'
            : (scheduleNames[0] as string);
    const scheduleId = reference.scheduleIds[scheduleName] as number;

    // Hire dates spread over four years so seniority and contract history vary.
    // The day is jittered as well as the month: without it every employee in the
    // company appears to have been hired on the same day of the month, which is
    // the kind of detail that makes seeded data look seeded.
    const hireDate = addDays(addMonths(today, -random.int(2, 48)), random.int(-14, 13));

    let userId: number | null = null;
    if (demo !== undefined) {
      const [userRow] = await client.query<{ id: number }>(
        `INSERT INTO users (email, password_hash, password_salt, role_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [demo.email, demoCredentials.hash, demoCredentials.salt, roleIdByCode.get(demo.role) as number],
      );
      userId = (userRow as { id: number }).id;
    }

    // Two employees have no bank details, on purpose.
    const hasBankDetails = index !== 12 && index !== 27;

    // The number is issued by the database from the hire date, the same way the
    // application issues it -- so the seed cannot drift into a format the
    // constraint would reject, and cannot leave the per-year counters behind
    // the rows it just wrote.
    const [employeeRow] = await client.query<{ id: number; employee_number: string }>(
      `INSERT INTO employees
         (employee_number, user_id, first_name, last_name, work_email, work_phone,
          department_id, job_position_id, employment_type_id, working_schedule_id,
          hire_date, status, bank_name, bank_account_number, bank_ifsc)
       VALUES (next_employee_number($10::date), $1, $2, $3, $4, $5, $6, $7, $8, $9,
               $10, 'active', $11, $12, $13)
       RETURNING id, employee_number`,
      [
        userId,
        firstName,
        lastName,
        `${firstName.toLowerCase()}.${lastName.toLowerCase()}.${index + 1}@peoplepay360.local`,
        `+91 ${random.int(70000, 99999)}${random.int(10000, 99999)}`,
        reference.departmentIds[departmentCode] as number,
        reference.jobPositionIds[positionTitle] as number,
        reference.employmentTypeIds[employmentTypeCode] as number,
        scheduleId,
        hireDate,
        hasBankDetails ? random.pick(BANKS) : null,
        hasBankDetails ? String(random.int(10000000, 99999999)) + String(random.int(1000, 9999)) : null,
        hasBankDetails ? `HDFC000${random.int(1000, 9999)}` : null,
      ],
    );
    const employeeId = (employeeRow as { id: number }).id;
    const employeeNumber = (employeeRow as { employee_number: string }).employee_number;

    employees.push({
      id: employeeId,
      employeeNumber,
      fullName: `${firstName} ${lastName}`,
      departmentCode,
      employmentTypeCode,
      scheduleId,
      hireDate,
    });

    const structureCode = employmentTypeCode === 'intern' ? 'INTERN' : 'REGULAR';
    const structureId = reference.salaryStructureIds[structureCode] as number;
    const baseWage = BASE_WAGE_BY_POSITION[positionTitle] as number;

    contracts.push(
      ...(await insertContractHistory(client, {
        employeeId,
        employeeNumber,
        hireDate,
        today,
        baseWage,
        scheduleId,
        structureId,
        departmentId: reference.departmentIds[departmentCode] as number,
        jobPositionId: reference.jobPositionIds[positionTitle] as number,
        employmentTypeId: reference.employmentTypeIds[employmentTypeCode] as number,
        random,
      })),
    );
  }

  await assignManagers(client, employees, random);
  return { employees, contracts };
}

type ContractHistoryInput = {
  employeeId: number;
  employeeNumber: string;
  hireDate: IsoDate;
  today: IsoDate;
  baseWage: number;
  scheduleId: number;
  structureId: number;
  departmentId: number;
  jobPositionId: number;
  employmentTypeId: number;
  random: Random;
};

/**
 * Builds a chain of contracts that tile the employee's tenure without ever
 * overlapping: each earlier contract ends the day before the next begins, and
 * only the last is left open-ended and 'running'.
 *
 * The exclusion constraint would reject anything else, which is the point -- the
 * seed cannot accidentally create the ambiguity payroll is meant to avoid.
 */
async function insertContractHistory(
  client: TransactionClient,
  input: ContractHistoryInput,
): Promise<SeededContract[]> {
  const { random } = input;
  const revisionCount = random.chance(0.35) ? random.int(2, 3) : 1;

  const created: SeededContract[] = [];
  let periodStart = input.hireDate;
  let wage = input.baseWage;

  for (let revision = 0; revision < revisionCount; revision += 1) {
    const isLast = revision === revisionCount - 1;

    // Earlier contracts end before today; the current one runs open-ended.
    const periodEnd = isLast
      ? null
      : addMonths(periodStart, random.int(8, 18));

    // A closed contract that would run past today is clamped, so history never
    // claims an employee had two contracts at once.
    const clampedEnd =
      periodEnd !== null && periodEnd >= input.today ? addDays(input.today, -45) : periodEnd;

    if (clampedEnd !== null && clampedEnd <= periodStart) {
      break;
    }

    const [row] = await client.query<{ id: number }>(
      `INSERT INTO contracts
         (reference, employee_id, start_date, end_date, department_id, job_position_id,
          employment_type_id, working_schedule_id, wage, wage_type, salary_structure_id, state, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'monthly', $10, $11, $12)
       RETURNING id`,
      [
        `CTR/${input.employeeNumber}/${revision + 1}`,
        input.employeeId,
        periodStart,
        clampedEnd,
        input.departmentId,
        input.jobPositionId,
        input.employmentTypeId,
        input.scheduleId,
        wage,
        input.structureId,
        isLast ? 'running' : 'expired',
        isLast ? 'Current contract.' : 'Superseded by a later revision.',
      ],
    );

    created.push({
      id: (row as { id: number }).id,
      employeeId: input.employeeId,
      startDate: periodStart,
      endDate: clampedEnd,
      wage,
      scheduleId: input.scheduleId,
      salaryStructureId: input.structureId,
    });

    if (clampedEnd === null) {
      break;
    }

    periodStart = addDays(clampedEnd, 1);
    wage = Math.round((wage * (1 + random.int(8, 22) / 100)) / 500) * 500;
  }

  return created;
}

/** Gives each department a manager and points everyone else at them. */
async function assignManagers(
  client: TransactionClient,
  employees: SeededEmployee[],
  random: Random,
): Promise<void> {
  const byDepartment = new Map<string, SeededEmployee[]>();
  for (const employee of employees) {
    const bucket = byDepartment.get(employee.departmentCode) ?? [];
    bucket.push(employee);
    byDepartment.set(employee.departmentCode, bucket);
  }

  for (const [departmentCode, members] of byDepartment) {
    const manager = random.pick(members);

    await client.query('UPDATE departments SET manager_employee_id = $1 WHERE code = $2', [
      manager.id,
      departmentCode,
    ]);

    for (const member of members) {
      if (member.id !== manager.id) {
        await client.query('UPDATE employees SET manager_id = $1 WHERE id = $2', [
          manager.id,
          member.id,
        ]);
      }
    }
  }
}
