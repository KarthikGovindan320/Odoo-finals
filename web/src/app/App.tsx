/**
 * Routing and the application shell.
 *
 * Navigation is filtered by permission so a role never sees a menu item that
 * would 403 -- HR Manager, which the spec gives no payroll access at all, simply
 * has no Payroll menu. The server enforces the same boundary independently.
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';

import { useAuth } from '../lib/auth.tsx';
import { LoginPage } from '../features/LoginPage.tsx';
import { SplashScreen } from '../features/SplashScreen.tsx';
import { hasSeenSplash, markSplashSeen } from '../lib/splash.ts';
import { Breadcrumb } from './Breadcrumb.tsx';

/**
 * Feature pages load on demand.
 *
 * Every page was statically imported into one bundle, so an Employee -- who can
 * reach three screens -- downloaded the payrun wizard, the salary rule editor
 * and the dashboard charts before seeing their own payslip.
 *
 * LoginPage is deliberately not lazy: it is the first thing an unauthenticated
 * visitor needs, and a loading flash in front of a login form is worse than the
 * few kilobytes it saves.
 */
const DashboardPage = lazy(() =>
  import('../features/DashboardPage.tsx').then((m) => ({ default: m.DashboardPage })));
const EmployeesPage = lazy(() =>
  import('../features/EmployeesPage.tsx').then((m) => ({ default: m.EmployeesPage })));
const EmployeeDetailPage = lazy(() =>
  import('../features/EmployeeDetailPage.tsx').then((m) => ({ default: m.EmployeeDetailPage })));
const ContractsPage = lazy(() =>
  import('../features/ContractsPage.tsx').then((m) => ({ default: m.ContractsPage })));
const SchedulesPage = lazy(() =>
  import('../features/SchedulesPage.tsx').then((m) => ({ default: m.SchedulesPage })));
const AttendancePage = lazy(() =>
  import('../features/AttendancePage.tsx').then((m) => ({ default: m.AttendancePage })));
const TimeOffPage = lazy(() =>
  import('../features/TimeOffPage.tsx').then((m) => ({ default: m.TimeOffPage })));
const PayrollPage = lazy(() =>
  import('../features/PayrollPage.tsx').then((m) => ({ default: m.PayrollPage })));
const PayrunDetailPage = lazy(() =>
  import('../features/PayrunDetailPage.tsx').then((m) => ({ default: m.PayrunDetailPage })));
const PayslipDetailPage = lazy(() =>
  import('../features/PayslipDetailPage.tsx').then((m) => ({ default: m.PayslipDetailPage })));
const SalaryConfigPage = lazy(() =>
  import('../features/SalaryConfigPage.tsx').then((m) => ({ default: m.SalaryConfigPage })));
const AuditPage = lazy(() =>
  import('../features/AuditPage.tsx').then((m) => ({ default: m.AuditPage })));

type NavItem = { to: string; label: string; permission: string };

/**
 * Where a role lands on signing in, and what its first menu item is.
 *
 * Derived from permissions rather than from a list of role codes, because the
 * permissions already say it: a role that can only read its own employee record
 * has one record to look at, and a role with no dashboard has no report screen
 * to land on. Keying off role names instead would go stale the moment somebody
 * edits a role, and go silently stale, since a wrong landing page looks like a
 * preference rather than a bug.
 */
function landingFor(
  can: (permission: string) => boolean,
  scopeOf: (permission: string) => 'own' | 'all' | null,
): string {
  if (scopeOf('employee:read') === 'own') return '/profile';
  if (can('dashboard:read')) return '/dashboard';
  if (can('employee:read')) return '/employees';
  // Any role narrower than the seeded five still gets somewhere it can be.
  return NAV_ITEMS.find((item) => can(item.permission))?.to ?? '/profile';
}

/**
 * Renders its children only when the role holds the permission.
 *
 * Navigation was already filtered, but the routes were not: an Employee typing
 * /salary-config got the full page chrome and then a red 403 box where the
 * content should be. The server refuses correctly either way -- this is about
 * the app saying so plainly instead of appearing broken.
 */
function RequirePermission({
  permission, children,
}: {
  permission: string;
  children: ReactNode;
}) {
  const { can } = useAuth();

  if (can(permission)) {
    return <>{children}</>;
  }

  return (
    <div className="panel">
      <div className="panel__body">
        <h1>You do not have access to this</h1>
        <p className="muted">
          Your role does not include this area. If you think it should, ask an administrator.
        </p>
        <NavLink className="btn btn--primary" to="/">Go to your home page</NavLink>
      </div>
    </div>
  );
}

const NAV_ITEMS: NavItem[] = [
  // Replaced by Profile for a role scoped to its own record -- see navFor().
  { to: '/employees', label: 'Employees', permission: 'employee:read' },
  { to: '/contracts', label: 'Contracts', permission: 'contract:read' },
  { to: '/attendance', label: 'Attendance', permission: 'attendance:read' },
  { to: '/time-off', label: 'Time Off', permission: 'timeoff:read' },
  { to: '/payroll', label: 'Payroll', permission: 'payrun:read' },
  { to: '/salary-config', label: 'Configuration', permission: 'salary_config:read' },
  { to: '/audit', label: 'Audit', permission: 'audit:read' },
  { to: '/dashboard', label: 'Reports', permission: 'dashboard:read' },
];

/**
 * The menu for this role.
 *
 * An employee sees "Profile" rather than "Employees": the list they would get
 * has exactly one row in it, which is a table of themselves, and the search box,
 * pagination and kanban toggle above it are all controls for a problem they do
 * not have.
 */
function navFor(
  can: (permission: string) => boolean,
  scopeOf: (permission: string) => 'own' | 'all' | null,
): NavItem[] {
  const ownRecordOnly = scopeOf('employee:read') === 'own';

  return NAV_ITEMS
    .filter((item) => can(item.permission))
    .map((item) => (item.to === '/employees' && ownRecordOnly
      ? { ...item, to: '/profile', label: 'Profile' }
      : item));
}

export function App() {
  const { user, loading, signOut, can, scopeOf, arrivedBySignIn, clearArrival } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // Read once on mount, not on every render: the splash is dismissed by writing
  // to storage, and re-reading would tear it away mid-animation.
  const [splashDone, setSplashDone] = useState(hasSeenSplash);

  if (loading) {
    return <div className="loading">Loading PeoplePay360…</div>;
  }

  if (user === null) {
    return (
      <>
        <LoginPage />
        {!splashDone && (
          <SplashScreen
            onContinue={() => {
              markSplashSeen();
              setSplashDone(true);
            }}
          />
        )}
      </>
    );
  }

  const visibleNav = navFor(can, scopeOf);
  const home = landingFor(can, scopeOf);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <nav className="topnav">
        <span className="topnav__brand">
          <img className="topnav__mark" src="/logo-64.png" alt="" />
          PeoplePay360
        </span>

        <div className="topnav__links">
          {visibleNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `topnav__link${isActive ? ' topnav__link--active' : ''}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </div>

        <div className="topnav__user">
          <span className="topnav__username">{user.employee_name ?? user.email}</span>
          <span className="topnav__role">{user.role_name}</span>
          <button className="btn btn--sm" onClick={() => void signOut()}>Sign out</button>
        </div>
      </nav>

      <SignInLanding home={home} active={arrivedBySignIn} onDone={clearArrival} />

      <Breadcrumb key={location.pathname} />

      <main className="page" id="main" tabIndex={-1}>
        <Suspense fallback={<div className="loading">Loading…</div>}>
        <Routes>
          <Route path="/" element={<Navigate to={home} replace />} />
          <Route path="/dashboard" element={<RequirePermission permission="dashboard:read"><DashboardPage /></RequirePermission>} />
          <Route path="/profile" element={<RequirePermission permission="employee:read"><ProfilePage /></RequirePermission>} />
          <Route path="/employees" element={<RequirePermission permission="employee:read"><EmployeesPage /></RequirePermission>} />
          <Route path="/employees/:id" element={<RequirePermission permission="employee:read"><EmployeeDetailPage /></RequirePermission>} />
          <Route path="/contracts" element={<RequirePermission permission="contract:read"><ContractsPage /></RequirePermission>} />
          <Route path="/working-schedules" element={<RequirePermission permission="schedule:read"><SchedulesPage /></RequirePermission>} />
          <Route path="/attendance" element={<RequirePermission permission="attendance:read"><AttendancePage /></RequirePermission>} />
          <Route path="/time-off" element={<RequirePermission permission="timeoff:read"><TimeOffPage /></RequirePermission>} />
          <Route path="/payroll" element={<RequirePermission permission="payrun:read"><PayrollPage /></RequirePermission>} />
          <Route path="/payroll/payruns/:id" element={<RequirePermission permission="payrun:read"><PayrunDetailPage /></RequirePermission>} />
          <Route path="/payroll/payslips/:id" element={<RequirePermission permission="payrun:read"><PayslipDetailPage /></RequirePermission>} />
          <Route path="/salary-config" element={<RequirePermission permission="salary_config:read"><SalaryConfigPage /></RequirePermission>} />
          <Route path="/audit" element={<RequirePermission permission="audit:read"><AuditPage /></RequirePermission>} />
          <Route path="*" element={<NotFound home={home} />} />
        </Routes>
        </Suspense>
      </main>
    </div>
  );
}

/**
 * Moves a session to its landing page once, on arrival.
 *
 * Fixes the case that prompted it: sign out from /dashboard, sign back in as an
 * employee, and the URL was still /dashboard -- so the app rendered a
 * permission refusal at the very first thing the new session saw. Nothing was
 * broken; the address bar was simply left over from somebody else's session.
 *
 * Done as an effect rather than a <Navigate>, so it replaces the entry instead
 * of pushing one: Back from the landing page should leave the app, not return
 * to a page the current role cannot open.
 */
function SignInLanding({
  home, active, onDone,
}: {
  home: string;
  active: boolean;
  onDone: () => void;
}) {
  const navigate = useNavigate();

  useEffect(() => {
    if (!active) return;
    onDone();
    navigate(home, { replace: true });
  }, [active, home, navigate, onDone]);

  return null;
}

/**
 * An employee's own record, opened directly.
 *
 * The same screen the list opens, reached without the list: there is one record
 * this role can see, and making them pick it out of a table of one is a step
 * that exists only because the route was built for somebody else.
 */
function ProfilePage() {
  const { user } = useAuth();

  if (user?.employee_id == null) {
    return (
      <div className="panel">
        <div className="panel__body">
          <h1>No employee record</h1>
          <p className="muted">
            Your user account is not linked to an employee record, so there is no profile to show.
            Ask an administrator to link it.
          </p>
        </div>
      </div>
    );
  }

  return <EmployeeDetailPage employeeId={user.employee_id} />;
}

function NotFound({ home }: { home: string }) {
  return (
    <div className="panel">
      <div className="panel__body">
        <h1>That page does not exist</h1>
        <p className="muted">The link may be out of date.</p>
        <NavLink className="btn btn--primary" to={home}>Go back</NavLink>
      </div>
    </div>
  );
}
