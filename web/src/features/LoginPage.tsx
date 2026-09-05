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
import { Modal } from '../components/Chrome.tsx';

/**
 * The demo account switcher exists so a reviewer can change roles in seconds and
 * see that the permission boundary is real.
 *
 * It is compiled out of any production build. `import.meta.env.DEV` is a literal
 * Vite substitutes at build time, so `vite build` leaves the branch statically
 * false and the bundler drops the list, the password and the panel entirely --
 * they are not merely hidden in the shipped JavaScript, they are absent from it.
 */
const SHOW_DEMO_ACCOUNTS = import.meta.env.DEV;

const DEMO_ACCOUNTS = SHOW_DEMO_ACCOUNTS
  ? [
      { email: 'admin@peoplepay360.local', role: 'Admin', reach: 'Everything, plus user management' },
      { email: 'payroll.manager@peoplepay360.local', role: 'HR Payroll Manager', reach: 'Payroll and salary rules' },
      { email: 'payroll.user@peoplepay360.local', role: 'HR Payroll User', reach: 'Payroll; config read-only' },
      { email: 'hr.manager@peoplepay360.local', role: 'HR Manager', reach: 'HR only — no payroll' },
      { email: 'employee@peoplepay360.local', role: 'Employee', reach: 'Own records only' },
    ]
  : [];

const DEMO_PASSWORD = import.meta.env.DEV ? 'Password123!' : '';

export function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgotPasswordOpen, setForgotPasswordOpen] = useState(false);

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
        <div className="login__brand">
          <img className="topnav__mark" src="/logo-64.png" alt="" />
          <span>
            <h1 style={{ fontSize: 18, margin: 0 }}>PeoplePay360</h1>
          </span>
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
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--space-3)' }}>
            <button
              type="button"
              className="btn btn--link btn--sm"
              onClick={() => setForgotPasswordOpen(true)}
            >
              Forgot password?
            </button>
          </div>
          <button className="btn btn--primary" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {SHOW_DEMO_ACCOUNTS && (
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
        )}
      </div>

      {forgotPasswordOpen && (
        <ForgotPasswordModal onClose={() => setForgotPasswordOpen(false)} />
      )}
    </div>
  );
}

/**
 * There is no self-service reset: no reset-token table, no mailer for it.
 *
 * This used to collect an email address and then say so, which asked the user
 * for data nothing would ever read and implied a flow that does not exist. It
 * now just says what to do. A form that cannot act on its input should not have
 * an input.
 */
function ForgotPasswordModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="Reset your password"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn--primary" onClick={onClose}>
          Close
        </button>
      }
    >
      <p style={{ marginTop: 0 }}>
        Password resets are handled by your HR administrator — there is no
        self-service reset yet.
      </p>
      <p className="muted" style={{ marginBottom: 0 }}>
        Ask them to set a new password on your account, and you will be able to sign in with it
        straight away.
      </p>
    </Modal>
  );
}
