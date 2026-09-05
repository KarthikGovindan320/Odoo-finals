/**
 * The employee form: the operational hub.
 *
 * Smart buttons carry counts and open the related list already filtered to this
 * employee, which is what turns six modules into one system. The counts come back
 * with the record in a single request rather than six.
 */
import { useState } from 'react';
import { useParams } from 'react-router';

import { useResource } from '../lib/use_resource.ts';
import { formatDate, formatMoney, humanize, stateVariant } from '../lib/format.ts';
import { useAuth } from '../lib/auth.tsx';
import { useBackTo } from '../lib/use_back_to.ts';
import { Badge, DetailRow, Panel, SmartButton, StatusBar } from '../components/Chrome.tsx';
import { EmployeeFormModal } from './EmployeeFormModal.tsx';

type EmployeeDetail = {
  id: number;
  employee_number: string;
  first_name: string; last_name: string;
  work_email: string; personal_email: string | null; work_phone: string | null;
  status: string; hire_date: string; termination_date: string | null;
  department_id: number | null; job_position_id: number | null;
  employment_type_id: number | null; manager_id: number | null; working_schedule_id: number | null;
  department_name: string | null; job_title: string | null;
  employment_type_name: string | null; manager_name: string | null; schedule_name: string | null;
  bank_name: string | null; bank_account_number: string | null; bank_ifsc: string | null;
  address: string | null; current_wage: number | null; current_wage_type: string | null;
  contract_count: number; attendance_count: number;
  time_off_count: number; allocation_count: number; payslip_count: number;
};

type Balance = {
  type_code: string; type_name: string; unit: string;
  allocated: number; taken: number; remaining: number;
};

export function EmployeeDetailPage() {
  const { id } = useParams();
  const backToList = useBackTo('/employees');
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);

  const { data, loading, error, reload } = useResource<EmployeeDetail>(`/employees/${id}`);
  const balances = useResource<{ rows: Balance[] }>(`/time-off/balances?employee_id=${id}`);

  if (loading) return <div className="loading">Loading employee…</div>;
  if (error !== null) return <div className="error-box">{error}</div>;
  if (data === null) return null;

  return (
    <>
      <div className="page__header">
        <div className="page__title">
          <h1>{data.first_name} {data.last_name}</h1>
          <span className="page__subtitle">
            <span className="mono">{data.employee_number}</span>
            {data.job_title !== null && ` · ${data.job_title}`}
            {data.department_name !== null && ` · ${data.department_name}`}
          </span>
        </div>
        <div className="page__actions">
          {can('employee:write') && (
            <button className="btn btn--primary" onClick={() => setEditing(true)}>Edit</button>
          )}
        </div>
      </div>

      <Panel>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      flexWrap: 'wrap', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
          <StatusBar steps={['active', 'on_leave', 'terminated']} current={data.status} terminal={[]} />
          {data.current_wage !== null && (
            <span className="muted" style={{ fontSize: 13 }}>
              {/* The unit comes from the contract. Hardcoding "/ month" printed
                  an hourly contract's rate as though it were a monthly salary. */}
              Current wage <strong style={{ color: 'var(--text)' }}>{formatMoney(data.current_wage)}</strong>
              {data.current_wage_type === 'hourly' ? ' / hour' : ' / month'}
            </span>
          )}
        </div>

        <div className="smart-buttons">
          <SmartButton count={data.contract_count} label="Contracts"
            to={`/contracts?employee_id=${data.id}`} />
          <SmartButton count={data.attendance_count} label="Attendance"
            to={`/attendance?employee_id=${data.id}`} />
          <SmartButton count={data.time_off_count} label="Time off"
            to={`/time-off?employee_id=${data.id}&tab=requests`} />
          <SmartButton count={data.allocation_count} label="Allocations"
            to={`/time-off?employee_id=${data.id}&tab=allocations`} />
          {can('payrun:read') && (
            <SmartButton count={data.payslip_count} label="Payslips"
              to={`/payroll?tab=payslips&employee_id=${data.id}`} />
          )}
        </div>
      </Panel>

      <div className="grid-2">
        <Panel title="Work details">
          <dl style={{ margin: 0 }}>
            <DetailRow label="Department" value={data.department_name} />
            <DetailRow label="Job position" value={data.job_title} />
            <DetailRow label="Employee type" value={data.employment_type_name} />
            <DetailRow label="Manager" value={data.manager_name} />
            <DetailRow label="Working schedule" value={data.schedule_name} />
            <DetailRow label="Hire date" value={formatDate(data.hire_date)} />
            {data.termination_date !== null && (
              <DetailRow label="Termination date" value={formatDate(data.termination_date)} />
            )}
            <DetailRow label="Status" value={<Badge variant={stateVariant(data.status)}>{humanize(data.status)}</Badge>} />
          </dl>
        </Panel>

        <Panel title="Contact and payment">
          <dl style={{ margin: 0 }}>
            <DetailRow label="Work email" value={data.work_email} />
            <DetailRow label="Personal email" value={data.personal_email} />
            <DetailRow label="Work phone" value={data.work_phone} />
            <DetailRow label="Bank" value={data.bank_name} />
            <DetailRow
              label="Account"
              value={
                data.bank_account_number === null ? (
                  <Badge variant="warning">Missing — payroll will warn</Badge>
                ) : (
                  <span className="mono">····{data.bank_account_number.slice(-4)}</span>
                )
              }
            />
            <DetailRow label="IFSC" value={data.bank_ifsc} />
            <DetailRow label="Address" value={data.address} />
          </dl>
        </Panel>
      </div>

      <Panel title="Leave balances" flush>
        {balances.data === null || balances.data.rows.length === 0 ? (
          <div className="table__empty">No active allocations for this employee.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th className="table__num">Allocated</th>
                <th className="table__num">Taken</th>
                <th className="table__num">Remaining</th>
              </tr>
            </thead>
            <tbody>
              {balances.data.rows.map((row) => (
                <tr key={row.type_code}>
                  <td>{row.type_name}</td>
                  <td className="table__num">{Number(row.allocated)} {row.unit}s</td>
                  <td className="table__num">{Number(row.taken)}</td>
                  <td className="table__num">
                    <strong>{Number(row.remaining)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <button className="btn" onClick={backToList}>← Back to employees</button>

      {editing && (
        <EmployeeFormModal
          employeeId={data.id}
          initial={{
            employee_number: data.employee_number,
            first_name: data.first_name, last_name: data.last_name,
            work_email: data.work_email, personal_email: data.personal_email ?? '',
            work_phone: data.work_phone ?? '',
            department_id: data.department_id === null ? '' : String(data.department_id),
            job_position_id: data.job_position_id === null ? '' : String(data.job_position_id),
            employment_type_id: data.employment_type_id === null ? '' : String(data.employment_type_id),
            manager_id: data.manager_id === null ? '' : String(data.manager_id),
            working_schedule_id: data.working_schedule_id === null ? '' : String(data.working_schedule_id),
            hire_date: data.hire_date, status: data.status,
            termination_date: data.termination_date ?? '',
            bank_name: data.bank_name ?? '', bank_account_number: data.bank_account_number ?? '',
            bank_ifsc: data.bank_ifsc ?? '', address: data.address ?? '',
          }}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); reload(); }}
        />
      )}
    </>
  );
}
