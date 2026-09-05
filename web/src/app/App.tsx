/**
 * Routing and the application shell.
 *
 * Navigation is filtered by permission so a role never sees a menu item that
 * would 403 -- HR Manager, which the spec gives no payroll access at all, simply
 * has no Payroll menu. The server enforces the same boundary independently.
 */
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router';

import { useAuth } from '../lib/auth.tsx';
import { LoginPage } from '../features/LoginPage.tsx';
import { DashboardPage } from '../features/DashboardPage.tsx';
import { EmployeesPage } from '../features/EmployeesPage.tsx';
import { EmployeeDetailPage } from '../features/EmployeeDetailPage.tsx';
import { ContractsPage } from '../features/ContractsPage.tsx';
import { SchedulesPage } from '../features/SchedulesPage.tsx';
import { AttendancePage } from '../features/AttendancePage.tsx';
import { TimeOffPage } from '../features/TimeOffPage.tsx';
import { PayrollPage } from '../features/PayrollPage.tsx';
import { PayrunDetailPage } from '../features/PayrunDetailPage.tsx';
import { PayslipDetailPage } from '../features/PayslipDetailPage.tsx';
import { SalaryConfigPage } from '../features/SalaryConfigPage.tsx';
import { Breadcrumb } from './Breadcrumb.tsx';

type NavItem = { to: string; label: string; permission: string };

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

  if (loading) {
    return <div className="loading">Loading PeoplePay360…</div>;
  }

  if (user === null) {
    return <LoginPage />;
  }

  const visibleNav = NAV_ITEMS.filter((item) => can(item.permission));

  // Employees have no dashboard; send them somewhere they can actually be.
  const home = can('dashboard:read') ? '/dashboard' : '/employees';

  return (
    <div className="app-shell">
      <nav className="topnav">
        <span className="topnav__brand">
          <span className="topnav__mark">PP</span>
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

      <main className="page">
        <Routes>
          <Route path="/" element={<Navigate to={home} replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/employees" element={<EmployeesPage />} />
          <Route path="/employees/:id" element={<EmployeeDetailPage />} />
          <Route path="/contracts" element={<ContractsPage />} />
          <Route path="/working-schedules" element={<SchedulesPage />} />
          <Route path="/attendance" element={<AttendancePage />} />
          <Route path="/time-off" element={<TimeOffPage />} />
          <Route path="/payroll" element={<PayrollPage />} />
          <Route path="/payroll/payruns/:id" element={<PayrunDetailPage />} />
          <Route path="/payroll/payslips/:id" element={<PayslipDetailPage />} />
          <Route path="/salary-config" element={<SalaryConfigPage />} />
          <Route path="*" element={<NotFound home={home} />} />
        </Routes>
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
