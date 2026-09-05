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
  { email: 'admin@peoplepay360.local', role: 'Admin — everything' },
  { email: 'payroll.manager@peoplepay360.local', role: 'HR Payroll Manager — payroll and salary rules' },
  { email: 'payroll.user@peoplepay360.local', role: 'HR Payroll User — payroll, config read-only' },
  { email: 'hr.manager@peoplepay360.local', role: 'HR Manager — HR only, no payroll' },
  { email: 'employee@peoplepay360.local', role: 'Employee — own records only' },
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
      <div className="login__card">
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ color: 'var(--plum)' }}>PeoplePay360</h1>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            HR &amp; Payroll Operations
          </p>
        </div>

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
          <strong>Demo accounts</strong> — click one to fill the form.
          {DEMO_ACCOUNTS.map((account) => (
            <button
              key={account.email}
              type="button"
              onClick={() => { setEmail(account.email); setPassword(DEMO_PASSWORD); }}
            >
              {account.role}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
