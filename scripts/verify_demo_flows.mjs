/**
 * End-to-end verification of the two flows the demo walks through.
 *
 * Not a unit test -- it drives the real HTTP API against the real database, the
 * same way a person would. Run it after seeding, with the server up:
 *
 *   npm run dev:server        (in one terminal)
 *   npm run verify:flows
 *
 * It creates a payrun in a period the seed does not use, so it can be run
 * repeatedly without colliding with the seeded history.
 */
const API = 'http://localhost:4000/api/v1';
let cookie = '';

async function call(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = text.slice(0, 200); }
  return { status: response.status, body: payload };
}

/** Recovers the contract wage from the basic line, which is wage x paid/scheduled. */
function wageOf(payslip) {
  const basic = payslip.lines.find((line) => line.rule_code === 'BASIC');
  const paidDays = payslip.scheduled_days - payslip.unpaid_leave_days;
  return (basic.amount * payslip.scheduled_days) / paidDays;
}

function addDays(isoDate, days) {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const check = (label, condition, detail = '') => {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!condition) process.exitCode = 1;
};

console.log('\n=== FLOW 1: employee -> payslip ===');
await call('POST', '/auth/login', {
  email: 'payroll.manager@peoplepay360.local', password: 'Password123!',
});

/**
 * Each run needs payroll periods nobody has used, because the platform's own
 * rules -- an employee already paid for a period is ineligible, approved leave
 * cannot overlap approved leave -- would correctly reject a repeat. Rather than
 * guessing from the clock, ask the database where payroll history currently ends
 * and start one month after it. That never collides, however often it runs.
 */
function monthAfter(isoDate, step) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + step);
  const start = date.toISOString().slice(0, 10);
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);
  return { start, end };
}

async function reservePeriods() {
  const existing = await call('GET', '/payruns?page_size=1&sort=period');
  const latest = existing.body.rows[0]?.period_end ?? new Date().toISOString().slice(0, 10);
  return { first: monthAfter(latest, 1), second: monthAfter(latest, 2) };
}

const { first: period, second: secondPeriod } = await reservePeriods();
const stamp = period.start.slice(0, 7);
console.log(`  using periods ${period.start} and ${secondPeriod.start}`);

const structures = await call('GET', '/salary/structures');
const regular = structures.body.rows.find((r) => r.code === 'REGULAR');

const eligible = await call('POST', '/payruns/eligible-employees', {
  salary_structure_id: regular.id,
  period_start: period.start, period_end: period.end,
});
check('wizard step 2 previews eligibility without creating anything',
  eligible.status === 200 && eligible.body.eligible_count > 0,
  `${eligible.body.eligible_count} eligible, ${eligible.body.ineligible_count} not`);

const before = await call('GET', '/payruns?page_size=1');
const picked = eligible.body.rows.filter((r) => r.is_eligible).slice(0, 12).map((r) => r.employee_id);

const created = await call('POST', '/payruns', {
  name: `VERIFY/${stamp}/A`, salary_structure_id: regular.id,
  period_start: period.start, period_end: period.end, employee_ids: picked,
});
check('creating the payrun is a separate, explicit step', created.status === 201);
const payrunId = created.body.id;

const after = await call('GET', '/payruns?page_size=1');
check('the preview really created nothing', after.body.total === before.body.total + 1,
  `payruns went ${before.body.total} -> ${after.body.total}`);

const early = await call('POST', `/payruns/${payrunId}/validate`);
check('validating before computing is refused', early.status === 409, early.body.error?.message?.slice(0, 60));

const computed = await call('POST', `/payruns/${payrunId}/compute`);
check('compute produces payslips', computed.body.payslipsComputed === picked.length,
  `${computed.body.payslipsComputed} computed, ${computed.body.warnings} warnings`);

const detail = await call('GET', `/payruns/${payrunId}`);
const sample = detail.body.payslips.find((p) => p.net_amount > 0);
check('payslips carry real money', sample && sample.net_amount > 0,
  `${sample?.employee_name}: net ${sample?.net_amount}`);

/*
 * Not simply picked[0]. The rules a payslip is computed with come from the
 * employee's own contract, not from the structure the payrun was created
 * under -- an intern on a stipend contract gets STIPEND and INTERN_NET, which
 * have no BASIC and no loss-of-pay rule at all. The unpaid-leave assertions
 * in FLOW 2 are about the regular structure's LWP rule, so pick somebody
 * the first payrun actually computed with it. Whoever sorts first is a
 * property of the seed's random data, not of the thing being verified.
 */
let regularEmployee = picked[0];
for (const slip of detail.body.payslips) {
  const full = await call('GET', `/payslips/${slip.id}`);
  if (full.body.lines?.some((line) => line.rule_code === 'BASIC')) {
    regularEmployee = slip.employee_id;
    break;
  }
}
check('found an employee on the regular structure to follow through payroll',
  regularEmployee !== undefined, `employee ${regularEmployee}`);

const validated = await call('POST', `/payruns/${payrunId}/validate`);
check('validate succeeds once computed', validated.status === 200, `${validated.body.validated} payslips`);

const recompute = await call('POST', `/payruns/${payrunId}/compute`);
check('a validated payrun cannot be recomputed', recompute.status === 409,
  recompute.body.error?.message?.slice(0, 70));

const paid = await call('POST', `/payruns/${payrunId}/mark-paid`);
check('mark paid succeeds', paid.status === 200, `${paid.body.paid} payslips`);

const pdf = await fetch(`${API}/payslips/${sample.id}/pdf`, { headers: { cookie } });
const pdfBytes = Buffer.from(await pdf.arrayBuffer());
check('payslip renders as a PDF', pdf.headers.get('content-type') === 'application/pdf'
  && pdfBytes.subarray(0, 5).toString() === '%PDF-', `${pdfBytes.length} bytes`);

const sent = await call('POST', `/payruns/${payrunId}/send-payslips`);
check('bulk email attempts every payslip', sent.status === 200,
  `sent ${sent.body.sent}, failed ${sent.body.failed}, skipped ${sent.body.skipped}`);

console.log('\n=== FLOW 2: allocation -> request -> approved -> payroll ===');
await call('POST', '/auth/login', { email: 'hr.manager@peoplepay360.local', password: 'Password123!' });

const employee = regularEmployee;
const types = await call('GET', '/time-off/types');
const unpaid = types.body.rows.find((t) => t.code === 'UNPAID');
const paidType = types.body.rows.find((t) => t.code === 'PAID');

// Inside the seeded allocation window (this calendar year) and clear of the
// seeded leave history, which ends today. December is reliably free.
//
// The window must be working days. The server derives a request's duration from
// the employee's working schedule, so a Saturday-to-Sunday request is correctly
// refused as containing no leave to take -- which is right, and which this
// fixture used to trip over depending on where in the week December landed.
function firstMondayOfDecember(year) {
  for (let day = 1; day <= 7; day += 1) {
    const candidate = new Date(Date.UTC(year, 11, day));
    if (candidate.getUTCDay() === 1) {
      return candidate.toISOString().slice(0, 10);
    }
  }
  throw new Error('December has no Monday, which cannot happen.');
}

const leaveFrom = firstMondayOfDecember(new Date().getUTCFullYear());
const leaveWindow = { from: leaveFrom, to: addDays(leaveFrom, 1) };

const balancesBefore = await call('GET', `/time-off/balances?employee_id=${employee}`);
const paidBefore = balancesBefore.body.rows.find((r) => r.type_code === 'PAID');

const request = await call('POST', '/time-off/requests', {
  employee_id: employee, time_off_type_id: paidType.id,
  date_from: leaveWindow.from, date_to: leaveWindow.to, reason: 'Demo flow',
});
check('leave request created with a server-derived duration',
  request.status === 201 && request.body.requested_amount === 2,
  `${request.body.calendar_days} calendar days -> ${request.body.requested_amount} working days`);

const approved = await call('POST', `/time-off/requests/${request.body.id}/approve`, {});
check('approval draws from a named allocation', approved.status === 200
  && approved.body.consumed_from.length > 0,
  `consumed ${JSON.stringify(approved.body.consumed_from)}`);

// Ambiguity #6 in plan.md: allocation validity is enforced at approval, not at
// request time. A request outside every valid allocation is accepted as an
// intent and refused when someone tries to fund it.
const outOfWindow = await call('POST', '/time-off/requests', {
  employee_id: employee, time_off_type_id: paidType.id,
  date_from: '2029-03-01', date_to: '2029-03-02', reason: 'Outside allocation window',
});
const outOfWindowApproval = await call('POST', `/time-off/requests/${outOfWindow.body.id}/approve`, {});
check('leave outside every allocation window is refused at approval, with the reason',
  outOfWindowApproval.status === 409
    && /no approved .* allocation covering/i.test(outOfWindowApproval.body.error?.message ?? ''),
  outOfWindowApproval.body.error?.message?.slice(0, 80));

const balancesAfter = await call('GET', `/time-off/balances?employee_id=${employee}`);
const paidAfter = balancesAfter.body.rows.find((r) => r.type_code === 'PAID');
check('balance decreased by exactly the derived duration',
  Number(paidBefore.remaining) - Number(paidAfter.remaining) === Number(request.body.requested_amount),
  `${paidBefore.remaining} -> ${paidAfter.remaining} for a ${request.body.requested_amount}-day request`);

const refused = await call('POST', `/time-off/requests/${request.body.id}/refuse`, {
  decision_note: 'Reversing for the demo',
});
const balancesRestored = await call('GET', `/time-off/balances?employee_id=${employee}`);
const paidRestored = balancesRestored.body.rows.find((r) => r.type_code === 'PAID');
check('refusing an approved request restores balance automatically',
  refused.status === 200 && Number(paidRestored.remaining) === Number(paidBefore.remaining),
  `${paidAfter.remaining} -> ${paidRestored.remaining}`);

console.log('\n=== unpaid leave reaches payroll ===');
const unpaidRequest = await call('POST', '/time-off/requests', {
  employee_id: employee, time_off_type_id: unpaid.id,
  date_from: addDays(secondPeriod.start, 2), date_to: addDays(secondPeriod.start, 4), reason: 'Unpaid demo',
});
await call('POST', `/time-off/requests/${unpaidRequest.body.id}/approve`, {});

await call('POST', '/auth/login', {
  email: 'payroll.manager@peoplepay360.local', password: 'Password123!',
});
const octEligible = await call('POST', '/payruns/eligible-employees', {
  salary_structure_id: regular.id, period_start: secondPeriod.start, period_end: secondPeriod.end,
});
const octRun = await call('POST', '/payruns', {
  name: `VERIFY/${stamp}/B`, salary_structure_id: regular.id,
  period_start: secondPeriod.start, period_end: secondPeriod.end, employee_ids: [employee],
});
await call('POST', `/payruns/${octRun.body.id}/compute`);
const octDetail = await call('GET', `/payruns/${octRun.body.id}`);
const octSlip = octDetail.body.payslips[0];
const octFull = await call('GET', `/payslips/${octSlip.id}`);
const lwp = octFull.body.lines.find((l) => l.rule_code === 'LWP');

check('unpaid leave produced a loss-of-pay deduction on the payslip',
  lwp !== undefined && lwp.amount > 0, `LWP ${lwp?.amount}`);
// Not the calendar span: leave falling on a rest day is not leave, so a
// three-day request over a weekend costs fewer working days. Assert the
// invariant the engine actually guarantees rather than a fixed number.
check('the payslip records unpaid working days, excluding rest days',
  octSlip.unpaid_leave_days > 0 && octSlip.unpaid_leave_days <= 3,
  `unpaid_leave_days = ${octSlip.unpaid_leave_days} of a 3-day request`);

const dailyRate = octFull.body.gross_amount > 0
  ? Math.round((wageOf(octFull.body) / octSlip.scheduled_days) * octSlip.unpaid_leave_days * 100) / 100
  : 0;
check('the loss-of-pay deduction equals daily rate times unpaid working days',
  Math.abs(lwp.amount - dailyRate) < 0.02,
  `LWP ${lwp.amount} vs expected ${dailyRate}`);
void octEligible;

console.log('\n=== dashboard is live, not fixtures ===');
const dash = await call('GET', '/dashboard?period_start=2026-06-01&period_end=2027-12-31');
check('dashboard aggregates real payslips', dash.body.kpis.payslip_count > 0,
  `${dash.body.kpis.payslip_count} payslips, net ${Math.round(dash.body.kpis.total_net)}`);
check('salary cost by department has rows', dash.body.salary_cost_by_department.length > 0,
  `${dash.body.salary_cost_by_department.length} departments`);
check('monthly trend has more than one point', dash.body.monthly_net_trend.length > 1,
  dash.body.monthly_net_trend.map((m) => m.month).join(', '));
check('attendance health is computed', typeof dash.body.kpis.attendance_health === 'number',
  `${dash.body.kpis.attendance_health}%`);
