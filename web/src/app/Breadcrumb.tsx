/**
 * The breadcrumb trail.
 *
 * Derived from the URL rather than maintained as state, so it can never drift
 * out of step with where the user actually is. Deep links show the full path
 * immediately, which is what makes the trail worth having.
 */
import { Link, useLocation } from 'react-router';

/**
 * Paths a crumb may link to. A segment absent from this set is rendered as plain
 * text rather than a link: the trail is built by joining segments, and
 * /payroll/payruns and /payroll/payslips are groupings in the URL rather than
 * routes, so linking them landed the user on the 404 page.
 */
const LINKABLE_PATHS = new Set([
  '/dashboard', '/employees', '/profile', '/contracts', '/working-schedules',
  '/attendance', '/time-off', '/payroll', '/salary-config',
]);

const SEGMENT_LABELS: Record<string, string> = {
  dashboard: 'Reports',
  employees: 'Employees',
  profile: 'Profile',
  contracts: 'Contracts',
  'working-schedules': 'Working Schedules',
  attendance: 'Attendance',
  'time-off': 'Time Off',
  payroll: 'Payroll',
  payruns: 'Payruns',
  payslips: 'Payslips',
  'salary-config': 'Configuration',
};

export function Breadcrumb() {
  const { pathname } = useLocation();
  const segments = pathname.split('/').filter(Boolean);

  if (segments.length === 0) {
    return <div className="breadcrumb"><span className="breadcrumb__current">Home</span></div>;
  }

  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      {segments.map((segment, index) => {
        const path = `/${segments.slice(0, index + 1).join('/')}`;
        const isLast = index === segments.length - 1;
        // A bare id segment reads better as a reference than as a number.
        const label = SEGMENT_LABELS[segment] ?? (/^\d+$/.test(segment) ? `#${segment}` : segment);

        return (
          <span key={path} style={{ display: 'contents' }}>
            {index > 0 && <span className="breadcrumb__sep">/</span>}
            {isLast || !LINKABLE_PATHS.has(path) ? (
              <span className={isLast ? 'breadcrumb__current' : 'breadcrumb__step'}>{label}</span>
            ) : (
              <Link to={path}>{label}</Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
