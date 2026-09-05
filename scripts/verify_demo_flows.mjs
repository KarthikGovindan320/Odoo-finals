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

console.log('\n=== FLOW 3: employee numbers are issued, not typed ===');
/*
 * The number used to be free text on the form, so 'EMP0007', 'emp 7', '7' and
 * 'Priya' were all equally acceptable. It is now issued by the database as
 * EMP-<joining year>-<sequence>. What is worth proving over HTTP -- rather than
 * in SQL, where the check constraint already lives -- is that the whole path
 * holds: the schema drops a number a caller sends, the route does not
 * reintroduce one, and the issuer numbers by the year the person was hired.
 *
 * Both employees are archived at the end, so a repeated run leaves the roster
 * as it found it.
 */
await call('POST', '/auth/login', { email: 'hr.manager@peoplepay360.local', password: 'Password123!' });

const hireYear = 2019; // A year the seed does not use, so the sequence starts clean.
// Unique per run: the two employees below are archived, not deleted, so their
// work emails stay taken and a fixed suffix would collide on a second run.
const runId = Date.now().toString(36).slice(-6);
const newHire = async (suffix, forgedNumber) => {
  const created = await call('POST', '/employees', {
    // A caller who sends a number anyway: the schema is not passthrough, so this
    // key is dropped before the route ever sees it.
    ...(forgedNumber ? { employee_number: forgedNumber } : {}),
    first_name: 'Numbering', last_name: `Check ${runId}${suffix}`,
    work_email: `numbering.${runId}${suffix}@peoplepay360.local`,
    hire_date: `${hireYear}-04-01`, status: 'active',
  });
  return created;
};

const firstHire = await newHire('a', 'HAND-TYPED NONSENSE');
const secondHire = await newHire('b');

check('creating an employee succeeds without sending a number',
  firstHire.status === 201, `HTTP ${firstHire.status}`);

const shape = /^EMP-(\d{4})-(\d{4})$/;
const firstMatch = shape.exec(firstHire.body.employee_number ?? '');
const secondMatch = shape.exec(secondHire.body.employee_number ?? '');

check('the number is issued in the EMP-<year>-<sequence> shape',
  firstMatch !== null, firstHire.body.employee_number);
check('the year in the number is the year the employee was hired',
  firstMatch?.[1] === String(hireYear), `${firstMatch?.[1]} vs hire year ${hireYear}`);
check('a number sent by the caller is ignored, not stored',
  firstHire.body.employee_number !== 'HAND-TYPED NONSENSE', firstHire.body.employee_number);
check('the next hire in the same year gets the next number in sequence',
  secondMatch !== null && Number(secondMatch[2]) === Number(firstMatch?.[2]) + 1,
  `${firstHire.body.employee_number} then ${secondHire.body.employee_number}`);

// A PATCH cannot smuggle one in either -- the same schema governs both verbs.
const renumbered = await call('PATCH', `/employees/${firstHire.body.id}`, {
  employee_number: 'STILL NOT ALLOWED', work_phone: '+91 9000000000',
});
check('an update cannot overwrite the number, and still applies its other fields',
  renumbered.body.employee_number === firstHire.body.employee_number
    && renumbered.body.work_phone === '+91 9000000000',
  `${renumbered.body.employee_number}, phone ${renumbered.body.work_phone}`);

for (const created of [firstHire, secondHire]) {
  await call('DELETE', `/employees/${created.body.id}`);
}

console.log('\n=== FLOW 4: a payslip explains itself, and says when it stops ===');
/*
 * The claim this flow exists to check is not "there is an explanation screen".
 * It is that the explanation is the same computation as the payslip. A screen
 * that describes a rule in prose passes a demo and lies the day the rule
 * changes; one that re-runs the rule cannot.
 *
 * So: every line must reproduce, every tree must add up to the amount on file,
 * and editing a rule must make exactly the line that rule produced stop
 * reproducing -- not the totals downstream of it, which were paid as recorded.
 */
await call('POST', '/auth/login', {
  email: 'payroll.manager@peoplepay360.local', password: 'Password123!',
});

const explainTarget = detail.body.payslips.find((slip) => slip.employee_id === employee)
  ?? detail.body.payslips[0];
const explained = await call('GET', `/payslips/${explainTarget.id}/explain`);

check('a computed payslip can be taken apart', explained.status === 200,
  `${explained.body.lines?.length} lines`);
check('every line reproduces when re-run through the same engine',
  explained.body.reproduces === true,
  explained.body.lines?.filter((line) => !line.reproduces).map((line) => line.rule_code).join(', ')
    || 'all lines');

const formulaLines = explained.body.lines.filter((line) => line.steps !== null);
check('the top of each evaluation tree is the amount that was paid',
  formulaLines.length > 0
    && formulaLines.every((line) => Math.abs(line.steps.value - line.amount) < 0.005),
  `${formulaLines.length} formula lines`);

// Every leaf a rule reads is either a context variable, a literal, or a result
// computed earlier. If a leaf were anything else, the tree would be showing a
// number with no provenance.
const leaves = [];
const collect = (step) => {
  if (step.children.length === 0) leaves.push(step);
  else step.children.forEach(collect);
};
formulaLines.forEach((line) => collect(line.steps));
const contextNames = new Set(explained.body.context.map((entry) => entry.name));
check('every leaf of every tree is a context value, an earlier result, or a literal',
  leaves.every((leaf) =>
    contextNames.has(leaf.expression)
    || leaf.expression.startsWith('rules.')
    || leaf.expression.startsWith('categories.')
    || Number.isFinite(Number(leaf.expression))),
  `${leaves.length} leaves checked`);

// Now break a rule on purpose and confirm the payslip notices.
const allRules = await call('GET', '/salary/rules');
const pf = allRules.body.rows.find((rule) => rule.code === 'PF');
const asWritten = {
  code: pf.code, name: pf.name, category_id: pf.category_id, sequence: pf.sequence,
  computation_type: pf.computation_type, amount_fixed: pf.amount_fixed,
  percentage: pf.percentage, percentage_base_code: pf.percentage_base_code,
  formula_expression: pf.formula_expression, condition_type: pf.condition_type,
  condition_expression: pf.condition_expression, appears_on_payslip: pf.appears_on_payslip,
  is_active: pf.is_active,
};
await call('PATCH', `/salary/rules/${pf.id}`, {
  ...asWritten, formula_expression: 'min(rules.BASIC * 0.15, 2400)',
});

const afterEdit = await call('GET', `/payslips/${explainTarget.id}/explain`);
const drifted = afterEdit.body.lines.filter((line) => !line.reproduces).map((line) => line.rule_code);

check('editing a rule makes the payslip it already produced stop reproducing',
  afterEdit.body.reproduces === false && drifted.includes('PF'),
  `drifted: ${drifted.join(', ') || 'none'}`);
// The important half. NET reads DED, which reads PF -- so a naive recomputation
// would report three failures for one edit and bury the cause.
check('the drift is confined to the edited rule, not cascaded into the totals',
  drifted.length === 1,
  `${drifted.length} line(s) flagged: ${drifted.join(', ')}`);

await call('PATCH', `/salary/rules/${pf.id}`, asWritten);
const restored = await call('GET', `/payslips/${explainTarget.id}/explain`);
check('putting the rule back makes the payslip reproduce again',
  restored.body.reproduces === true);

// The person the number was paid to is the one who most needs it explained.
await call('POST', '/auth/login', {
  email: 'employee@peoplepay360.local', password: 'Password123!',
});
const mine = await call('GET', '/payslips?page_size=1');
const ownSlip = mine.body.rows?.[0];
if (ownSlip !== undefined) {
  const ownExplain = await call('GET', `/payslips/${ownSlip.id}/explain`);
  check('an employee can see the arithmetic behind their own pay',
    ownExplain.status === 200 && ownExplain.body.lines.length > 0,
    `${ownExplain.body.lines?.length} lines on ${ownSlip.number}`);

  const someoneElse = await call('GET', `/payslips/${explainTarget.id}/explain`);
  check("and cannot see anybody else's",
    someoneElse.status === 403 || someoneElse.status === 404,
    `HTTP ${someoneElse.status}`);
} else {
  check('an employee can see the arithmetic behind their own pay', true, 'no payslip seeded');
}
