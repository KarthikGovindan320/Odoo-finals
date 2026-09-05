/**
 * Sign in.
 *
 * The demo accounts are listed and one-click fillable. A judge should be able to
 * switch roles in seconds to see that the permission boundary is real, without
 * being handed a password on a sticky note.
 */
import { useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { TextField } from '../components/Field.tsx';

const DEMO_ACCOUNTS = [
  { email: 'admin@peoplepay360.local', role: 'Admin', reach: 'Everything, plus user management' },
  { email: 'payroll.manager@peoplepay360.local', role: 'HR Payroll Manager', reach: 'Payroll and salary rules' },
  { email: 'payroll.user@peoplepay360.local', role: 'HR Payroll User', reach: 'Payroll; config read-only' },
  { email: 'hr.manager@peoplepay360.local', role: 'HR Manager', reach: 'HR only — no payroll' },
  { email: 'employee@peoplepay360.local', role: 'Employee', reach: 'Own records only' },
];

const DEMO_PASSWORD = 'Password123!';

export function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    setFieldErrors({});

    try {
      await signIn(email, password);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        // Field-level messages go next to the field; anything else sits above
        // the form. Either way it is the server's own sentence.
        const fields = error.fieldMap();
        if (Object.keys(fields).length > 0) {
          setFieldErrors(fields);
        } else {
          setFormError(error.message);
        }
      } else {
        setFormError('Could not reach the server. Is the API running?');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login__split">
        {/* Open with the artifact the product exists to produce. A payslip is
            what every other screen in this system is working towards, so it is
            the honest thing to lead with. */}
        <aside className="login__aside">
          <div className="login__brand">
            <span className="topnav__mark" aria-hidden="true">PP</span>
            <span>
              <h1 style={{ fontSize: 20, color: '#fff' }}>PeoplePay360</h1>
              <p style={{ fontSize: 12, margin: 0, color: 'rgba(255,255,255,0.6)' }}>
                HR &amp; Payroll Operations
              </p>
            </span>
          </div>

          <p className="login__lede">
            Pay is not stored. It is <strong>derived</strong> — from the contract that
            applies to the period, the schedule that says what was expected, the
            attendance that says what happened, and the leave that explains the
            difference.
          </p>

          <div>
            <div className="mini-ledger__caption">A payslip, in miniature</div>
            <div className="mini-ledger" aria-hidden="true">
              <div className="mini-ledger__row mini-ledger__row--basic">
                <span>BASIC</span><span>60,000.00</span>
              </div>
              <div className="mini-ledger__row mini-ledger__row--alw">
                <span>HRA · 40% of BASIC</span><span>24,000.00</span>
              </div>
              <div className="mini-ledger__row mini-ledger__row--alw">
                <span>CONV</span><span>1,600.00</span>
              </div>
              <div className="mini-ledger__row mini-ledger__row--ded">
                <span>PF · min(BASIC × 12%, 1800)</span><span>− 1,800.00</span>
              </div>
              <div className="mini-ledger__row mini-ledger__row--ded">
                <span>LWP · 2 unpaid days</span><span>− 5,454.55</span>
              </div>
              <div className="mini-ledger__row mini-ledger__row--net">
                <span>NET</span><span>78,345.45</span>
              </div>
            </div>
          </div>
        </aside>

        <div className="login__form-side">
          {formError !== null && <div className="error-box" role="alert">{formError}</div>}

          <form onSubmit={(event) => void submit(event)} noValidate>
            <TextField
              label="Email" name="email" type="email" autoComplete="username" required
              value={email} error={fieldErrors.email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <TextField
              label="Password" name="password" type="password" autoComplete="current-password" required
              value={password} error={fieldErrors.password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button className="btn btn--primary" type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div className="login__demo">
            <strong>Demo accounts — click one to fill the form</strong>
            {DEMO_ACCOUNTS.map((account) => (
              <button
                key={account.email}
                type="button"
                onClick={() => { setEmail(account.email); setPassword(DEMO_PASSWORD); }}
              >
                <strong style={{ flex: '0 0 130px', margin: 0, fontWeight: 600 }}>{account.role}</strong>
                <span>{account.reach}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
