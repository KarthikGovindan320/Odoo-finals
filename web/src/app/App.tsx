/**
 * Routing and the application shell.
 *
 * Navigation is filtered by permission so a role never sees a menu item that
 * would 403 -- HR Manager, which the spec gives no payroll access at all, simply
 * has no Payroll menu. The server enforces the same boundary independently.
 */
import { Suspense, lazy, useState } from 'react';
import type { ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router';

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

type NavItem = { to: string; label: string; permission: string };

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
  { to: '/employees', label: 'Employees', permission: 'employee:read' },
  { to: '/contracts', label: 'Contracts', permission: 'contract:read' },
  { to: '/attendance', label: 'Attendance', permission: 'attendance:read' },
  { to: '/time-off', label: 'Time Off', permission: 'timeoff:read' },
  { to: '/payroll', label: 'Payroll', permission: 'payrun:read' },
  { to: '/salary-config', label: 'Configuration', permission: 'salary_config:read' },
  { to: '/dashboard', label: 'Reports', permission: 'dashboard:read' },
];

export function App() {
  const { user, loading, signOut, can } = useAuth();
  const location = useLocation();

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

  const visibleNav = NAV_ITEMS.filter((item) => can(item.permission));

  // Employees have no dashboard; send them somewhere they can actually be.
  const home = can('dashboard:read') ? '/dashboard' : '/employees';

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

      <Breadcrumb key={location.pathname} />

      <main className="page" id="main" tabIndex={-1}>
        <Suspense fallback={<div className="loading">Loading…</div>}>
        <Routes>
          <Route path="/" element={<Navigate to={home} replace />} />
          <Route path="/dashboard" element={<RequirePermission permission="dashboard:read"><DashboardPage /></RequirePermission>} />
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
          <Route path="*" element={<NotFound home={home} />} />
        </Routes>
        </Suspense>
      </main>
    </div>
  );
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
