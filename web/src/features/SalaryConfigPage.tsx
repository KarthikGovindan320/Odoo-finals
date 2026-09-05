/**
 * Salary configuration: structures and the rules inside them.
 *
 * This is where the rules engine becomes visible. Each rule shows its computation
 * type and the expression it evaluates, in sequence order, so the dependency
 * chain -- Basic, then a percentage of Basic, then Gross from category totals,
 * then Net -- can be read straight down the screen.
 *
 * Formulas are parsed before they are saved, so a typo is caught here rather than
 * at 2am during a payrun.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import type { FormEvent } from 'react';

import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/use_resource.ts';
import { humanize } from '../lib/format.ts';
import { useAuth } from '../lib/auth.tsx';
import { Badge, Modal, Panel } from '../components/Chrome.tsx';
import { SelectField, TextAreaField, TextField } from '../components/Field.tsx';
import { salaryRuleInput } from '../../../shared/schemas/payroll.ts';

type StructureRow = {
  id: number; code: string; name: string; currency_code: string;
  description: string; is_active: boolean; rule_count: number; employee_count: number;
};

type RuleRow = {
  id: number; code: string; name: string; computation_type: string;
  amount_fixed: number | null; percentage: number | null; percentage_base_code: string | null;
  formula_expression: string | null; condition_type: string; condition_expression: string | null;
  appears_on_payslip: boolean; is_active: boolean; note: string;
  category_id: number; category_code: string; category_name: string;
  category_sign: number; structure_count: number;
};

type StructureDetail = StructureRow & {
  rules: Array<RuleRow & { link_id: number; sequence: number }>;
};

export function SalaryConfigPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'structures' | 'rules'>('structures');
  const [openStructure, setOpenStructure] = useState<number | null>(null);

  const structures = useResource<{ rows: StructureRow[] }>('/salary/structures');
  const rules = useResource<{ rows: RuleRow[] }>('/salary/rules');
  const [creatingRule, setCreatingRule] = useState(false);

  return (
    <>
      <div className="page__header">
        <div className="page__title">
          <h1>Configuration</h1>
          <span className="page__subtitle">
            Salary structures are ordered collections of rules. The sequence is a dependency
            declaration: a rule may read results computed earlier in the sequence, and nothing later.
          </span>
        </div>
        <div className="page__actions">
          <Link className="btn" to="/working-schedules">Working schedules</Link>
          <Link className="btn" to="/time-off?tab=types">Time off types</Link>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 'var(--space-3)' }}>
        <button className={`btn btn--sm${tab === 'structures' ? ' btn--plum' : ''}`}
          onClick={() => setTab('structures')}>Salary structures</button>
        <button className={`btn btn--sm${tab === 'rules' ? ' btn--plum' : ''}`}
          onClick={() => setTab('rules')}>Salary rules</button>
      </div>

      {tab === 'structures' ? (
        <>
          {structures.error !== null && <div className="error-box">{structures.error}</div>}
          <Panel flush>
            {structures.loading ? (
              <div className="loading">Loading…</div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Code</th><th>Name</th><th>Description</th>
                    <th className="table__num">Rules</th>
                    <th className="table__num">Employees</th>
                    <th>Active</th><th />
                  </tr>
                </thead>
                <tbody>
                  {(structures.data?.rows ?? []).map((row) => (
                    <tr key={row.id}>
                      <td className="mono">{row.code}</td>
                      <td style={{ fontWeight: 600 }}>{row.name}</td>
                      <td className="muted">{row.description || '—'}</td>
                      <td className="table__num">{row.rule_count}</td>
                      <td className="table__num">{row.employee_count}</td>
                      <td>
                        {row.is_active
                          ? <Badge variant="success">Active</Badge>
                          : <Badge>Archived</Badge>}
                      </td>
                      <td className="table__num">
                        <button className="btn btn--sm" onClick={() => setOpenStructure(row.id)}>
                          View rules
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </>
      ) : (
        <>
          {rules.error !== null && <div className="error-box">{rules.error}</div>}
          <Panel
            flush
            title={undefined}
            actions={undefined}
          >
            <div className="toolbar">
              <span className="toolbar__count">{rules.data?.rows.length ?? 0} rules</span>
              <span className="toolbar__spacer" />
              {can('salary_config:write') && (
                <button className="btn btn--primary btn--sm" onClick={() => setCreatingRule(true)}>
                  New rule
                </button>
              )}
            </div>
            <RuleTable rows={rules.data?.rows ?? []} loading={rules.loading} />
          </Panel>
        </>
      )}

      {openStructure !== null && (
        <StructureModal id={openStructure} onClose={() => setOpenStructure(null)} />
      )}
      {creatingRule && (
        <RuleFormModal
          categories={(rules.data?.rows ?? []).map((row) => ({
            id: row.category_id, code: row.category_code, name: row.category_name,
          }))}
          onClose={() => setCreatingRule(false)}
          onSaved={() => { setCreatingRule(false); rules.reload(); }}
        />
      )}
    </>
  );
}

function ruleDefinition(rule: RuleRow): string {
  switch (rule.computation_type) {
    case 'fixed':
      return String(rule.amount_fixed ?? '—');
    case 'percentage':
      return `${rule.percentage}% of ${rule.percentage_base_code}`;
    default:
      return rule.formula_expression ?? '—';
  }
}

function RuleTable({
  rows, loading, showSequence,
}: {
  rows: Array<RuleRow & { sequence?: number }>;
  loading?: boolean;
  showSequence?: boolean;
}) {
  if (loading === true) return <div className="loading">Loading…</div>;
  if (rows.length === 0) return <div className="table__empty">No salary rules configured.</div>;

  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            {showSequence === true && <th className="table__num" style={{ width: 60 }}>Seq</th>}
            <th style={{ width: 90 }}>Code</th>
            <th>Name</th>
            <th style={{ width: 100 }}>Category</th>
            <th style={{ width: 100 }}>Type</th>
            <th>Definition</th>
            <th>Condition</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((rule) => (
            <tr key={rule.id}>
              {showSequence === true && (
                <td className="table__num"><strong>{rule.sequence}</strong></td>
              )}
              <td className="mono">{rule.code}</td>
              <td>
                <div style={{ fontWeight: 600 }}>{rule.name}</div>
                {rule.note !== '' && (
                  <div className="muted" style={{ fontSize: 11 }}>{rule.note}</div>
                )}
              </td>
              <td>
                <Badge variant={rule.category_sign < 0 ? 'danger' : 'plum'}>{rule.category_code}</Badge>
              </td>
              <td>{humanize(rule.computation_type)}</td>
              <td className="mono" style={{ fontSize: 11 }}>{ruleDefinition(rule)}</td>
              <td className="mono" style={{ fontSize: 11 }}>
                {rule.condition_type === 'always'
                  ? <span className="muted">always</span>
                  : rule.condition_expression}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StructureModal({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, loading } = useResource<StructureDetail>(`/salary/structures/${id}`);

  return (
    <Modal title={data?.name ?? 'Salary structure'} onClose={onClose} wide>
      {loading || data === null ? (
        <div className="loading">Loading…</div>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 13 }}>
            {data.rules.length} rules, executed in sequence order. Each rule can read the results of
            those above it, under <span className="mono">rules.CODE</span> and{' '}
            <span className="mono">categories.CODE</span>.
          </p>
          <RuleTable rows={data.rules} showSequence />
        </>
      )}
    </Modal>
  );
}

function RuleFormModal({
  categories, onClose, onSaved,
}: {
  categories: Array<{ id: number; code: string; name: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const uniqueCategories = [...new Map(categories.map((item) => [item.id, item])).values()];

  const [values, setValues] = useState<Record<string, string>>({
    code: '', name: '', category_id: '', computation_type: 'fixed',
    amount_fixed: '', percentage: '', percentage_base_code: '',
    formula_expression: '', condition_type: 'always', condition_expression: '', note: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (name: string) => (event: { target: { value: string } }): void =>
    setValues((previous) => ({ ...previous, [name]: event.target.value }));

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFormError(null);

    const payload: Record<string, unknown> = {
      ...values,
      amount_fixed: values.amount_fixed === '' ? null : Number(values.amount_fixed),
      percentage: values.percentage === '' ? null : Number(values.percentage),
      percentage_base_code: values.percentage_base_code === '' ? null : values.percentage_base_code,
      formula_expression: values.formula_expression === '' ? null : values.formula_expression,
      condition_expression: values.condition_expression === '' ? null : values.condition_expression,
      appears_on_payslip: true,
    };

    const parsed = salaryRuleInput.safeParse(payload);
    if (!parsed.success) {
      setErrors(Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path.map(String).join('.'), issue.message]),
      ));
      return;
    }

    setErrors({});
    setBusy(true);
    try {
      await api.post('/salary/rules', parsed.data);
      onSaved();
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        const fields = error.fieldMap();
        if (Object.keys(fields).length > 0) setErrors(fields);
        else setFormError(error.message);
      } else {
        setFormError('Could not save the rule.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New salary rule"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn--primary" form="rule-form" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save rule'}
          </button>
        </>
      }
    >
      {formError !== null && <div className="error-box" role="alert">{formError}</div>}

      <form id="rule-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="form-grid">
          <TextField label="Code" name="code" required value={values.code} error={errors.code}
            onChange={set('code')} hint="Uppercase, e.g. HRA_METRO. Formulas refer to it as rules.CODE." />
          <TextField label="Name" name="name" required value={values.name} error={errors.name}
            onChange={set('name')} />
          <SelectField label="Category" name="category_id" required placeholder="Choose a category"
            value={values.category_id} error={errors.category_id} onChange={set('category_id')}
            options={uniqueCategories.map((item) => ({
              value: item.id, label: `${item.code} — ${item.name}`,
            }))} />
          <SelectField label="Computation" name="computation_type" value={values.computation_type}
            error={errors.computation_type} onChange={set('computation_type')}
            options={[
              { value: 'fixed', label: 'Fixed amount' },
              { value: 'percentage', label: 'Percentage of another rule' },
              { value: 'formula', label: 'Formula' },
            ]} />
        </div>

        {values.computation_type === 'fixed' && (
          <TextField label="Amount" name="amount_fixed" type="number" step="0.01" required
            value={values.amount_fixed} error={errors.amount_fixed} onChange={set('amount_fixed')} />
        )}

        {values.computation_type === 'percentage' && (
          <div className="form-grid">
            <TextField label="Percentage" name="percentage" type="number" step="0.001" required
              value={values.percentage} error={errors.percentage} onChange={set('percentage')} />
            <TextField label="Base code" name="percentage_base_code" required
              value={values.percentage_base_code} error={errors.percentage_base_code}
              onChange={set('percentage_base_code')}
              hint="A rule code or a category code computed earlier, e.g. BASIC." />
          </div>
        )}

        {values.computation_type === 'formula' && (
          <TextAreaField label="Formula" name="formula_expression" required
            value={values.formula_expression} error={errors.formula_expression}
            onChange={set('formula_expression')}
            placeholder="contract.wage * (worked.paid_days / worked.scheduled_days)"
            hint="Available: contract.*, worked.*, period.*, employee.*, rules.CODE, categories.CODE. Functions: min, max, round, abs, floor, ceil, if." />
        )}

        <div className="form-grid">
          <SelectField label="Applies" name="condition_type" value={values.condition_type}
            error={errors.condition_type} onChange={set('condition_type')}
            options={[
              { value: 'always', label: 'Always' },
              { value: 'formula', label: 'Only when a condition holds' },
            ]} />
          {values.condition_type === 'formula' && (
            <TextField label="Condition" name="condition_expression" required
              value={values.condition_expression} error={errors.condition_expression}
              onChange={set('condition_expression')}
              placeholder="worked.overtime_hours > 0" />
          )}
        </div>

        <TextAreaField label="Note" name="note" value={values.note} error={errors.note}
          onChange={set('note')} hint="Shown on the configuration screen to explain the rule's intent." />
      </form>
    </Modal>
  );
}
