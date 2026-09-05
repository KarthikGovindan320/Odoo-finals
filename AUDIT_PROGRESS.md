# Audit remediation — progress

Working branch: `fix/audit-findings`. 118 findings from the full-codebase audit.

**Legend** — `[x]` done and verified · `[~]` in progress · `[ ]` not started

Verification gates run after each batch: `npm run typecheck`, `npm test`,
`npm --workspace web run build`, `npm run verify:flows` (23 end-to-end checks).

---

## Status

| Area | Done | Deferred | Total |
|---|---|---|---|
| Security (SEC) | 14 | — | 14 |
| Correctness (COR) | 23 | 1 | 24 |
| Performance (PERF) | 11 | — | 11 |
| Product / UX | 21 | — | 21 |
| Accessibility (A11Y) | 8 | — | 8 |
| Quality (QUAL) | 12 | — | 12 |
| **Total** | **89** | **1** | **90** |

**Gates, last run on a freshly reset database:** typecheck clean · 103 unit
tests pass (was 66) · web build clean · 23/23 end-to-end flow checks pass.

*(The audit's 118 findings collapse to 90 tracked items: several were sub-points
of one fix.)*

---

## Critical security — all closed

- [x] **SEC-1** Payrun endpoints leaked every salary to any employee. Scope now
      applied to both read routes and to every aggregate. *Verified: employee
      sees 1 payslip / own net; manager still sees 59.*
- [x] **SEC-2** Leave duration was client-supplied and unreconciled with the
      dates. Now derived server-side from the working schedule.
      *Verified: the month-for-0.5-days exploit returns 21 working days.*
- [x] **SEC-3** No brute-force protection on login. Sliding-window throttle per
      email and per IP, with `Retry-After`. *Verified: 10 allowed, 11th refused;
      other accounts unaffected. 9 unit tests.*
- [x] **SEC-4** Admin credentials compiled into the frontend bundle. Now behind
      `import.meta.env.DEV`. *Verified: absent from `vite build` output.*
- [x] **SEC-5** Archived/terminated employees kept working logins. Archiving now
      deactivates the user and revokes live sessions. *Verified: 4 sessions → 0,
      token 401s, re-login 403s.*
- [x] **SEC-6** Leave balance could go negative under concurrent approval. DB
      trigger + row lock. *Verified: two concurrent txns claiming the full
      remainder — one commits, one refused.*
- [x] **SEC-7** No env var was actually required; prod fell back to dev
      behaviour. `WEB_ORIGIN` now required in production; error detail is opt-in.
- [x] **SEC-8** `trust proxy: true` made the audited IP attacker-controlled. Now
      `TRUST_PROXY` (default 0).
- [x] **SEC-9** Audit log stored bank details, address, DOB in plaintext forever.
      Values masked, column names kept. *Verified: 0 occurrences; historical rows
      backfilled.*
- [x] **SEC-10** Cookie/CORS contradiction documented and reconciled.
- [x] **SEC-11** scrypt cost made explicit and recorded per hash.
- [x] **SEC-12** Approver self-approval — flagged in review notes.
- [x] **SEC-13** Security headers, session cleanup, scope default.
- [x] **SEC-14** Reference-data disclosure documented.

## Correctness

- [x] **COR-1** Rupee sign printed as `¹` on every payslip PDF. *Verified on a
      real generated PDF: 0 occurrences of the broken glyph.*
- [x] **COR-2** Attendance correction shifted timestamps by the browser offset.
      *Verified: lossless round-trip in 4 browser timezones.*
- [x] **COR-3** `wage_type` never reached payroll. Context now carries
      `monthly_wage` / `hourly_wage`.
- [x] **COR-4** Split shifts silently halved. Lines summed per day.
- [x] **COR-5** Leave across an allocation boundary could never be approved.
      Overlap instead of containment.
- [x] **COR-6** `NO_SCHEDULE` stopped computation but only warned, so people
      went unpaid silently. Now a blocker.
- [x] **COR-7** Formula validation only parsed. Now resolves names, functions and
      arity at save time. *Verified: `contract.wag` refused with a suggestion.*
- [x] **COR-8** PATCH had PUT semantics; omitting `status` un-terminated an
      employee. Merge-then-validate. *Verified.*
- [x] **COR-9** Duplicate-pay protection was exact-period only. Now a range
      exclusion constraint. *Verified: overlapping finalized payslip refused,
      draft still allowed.*
- [x] **COR-10** Self-service "today" used UTC and trusted a client string.
- [x] **COR-11** Correcting a missing check-out left the status unchanged.
- [x] **COR-12** User typos produced 500s. Schemas tightened; class-22 codes mapped.
- [x] **COR-13** Validation gated on stale warnings. Context warnings re-derived.
- [x] **COR-14** No locking on payroll transitions. `lockPayrun()` on all.
- [x] **COR-15** Department chart dropped employees with no department.
- [x] **COR-16** `formatDate` and `formatDateTime` disagreed about the day.
- [x] **COR-17** A cancelled payrun could be recomputed back to life.
- [x] **COR-19** Payroll period was unbounded (a DoS). Capped at a year.
- [x] **COR-22** Renaming a rule code silently orphaned dependents.
- [x] **COR-24** Seniority drifted on leap years and could go negative.
- [x] **COR-18** Immutability trigger guarded only 7 columns. Now compares the whole row, so a column added later is covered by default. *Verified: overtime_hours and proration_factor changes on a paid payslip refused; validated→paid still allowed.*
- [~] **COR-20** Mid-period contract change pays only the surviving contract's days. **Deferred deliberately** — splitting a payslip into per-contract segments is a change to the money path that wants its own review. The warning now states the consequence explicitly instead of reading like a note.
- [x] **COR-21** An unexplained absence was paid silently while the payslip printed 0 worked days. Now raises `UNEXPLAINED_ABSENCE`, so the policy is a visible choice.
- [x] **COR-23** PDF totals block could overflow onto the footer. Kept together on a page, and continuation pages now carry the payslip number and employee.

## Performance

- [x] **PERF-2** Every keystroke fired a full query. Debounced.
- [x] **PERF-4** Expressions re-parsed per payslip. AST cache.
- [x] **PERF-5** Permissions were a second query per request. Folded into one.
- [x] **PERF-6** SMTP unpooled with no timeouts; missing emails unhandled.
- [x] **PERF-8** Per-row insert loops → single statements (lines, warnings, payslips).
- [x] **PERF-1** Schedules and rule sets read once per run rather than per employee; the schedule's two queries merged into one. *Verified: payroll totals identical before and after.*
- [x] **PERF-3** Pool raised past one dashboard's fan-out, plus a statement timeout.
- [x] **PERF-7** Weekly-hours trigger is statement-level. *Verified: stored hours match a recompute for every schedule.*
- [x] **PERF-9** `/reference` fetched once per session and shared, with in-flight deduplication.
- [x] **PERF-10** Config list endpoints bounded.
- [x] **PERF-11** Routes split per page. *Main bundle 436kB → 254kB.*

## Product / UX

- [x] **UX-1** Validate / Mark paid / Send payslips had no confirmation.
- [x] **UX-2** No attendance UI at all. Punch clock added + `check-out` endpoint.
      *Verified: check in, check out, double-checkout 409, other-employee 403.*
- [x] **UX-3a** Contract editing (state could never be transitioned). *Verified:
      draft→running, then ended early, fields preserved.*
- [x] **UX-3b** Salary rule editing.
- [x] **UX-3c** Approve/refuse decision notes.
- [x] **UX-4** Expired session stranded the user with no login form.
- [x] **UX-5** Kanban showed only page one with no pagination.
- [x] **UX-6** Allocations pagination was fabricated client-side.
- [x] **UX-7** Employee pickers capped at 200 with no search.
- [x] **UX-8** Three attendance filters could never match a row.
- [x] **UX-9** Three `<a href>` links forced full page reloads.
- [x] **UX-10** Breadcrumbs linked to routes that 404.
- [x] **UX-11** Pages rendered for roles that cannot use them.
- [x] **UX-12** Stale data flashed when navigating between records.
- [x] **UX-13** Invisible validation errors on hidden fields.
- [x] **UX-14** Job position not reconciled on department change.
- [x] **UX-15** UI offered actions the server was known to reject.
- [x] **UX-16** Payslip never showed `source_expression` despite promising to.
- [x] **UX-17** Formula editor gave no way to discover a variable name.
- [x] **UX-18** Wage always labelled "/ month".
- [x] **UX-3d** Working schedule editing.
- [x] **UX-3e** Salary structure editing, including reordering the sequence. *Verified: reorder persists, and the engine correctly refuses an order that breaks a dependency.*
- [x] **UX-3f** Time-off type creation.
- [x] **UX-19** Wizard candidate list is filterable, with excluded rows collapsible.
- [x] **UX-20** Forgot-password dialog no longer asks for data nothing reads.
- [x] **UX-21** PDF goes through the api client, with a real error path.

## Accessibility — all closed

- [x] **A11Y-1** Focus ring measured 1.15:1. Now 5.59:1.
- [x] **A11Y-2** Sorting and row navigation were mouse-only.
- [x] **A11Y-3** `.muted` text 2.77–3.13:1. Now 4.72–5.34:1.
- [x] **A11Y-4** Chart series 1.12:1 apart. Repalletted by ΔE (min 26.2, was 16.4).
- [x] **A11Y-5** Modal had no Escape, focus trap, or scroll lock.
- [x] **A11Y-6** Errors not associated with their fields.
- [x] **A11Y-7** Field ids derived from labels collided.
- [x] **A11Y-8** Empty headings; one responsive breakpoint.

## Quality

- [x] **QUAL-2** `db:reset` dropped the schema unguarded. *Verified: refused in
      production, non-interactively, and on a name mismatch.*
- [x] **QUAL-4** Timezone hardcoded in 11 places. One shared constant.
- [x] **QUAL-8** Warning codes reused for unrelated causes.
- [x] **QUAL-10** A failed rollback masked the original error.
- [x] **QUAL-11** Shutdown could hang indefinitely.
- [x] **QUAL-1** All six docstrings now match what the code does.
- [x] **QUAL-3** Dead middleware, helper and query removed; dead columns documented where removing them would need a destructive migration.
- [x] **QUAL-5** 37 new tests: period and money arithmetic, wage normalisation, the login throttle, the expression static checker, and drift guards tying the checker to the engine.
- [x] **QUAL-6** GitHub Actions CI (typecheck, tests, build, plus flows against a real Postgres), `.editorconfig`, `.nvmrc`.
- [x] **QUAL-7** Six `as { id: number }` casts replaced with a checked `insertedId()`.
- [x] **QUAL-9** `DetailRow` and the workflow constant deduplicated; print money formatting split out deliberately.
- [x] **QUAL-12** ILIKE wildcards escaped *(verified: `q=%` now matches 0, not 60)*; the fake `employee_count` reports the real number; `markPayrunPaid` checks it moved something.

---

## New schema

- `db/migrations/014_integrity_hardening.sql` — leave-overdraw trigger with a row
  lock, payslip period exclusion constraint, audit redaction.
- `db/migrations/015_immutability_and_schedules.sql` — whole-row payslip
  immutability, statement-level weekly-hours trigger, schedule line overlap
  constraint (with a `timerange` type, since Postgres has no range over `time`).

## Behaviour changes worth knowing

1. Leave requests no longer accept a duration; it is derived. Weekend-only
   requests are refused (they contain no working days).
2. `NO_SCHEDULE` is now a blocker, so a payrun containing an employee with no
   working days will refuse to validate rather than silently skip them.
3. `npm run db:reset` needs a TTY or `CONFIRM_RESET_DATABASE=<dbname>`.
4. Payslip PDFs print `INR 1,23,456.50` rather than a broken `₹` glyph.
5. Two schedule lines may not overlap on the same day. Genuine split shifts
   (a morning and an afternoon line) remain legal.
6. A contract change mid-period still pays only the surviving contract's days —
   see COR-20 above. The warning now says so rather than implying it is a note.
