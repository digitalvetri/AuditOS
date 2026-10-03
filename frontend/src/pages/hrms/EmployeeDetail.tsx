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
import { EMPLOYEE_TYPE_LABEL, type EmployeeType } from '@/data/models';
import { EmployeeEditModal } from '@/modules/employees/EmployeeEditModal';
import { RoleField } from '@/modules/employees/RoleField';
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
import { CalendarDays, Mail, Pencil, Phone } from 'lucide-react';
import { EntityHeader, HeaderTag, MetaItem, headerBtn, type HeaderStat } from '@/components/EntityHeader';

/** Tenure, notice period and weekly capacity — straight from the record. */
function employeeStats(e: Employee): HeaderStat[] {
  const start = new Date(e.joining_date + 'T00:00:00Z');
  const end = e.exit_date ? new Date(e.exit_date + 'T00:00:00Z') : new Date();
  const months = Math.max(0, (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth()));
  const tenure = months >= 12 ? `${Math.floor(months / 12)}y ${months % 12}m` : `${months}m`;
  const out: HeaderStat[] = [
    { label: 'Tenure', value: tenure },
    { label: 'Notice period', value: `${e.notice_period_days} days` },
  ];
  if (e.weekly_capacity_hours) out.push({ label: 'Weekly capacity', value: `${e.weekly_capacity_hours} h` });
  if (e.exit_date) out.push({ label: 'Exit date', value: fmtDate(e.exit_date + 'T00:00:00Z'), tone: 'warn' });
  return out;
}

function EmployeeStatusChip({ status }: { status: string }) {
  const tone = status === 'active' ? 'ok' : status === 'inactive' ? 'bad' : 'warn';
  return <HeaderTag tone={tone}>● {status.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())}</HeaderTag>;
}

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
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] text-neutral-900">
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
      <EntityHeader
        name={emp.full_name}
        avatar={full ? (emp as Employee).photo_url : null}
        idLine={<>
          <span>{emp.employee_code}</span>
          {full ? <span>· {EMPLOYEE_TYPE_LABEL[(emp as Employee).type]}</span> : null}
        </>}
        chips={<>
          <EmployeeStatusChip status={emp.status} />
          {isOwn ? <HeaderTag tone="teal">You</HeaderTag> : null}
          {isArticled ? <HeaderTag>Articled</HeaderTag> : null}
        </>}
        meta={full ? <>
          <MetaItem icon={<Mail size={14} />} href={`mailto:${(emp as Employee).email}`}>{(emp as Employee).email}</MetaItem>
          {(emp as Employee).phone ? <MetaItem icon={<Phone size={14} />} href={`tel:${(emp as Employee).phone}`}>{(emp as Employee).phone}</MetaItem> : null}
          <MetaItem icon={<CalendarDays size={14} />}>Joined {fmtDate((emp as Employee).joining_date + 'T00:00:00Z')}</MetaItem>
        </> : undefined}
        actions={<>
          {(isOwn || canManage) && full ? (
            <button type="button" className={headerBtn}
              onClick={() => (canManage ? setEditHr(true) : setEditSelf(true))}
              data-testid="employee-edit-open">
              <Pencil size={14} />{canManage ? 'Edit' : 'Edit contact'}
            </button>
          ) : null}
          {canManage && !isOwn && emp.status !== 'inactive' ? (
            <DeactivateButton employeeId={emp.id} employeeName={emp.full_name} />
          ) : null}
        </>}
        stats={full ? employeeStats(emp as Employee) : undefined}
      />

      <div className="cl-views flex gap-1 border-b border-border overflow-x-auto" role="tablist">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              data-testid={`employee-tab-${t.id}`}
              className={'cl-view relative px-3 pt-2 pb-[10px] text-13 font-medium whitespace-nowrap transition-colors ' + (tab === t.id ? 'is-on text-ink' : 'text-inkMuted hover:text-ink')}
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
  refs: { department: { id: string; name: string } | null; designation: { id: string; name: string } | null; manager: { id: string; full_name: string; employee_code: string } | null; location: { id: string; name: string } | null; role: { id: string; code: string; name: string } | null };
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
        {isFull ? (
          <>
            <Field label="Type" value={EMPLOYEE_TYPE_LABEL[(emp as { type: EmployeeType }).type]} />
            <RoleField employeeId={emp.id} role={refs.role} />
            <Field label="Manager" value={refs.manager?.full_name ?? '—'} />
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

