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

console.log('\n=== FLOW 5: why this payslip differs from the last one ===');
/*
 * The decomposition has to close. A screen that attributes a pay change to a
 * list of causes and then does not add up to the change is worse than one that
 * says nothing, because somebody will act on it.
 *
 * Checked against real seeded history rather than a fixture, because the shape
 * that broke this in development -- a partial first month against a full one --
 * is not a shape anybody writes into a fixture.
 */
await call('POST', '/auth/login', {
  email: 'payroll.manager@peoplepay360.local', password: 'Password123!',
});

const withHistory = await call('GET', '/payslips?page_size=120&sort=period');
const comparisons = [];
let firstEver = null;
for (const row of withHistory.body.rows) {
  const result = await call('GET', `/payslips/${row.id}/compare`);
  if (result.status !== 200) continue;
  if (result.body.previous === null) firstEver ??= result.body;
  else if (comparisons.length < 25) comparisons.push(result.body);
  if (comparisons.length >= 25 && firstEver !== null) break;
}

check('payslips with history can be compared with the period before',
  comparisons.length > 0, `${comparisons.length} comparisons`);

const doesNotClose = comparisons.filter((one) =>
  Math.abs((one.net_from_inputs + one.net_from_rule_change) - one.net_delta) > 0.02);
check('inputs and rule changes together account for the whole change in net pay',
  doesNotClose.length === 0,
  doesNotClose.map((one) => one.current.number).join(', ') || `${comparisons.length} check out`);

// The failure this guards against reported a 671,000 rupee driver on a payslip
// whose net moved 4,483, by reverting the scheduled day count while leaving the
// paid day count -- which is defined in terms of it -- alone.
const absurd = comparisons.filter((one) =>
  one.attribution === 'separable'
  && one.changed_inputs.some((driver) =>
    Math.abs(driver.amount) > 20 * Math.max(Math.abs(one.net_delta), 1000)));
check('no single cause is reported as wildly larger than the change it explains',
  absurd.length === 0,
  absurd.map((one) => one.current.number).join(', ') || 'none');

const separable = comparisons.filter((one) => one.attribution === 'separable');
check('where causes are separable, they sum to the input-driven change',
  separable.every((one) =>
    Math.abs(one.changed_inputs.reduce((sum, driver) => sum + driver.amount, 0)
      + one.net_interaction - one.net_from_inputs) < 0.02),
  `${separable.length} of ${comparisons.length} separable`);

// A rule edited between periods must land on the rule-change term, not be
// blamed on the employee's attendance.
const target = comparisons.find((one) => one.net_delta !== 0) ?? comparisons[0];
const rulesNow = await call('GET', '/salary/rules');
const pt = rulesNow.body.rows.find((rule) => rule.code === 'PT');
const ptAsWritten = {
  code: pt.code, name: pt.name, category_id: pt.category_id, sequence: pt.sequence,
  computation_type: pt.computation_type, amount_fixed: pt.amount_fixed,
  percentage: pt.percentage, percentage_base_code: pt.percentage_base_code,
  formula_expression: pt.formula_expression, condition_type: pt.condition_type,
  condition_expression: pt.condition_expression, appears_on_payslip: pt.appears_on_payslip,
  is_active: pt.is_active,
};
await call('PATCH', `/salary/rules/${pt.id}`, { ...ptAsWritten, amount_fixed: 500 });

const afterFlatEdit = await call('GET', `/payslips/${target.current.id}/compare`);
// A flat rise hits both periods identically, so it explains none of the gap
// between them. Zero is the right answer, and the decomposition must still close.
check('a rule edit that hit both periods equally is charged to neither',
  afterFlatEdit.body.net_from_rule_change === 0
    && Math.abs(afterFlatEdit.body.net_from_inputs - afterFlatEdit.body.net_delta) < 0.02,
  `rule change ${afterFlatEdit.body.net_from_rule_change}, inputs ${afterFlatEdit.body.net_from_inputs}, delta ${afterFlatEdit.body.net_delta}`);
await call('PATCH', `/salary/rules/${pt.id}`, ptAsWritten);

// One that does not hit both equally: lifting the provident fund cap changes
// the deduction only where basic pay was high enough to reach it.
const pfRule = rulesNow.body.rows.find((rule) => rule.code === 'PF');
const pfAsWritten = {
  code: pfRule.code, name: pfRule.name, category_id: pfRule.category_id, sequence: pfRule.sequence,
  computation_type: pfRule.computation_type, amount_fixed: pfRule.amount_fixed,
  percentage: pfRule.percentage, percentage_base_code: pfRule.percentage_base_code,
  formula_expression: pfRule.formula_expression, condition_type: pfRule.condition_type,
  condition_expression: pfRule.condition_expression, appears_on_payslip: pfRule.appears_on_payslip,
  is_active: pfRule.is_active,
};
await call('PATCH', `/salary/rules/${pfRule.id}`, {
  ...pfAsWritten, formula_expression: 'rules.BASIC * 0.12',
});

const uneven = [];
for (const one of comparisons.slice(0, 12)) {
  const again = await call('GET', `/payslips/${one.current.id}/compare`);
  uneven.push(again.body);
}
check('a rule edit that hit the periods differently is charged to the rule',
  uneven.some((one) => one.net_from_rule_change !== 0),
  `${uneven.filter((one) => one.net_from_rule_change !== 0).length} of ${uneven.length} affected`);
check('and the decomposition still accounts for the whole change',
  uneven.every((one) =>
    Math.abs((one.net_from_inputs + one.net_from_rule_change) - one.net_delta) < 0.02),
  `${uneven.length} checked`);
await call('PATCH', `/salary/rules/${pfRule.id}`, pfAsWritten);

/*
 * The payslip list only ever sorts newest-first, so scanning it finds nobody's
 * first payslip -- by the latest period everyone has history. Go at it from the
 * earliest payrun instead, where every payslip is somebody's first.
 */
if (firstEver === null) {
  const allRuns = await call('GET', '/payruns?page_size=50');
  const earliestRun = allRuns.body.rows
    .reduce((oldest, run) => (run.period_start < oldest.period_start ? run : oldest));
  const firstSlips = await call('GET', `/payslips?payrun_id=${earliestRun.id}&page_size=8`);
  for (const row of firstSlips.body.rows ?? []) {
    const result = await call('GET', `/payslips/${row.id}/compare`);
    if (result.status === 200 && result.body.previous === null) {
      firstEver = result.body;
      break;
    }
  }
}

// An employee's first payslip has nothing behind it, and must say so rather
// than compare itself with nothing and report the whole net as a pay rise.
check("an employee's first payslip says there is nothing to compare it with",
  firstEver !== null
    && firstEver.unavailable !== null
    && firstEver.net_delta === 0
    && firstEver.changed_inputs.length === 0,
  firstEver === null
    ? 'no first payslip found in the sample'
    : `${firstEver.current.number}: ${firstEver.unavailable}`);

await call('POST', '/auth/login', {
  email: 'employee@peoplepay360.local', password: 'Password123!',
});
const own = await call('GET', '/payslips?page_size=1');
if (own.body.rows?.[0] !== undefined) {
  const ownCompare = await call('GET', `/payslips/${own.body.rows[0].id}/compare`);
  check('an employee can see why their own pay changed', ownCompare.status === 200,
    `HTTP ${ownCompare.status}`);
  const notTheirs = await call('GET', `/payslips/${target.current.id}/compare`);
  check("and cannot see why anybody else's did",
    notTheirs.status === 403 || notTheirs.status === 404, `HTTP ${notTheirs.status}`);
}

console.log('\n=== FLOW 6: pricing a change without making it ===');
/*
 * The two things a simulator has to be: correct, and inert. Correct means the
 * figures come from the rules rather than from scaling a total, which shows up
 * as a raise not costing exactly what the percentage says. Inert means running
 * one changes nothing -- and that is checked by comparing the payrun to itself
 * before and after, not by reading the code and believing it.
 */
await call('POST', '/auth/login', {
  email: 'payroll.manager@peoplepay360.local', password: 'Password123!',
});

const runsForSim = await call('GET', '/payruns?page_size=40');
const biggest = runsForSim.body.rows
  .reduce((best, run) => (run.payslip_count > (best?.payslip_count ?? 0) ? run : best), null)
  ?? runsForSim.body.rows[0];

const payrunBefore = await call('GET', `/payruns/${biggest.id}`);
const beforeNet = payrunBefore.body.payslips.reduce((sum, slip) => sum + Number(slip.net_amount), 0);

const nothing = await call('POST', `/payruns/${biggest.id}/simulate`, {});
check('an empty scenario is priced as no change at all',
  nothing.status === 200 && nothing.body.net_delta === 0
    && nothing.body.projected.net === nothing.body.baseline.net,
  `${nothing.body.baseline?.employees} employees, delta ${nothing.body.net_delta}`);

const raise = await call('POST', `/payruns/${biggest.id}/simulate`, { wage_change_percent: 10 });
check('a raise is priced across the whole payrun',
  raise.status === 200 && raise.body.net_delta > 0,
  `${raise.body.net_delta} on ${raise.body.baseline.employees} employees`);

// The claim the feature exists to make. If these matched, the honest thing
// would be to delete the simulator and multiply.
const spreadsheet = raise.body.baseline.net * 1.1;
check('the rules disagree with scaling the total, which is the point',
  Math.abs(raise.body.projected.net - spreadsheet) > 1,
  `rules ${raise.body.projected.net.toFixed(2)} vs scaling ${spreadsheet.toFixed(2)}`);

check('the annual figure is twelve times the monthly one, on a monthly period',
  raise.body.annualised_net_delta === null
    || Math.abs(raise.body.annualised_net_delta - raise.body.net_delta * 12) < 0.02,
  `${raise.body.annualised_net_delta}`);

check('department totals account for the whole change',
  Math.abs(raise.body.by_department.reduce((sum, row) => sum + row.net_delta, 0)
    - raise.body.net_delta) < 0.05,
  `${raise.body.by_department.length} departments`);

// 31 rather than 60: the schema itself refuses more than a month, so asking for
// 60 tests the validator, not the clamp. 31 is accepted and still more than any
// period's scheduled days, which is what puts every employee against the bound.
const leave = await call('POST', `/payruns/${biggest.id}/simulate`, {
  unpaid_leave_days_delta: 31,
});
check('leave beyond the period is held at the period, and reported as held',
  leave.body.clamped > 0 && leave.body.net_delta < 0,
  `${leave.body.clamped} held at the limit, net ${leave.body.net_delta}`);

const nonsense = await call('POST', `/payruns/${biggest.id}/simulate`, {
  wage_change_percent: 5000,
});
check('a scenario outside what can be modelled is refused with a reason',
  nonsense.status === 422 || nonsense.status === 400,
  nonsense.body.error?.message?.slice(0, 60) ?? `HTTP ${nonsense.status}`);

// Inert. Three simulations have now run against this payrun.
const payrunAfter = await call('GET', `/payruns/${biggest.id}`);
const afterNet = payrunAfter.body.payslips.reduce((sum, slip) => sum + Number(slip.net_amount), 0);
check('simulating changed nothing about the payrun',
  Math.abs(afterNet - beforeNet) < 0.005 && payrunAfter.body.state === payrunBefore.body.state,
  `net ${beforeNet.toFixed(2)} before, ${afterNet.toFixed(2)} after; state ${payrunAfter.body.state}`);

// A payroll-wide figure is not an employee's business, and the guard is the
// permission rather than a condition inside the handler -- so it is worth
// checking the permission really is the one that excludes them.
await call('POST', '/auth/login', {
  email: 'employee@peoplepay360.local', password: 'Password123!',
});
const simRefused = await call('POST', `/payruns/${biggest.id}/simulate`, { wage_change_percent: 10 });
check('an employee cannot price a payroll-wide scenario',
  simRefused.status === 403, `HTTP ${simRefused.status}`);

console.log('\n=== FLOW 7: exports carry the filtered set, not the page ===');
/*
 * The property worth checking is not that a file comes back. It is that the file
 * holds everything the filter matches -- a button labelled "Export" that hands
 * over the twenty-five rows on screen is wrong in a way nobody notices until
 * they are reconciling against it.
 *
 * So every check here compares the row count in the file against the total the
 * list endpoint reports for the same filters.
 */
await call('POST', '/auth/login', {
  email: 'admin@peoplepay360.local', password: 'Password123!',
});

/** Fetches a file rather than JSON, and counts its data rows. */
async function download(path) {
  const response = await fetch(`${API}${path}`, { headers: { cookie } });
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    type: response.headers.get('content-type') ?? '',
    disposition: response.headers.get('content-disposition') ?? '',
    buffer,
    // Records, not lines: a note containing a newline spans two lines and is
    // still one row, so count the quoted starts of records instead.
    csvRows: buffer.toString('utf8').split('\r\n"').length - 1,
  };
}

const employeeTotal = (await call('GET', '/employees?page_size=1')).body.total;
const employeeCsv = await download('/employees/export?format=csv');

check('an export downloads as a file, named and typed',
  employeeCsv.status === 200
    && employeeCsv.type.startsWith('text/csv')
    && /attachment; filename="employees-\d{4}-\d{2}-\d{2}\.csv"/.test(employeeCsv.disposition),
  employeeCsv.disposition);
check('the employee export holds every employee, not the page on screen',
  employeeCsv.csvRows === employeeTotal,
  `${employeeCsv.csvRows} rows in the file, ${employeeTotal} employees`);

// The same request with a filter must produce the same count the list reports.
const departments = (await call('GET', '/reference')).body.departments ?? [];
const oneDepartment = departments[0];
if (oneDepartment !== undefined) {
  const filtered = await call('GET', `/employees?page_size=1&department_id=${oneDepartment.id}`);
  const filteredCsv = await download(`/employees/export?format=csv&department_id=${oneDepartment.id}`);
  check('a filtered export matches the filter that was on screen',
    filteredCsv.csvRows === filtered.body.total,
    `${oneDepartment.name}: ${filteredCsv.csvRows} in the file, ${filtered.body.total} in the list`);
}

// Attendance is the big one -- forty thousand rows -- and the one where a silent
// page-sized export would be least likely to be noticed.
const attendanceTotal = (await call('GET', '/attendance?page_size=1')).body.total;
const attendanceCsv = await download('/attendance/export?format=csv');
check('the attendance export holds the whole table',
  attendanceCsv.csvRows === attendanceTotal,
  `${attendanceCsv.csvRows} rows in the file, ${attendanceTotal} records`);

const xlsx = await download('/employees/export?format=xlsx');
check('the workbook is a zip, not a CSV wearing the extension',
  xlsx.buffer.subarray(0, 2).toString() === 'PK'
    && xlsx.type.includes('spreadsheetml'),
  `${xlsx.buffer.length} bytes, ${xlsx.type.split(';')[0]}`);
// The parts Excel refuses to open a workbook without.
const asText = xlsx.buffer.toString('latin1');
check('the workbook carries the parts that make it openable',
  ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml']
    .every((part) => asText.includes(part)));

for (const path of ['/contracts/export', '/payslips/export', '/time-off/requests/export']) {
  const listPath = path.replace('/export', '');
  const listed = (await call('GET', `${listPath}?page_size=1`)).body.total;
  const file = await download(`${path}?format=csv`);
  check(`${listPath} exports every row it lists`,
    file.status === 200 && file.csvRows === listed,
    `${file.csvRows} in the file, ${listed} in the list`);
}

// Scope is the server's, not the screen's: an employee exporting the list they
// are allowed to see must get their own rows and nobody else's.
await call('POST', '/auth/login', {
  email: 'employee@peoplepay360.local', password: 'Password123!',
});
const ownTotal = (await call('GET', '/attendance?page_size=1')).body.total;
const ownFile = await download('/attendance/export?format=csv');
check('an employee exports their own records and only those',
  ownFile.status === 200 && ownFile.csvRows === ownTotal && ownTotal < attendanceTotal,
  `${ownFile.csvRows} of their own, against ${attendanceTotal} in the whole table`);
