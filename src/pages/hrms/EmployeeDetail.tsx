/**
 * /hrms/employees/:id — full profile per §8.1.
 *
 * Tabs: Overview · Attendance · Leave · Payroll · Expenses · Documents ·
 * Training (articled only) · Activity.
 *
 * The `/me/profile` route mounts this component with the caller's own id.
 * All scope enforcement is server-side (403 on cross-scope access).
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { employeeApi, isFullEmployee } from '@/modules/employees/api';
import { EmployeeEditModal } from '@/modules/employees/EmployeeEditModal';
import { DeactivateButton } from '@/modules/employees/DeactivateButton';
import { ArticledTrainingTab } from '@/modules/employees/ArticledTrainingTab';
import { ActivityTab } from '@/modules/employees/ActivityTab';
import { RecordsTable } from '@/modules/attendance/RecordsTable';
import { BalancesCard } from '@/modules/leave/BalancesCard';
import { DocumentsTable } from '@/modules/documents/DocumentsTable';
import { UploadModal } from '@/modules/documents/UploadModal';
import { PayrollTab } from '@/modules/payroll/PayrollTab';
import { ExpensesTable } from '@/modules/expenses/ExpensesTable';
import { fmtDate } from '@/lib/format';
import { StatusLabel, type StatusVariant } from '@/components/StatusRow';
import { Button } from '@/components/Button';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import type { Employee } from '@/data/models';

type Tab = 'overview' | 'attendance' | 'leave' | 'payroll' | 'expenses' | 'documents' | 'training' | 'activity';

interface Props {
  /** When set, ignore :id from URL and use this instead. Used by /me/profile. */
  fixedId?: string;
}

export function EmployeeDetailPage({ fixedId }: Props) {
  const params = useParams<{ id: string }>();
  const id = fixedId ?? params.id!;
  const { session } = useAuth();
  const [tab, setTab] = useState<Tab>('overview');
  const [editSelf, setEditSelf] = useState(false);
  const [editHr, setEditHr] = useState(false);

  const q = useQuery({
    queryKey: ['employee', id],
    queryFn: () => employeeApi.get(id),
    retry: false,
  });

  if (q.isLoading) {
    return <div className="h-40 bg-neutral-100 " aria-label="Loading" />;
  }
  if (q.isError) {
    const status = (q.error as { status?: number }).status;
    return (
      <div className="max-w-[720px] mx-auto bg-white border border-neutral-200 rounded p-6">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">
          {status === 403 ? 'Access denied' : status === 404 ? 'Not found' : 'Error'}
        </div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">
          {status === 403
            ? 'You do not have access to this employee record.'
            : status === 404
              ? 'That employee record does not exist.'
              : 'Could not load employee.'}
        </h1>
        <div className="mt-4">
          <Link to="/hrms/employees" className="text-13 text-gold hover:text-gold-hover">
            Back to Employees
          </Link>
        </div>
      </div>
    );
  }

  const emp = q.data!.employee;
  const refs = q.data!.refs;
  const isOwn = session?.employee?.id === id;
  const canManage = can(session?.role.code, 'employee.manage', 'organisation');
  const isArticled = isFullEmployee(emp) && emp.type === 'articled';
  const full = isFullEmployee(emp);

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: 'overview', label: 'Overview', show: true },
    { id: 'attendance', label: 'Attendance', show: full },
    { id: 'leave', label: 'Leave', show: full && (isOwn || canManage) },
    { id: 'payroll', label: 'Payroll', show: full && (isOwn || canManage) },
    { id: 'expenses', label: 'Expenses', show: full && (isOwn || canManage) },
    { id: 'documents', label: 'Documents', show: full },
    { id: 'training', label: 'Training', show: full && isArticled },
    { id: 'activity', label: 'Activity', show: full },
  ];

  return (
    <div className="space-y-6">
      <div>
        <Link to="/hrms/employees" className="text-13 text-neutral-500 hover:text-neutral-900">
          ← Employees
        </Link>
      </div>
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">
            {emp.employee_code}
          </div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-1">
            {emp.full_name}
          </h1>
          <p className="text-13 text-neutral-500 mt-1">
            {refs.designation?.name ?? '—'} · {refs.department?.name ?? '—'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {(isOwn || canManage) && full ? (
            <Button
              variant="secondary"
              onClick={() => (canManage ? setEditHr(true) : setEditSelf(true))}
              data-testid="employee-edit-open"
            >
              {canManage ? 'Edit' : 'Edit contact'}
            </Button>
          ) : null}
          {canManage && !isOwn && emp.status !== 'inactive' ? (
            <DeactivateButton employeeId={emp.id} employeeName={emp.full_name} />
          ) : null}
        </div>
      </header>

      <div className="border-b border-neutral-200 flex items-center gap-4 flex-wrap">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              data-testid={`employee-tab-${t.id}`}
              className={
                'h-10 px-1 text-13 -mb-px border-b-2 ' +
                (tab === t.id
                  ? 'border-gold text-neutral-900 font-medium'
                  : 'border-transparent text-neutral-500 hover:text-neutral-900')
              }
            >
              {t.label}
            </button>
          ))}
      </div>

      {tab === 'overview' ? <OverviewTab emp={emp} refs={refs} isFull={full} /> : null}
      {tab === 'attendance' && full ? <RecordsTable defaultEmployeeId={emp.id} /> : null}
      {tab === 'leave' && full ? <BalancesCard /> : null}
      {tab === 'payroll' && full ? <PayrollTab employeeId={emp.id} canManageSalary={canManage} /> : null}
      {tab === 'expenses' && full ? <ExpensesTable mode="employee-profile" employeeId={emp.id} /> : null}
      {tab === 'documents' && full ? (
        <DocumentsInProfile employeeId={emp.id} canManage={canManage || isOwn} />
      ) : null}
      {tab === 'training' && full && isArticled ? (
        <ArticledTrainingTab employeeId={emp.id} canEdit={canManage} />
      ) : null}
      {tab === 'activity' && full ? <ActivityTab employeeId={emp.id} /> : null}

      {full ? (
        <>
          <EmployeeEditModal
            open={editSelf}
            onClose={() => setEditSelf(false)}
            employee={emp as Employee}
            mode="self"
          />
          <EmployeeEditModal
            open={editHr}
            onClose={() => setEditHr(false)}
            employee={emp as Employee}
            mode="hr"
          />
        </>
      ) : null}

    </div>
  );
}

function statusToVariant(s: string): { variant: StatusVariant; label: string } {
  switch (s) {
    case 'active':
      return { variant: 'ok', label: 'Active' };
    case 'on_leave':
      return { variant: 'awaiting', label: 'On Leave' };
    case 'probation':
      return { variant: 'pending', label: 'Probation' };
    case 'notice_period':
      return { variant: 'pending', label: 'Notice Period' };
    case 'inactive':
      return { variant: 'problem', label: 'Inactive' };
    default:
      return { variant: 'awaiting', label: s };
  }
}

function OverviewTab({
  emp,
  refs,
  isFull,
}: {
  emp: ReturnType<typeof employeeApi.get> extends Promise<infer T> ? (T extends { employee: infer E } ? E : never) : never;
  refs: { department: { id: string; name: string } | null; designation: { id: string; name: string } | null; manager: { id: string; full_name: string; employee_code: string } | null; location: { id: string; name: string } | null };
  isFull: boolean;
}) {
  const s = statusToVariant(emp.status);
  return (
    <div className="space-y-6" data-testid="employee-overview">
      <div className="bg-white border border-neutral-200 rounded p-4">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Status</div>
        <div className="mt-2">
          <StatusLabel variant={s.variant} label={s.label} />
        </div>
      </div>

      <SectionGrid title="Employment">
        <Field label="Code" value={emp.employee_code} />
        <Field label="Department" value={refs.department?.name ?? '—'} />
        <Field label="Designation" value={refs.designation?.name ?? '—'} />
        {isFull ? (
          <>
            <Field label="Type" value={(emp as { type: string }).type} />
            <Field label="Manager" value={refs.manager?.full_name ?? '—'} />
            <Field label="Work location" value={refs.location?.name ?? '—'} />
            <Field label="Joining date" value={fmtDate((emp as { joining_date: string }).joining_date + 'T00:00:00Z')} />
          </>
        ) : null}
      </SectionGrid>

      {isFull ? (
        <SectionGrid title="Contact">
          <Field label="Email" value={(emp as { email: string }).email} />
          <Field label="Phone" value={(emp as { phone: string }).phone || '—'} />
          <Field label="Address" value={(emp as { address: string | null }).address ?? '—'} />
          <Field label="Emergency contact" value={
            (emp as { emergency_contact_name: string | null; emergency_contact_phone: string | null }).emergency_contact_name
              ? `${(emp as { emergency_contact_name: string }).emergency_contact_name} · ${(emp as { emergency_contact_phone: string | null }).emergency_contact_phone ?? ''}`
              : '—'
          } />
          <Field label="Bank" value={(emp as { bank_account_masked: string | null }).bank_account_masked ?? '—'} />
        </SectionGrid>
      ) : (
        <SectionGrid title="Finance projection">
          <Field label="Bank" value={emp.bank_account_masked ?? '—'} />
        </SectionGrid>
      )}
    </div>
  );
}

function SectionGrid({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-neutral-200 rounded p-4">
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{title}</div>
      <div className="mt-3 grid grid-cols-2 md:grid-cols-3 gap-4">{children}</div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div>
      <div className="text-13 text-neutral-900 mt-1">{value}</div>
    </div>
  );
}

function DocumentsInProfile({ employeeId, canManage }: { employeeId: string; canManage: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {canManage ? (
          <Button variant="secondary" onClick={() => setOpen(true)} data-testid="profile-doc-upload">
            Upload document
          </Button>
        ) : null}
      </div>
      <DocumentsTable employeeId={employeeId} showEmployeeColumn={false} />
      <UploadModal open={open} onClose={() => setOpen(false)} fixedEmployeeId={employeeId} />
    </div>
  );
}

