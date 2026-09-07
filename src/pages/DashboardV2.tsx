/**
 * UI-BUILD-PROMPT §5 dashboard.
 *
 * Layout: timestamp line, TODAY card (full width), then a 2-column grid that
 * collapses to 1 column below 1024px, 20px gap. Each pair of cards sits in
 * one row: (Today's attendance, Expenses to action) · (Attendance breakdown,
 * Ledger) · (Departments, Payroll).
 *
 * Every figure comes from the dashboard service — never a literal.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { X } from 'lucide-react';
import { Card } from '@/modules/dashboardV2/Card';
import {
  fetchDashboard, checkIn, checkOut,
  type AttendanceCounts, type ExpensesSnapshot, type LedgerSnapshot,
  type PayrollSnapshot, type TodayState, type DepartmentRow,
} from '@/modules/dashboardV2/service';
import { formatDate, formatDuration, formatINR, formatTime } from '@/modules/dashboardV2/format';

export function DashboardV2Page() {
  const q = useQuery({ queryKey: ['dashboardV2'], queryFn: fetchDashboard, refetchOnWindowFocus: false });

  return (
    <div className="space-y-5">
      <TimestampLine />

      {q.isLoading ? (
        <Card title="Today"><span /></Card>
      ) : q.isError || !q.data ? (
        <Card title="Today" error="Could not load dashboard."><span /></Card>
      ) : (
        <TodayCard today={q.data.today} />
      )}

      <div className="grid gap-5 grid-cols-1 lg:grid-cols-2">
        <Card title="Today's attendance" loading={q.isLoading} error={q.error ? String(q.error) : null}>
          {q.data ? <AttendanceRow counts={q.data.attendance} /> : null}
        </Card>
        <Card
          title="Expenses to action"
          action={{ label: 'Open Queue', href: '/hrms/expenses' }}
          loading={q.isLoading} error={q.error ? String(q.error) : null}
        >
          {q.data ? <ExpensesRow expenses={q.data.expenses} /> : null}
        </Card>

        <Card title="Attendance breakdown" loading={q.isLoading} error={q.error ? String(q.error) : null}>
          {q.data ? <AttendanceBreakdown counts={q.data.attendance} /> : null}
        </Card>
        <Card
          title="Ledger"
          action={{ label: 'Open', href: '/hrms/accounts' }}
          loading={q.isLoading} error={q.error ? String(q.error) : null}
        >
          {q.data ? <LedgerBlock ledger={q.data.ledger} /> : null}
        </Card>

        <Card title="Departments" loading={q.isLoading} error={q.error ? String(q.error) : null}>
          {q.data ? <DepartmentsTable rows={q.data.departments} /> : null}
        </Card>
        <Card
          title="Payroll"
          action={{ label: 'Open', href: '/hrms/payroll' }}
          loading={q.isLoading} error={q.error ? String(q.error) : null}
        >
          {q.data ? <PayrollBlock payroll={q.data.payroll} /> : null}
        </Card>
      </div>
    </div>
  );
}

// ── Timestamp line ──────────────────────────────────────────────────────
function TimestampLine() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="text-12 uppercase tracking-[0.06em] text-inkFaint tabular-nums" data-testid="timestamp">
      {formatDate(now).toUpperCase()} · {formatTime(now)}
    </div>
  );
}

// ── TODAY card ──────────────────────────────────────────────────────────
function TodayCard({ today }: { today: TodayState }) {
  const [offSiteOpen, setOffSiteOpen] = useState(false);
  const qc = useQueryClient();
  const doIn = useMutation({
    mutationFn: () => checkIn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dashboardV2'] }),
  });
  const doOut = useMutation({
    mutationFn: () => checkOut(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dashboardV2'] }),
  });

  const state = today.status;
  const headline = useHeadline(today);

  return (
    <>
      <Card title="Today" data-testid="today-card">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="text-20 font-semibold text-ink" data-testid="today-headline">{headline}</div>
            <div className="text-13 text-inkMuted mt-1">
              Standard hours: 09:30 AM – 06:30 PM. Late after 09:45 AM.
            </div>
          </div>
          <div className="flex items-center gap-4">
            {state === 'not_checked_in' ? (
              <>
                <PrimaryBtn onClick={() => doIn.mutate()} disabled={doIn.isPending} data-testid="btn-check-in">
                  {doIn.isPending ? 'Checking in…' : 'Check in'}
                </PrimaryBtn>
                <TextBtn onClick={() => setOffSiteOpen(true)} data-testid="btn-off-site">
                  Off-site
                </TextBtn>
              </>
            ) : state === 'checked_in' ? (
              <PrimaryBtn onClick={() => doOut.mutate()} disabled={doOut.isPending} data-testid="btn-check-out">
                {doOut.isPending ? 'Checking out…' : 'Check out'}
              </PrimaryBtn>
            ) : (
              <PrimaryBtn disabled>Complete</PrimaryBtn>
            )}
          </div>
        </div>
      </Card>
      <OffSiteDrawer open={offSiteOpen} onClose={() => setOffSiteOpen(false)} onSubmit={() => doIn.mutate()} />
    </>
  );
}

function useHeadline(today: TodayState): string {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (today.status !== 'checked_in') return;
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, [today.status]);
  return useMemo(() => {
    void tick;
    if (today.status === 'not_checked_in') return 'Not checked in yet';
    if (today.status === 'checked_in' && today.check_in_at) {
      const minutes = Math.max(0, Math.round((Date.now() - new Date(today.check_in_at).getTime()) / 60_000));
      return `Checked in at ${formatTime(today.check_in_at)}  ·  ${formatDuration(minutes)} elapsed`;
    }
    if (today.status === 'checked_out' && today.worked_minutes != null) {
      return `Attendance completed · ${formatDuration(today.worked_minutes)}`;
    }
    if (today.status === 'on_leave') return `On leave today — ${today.leave_type ?? 'Casual Leave'}`;
    if (today.status === 'weekly_off') return 'Weekly off';
    return '—';
  }, [today, tick]);
}

function PrimaryBtn({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className="inline-flex items-center justify-center h-10 px-5 text-14 font-medium text-white bg-gold hover:bg-gold-hover rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
      {...rest}
    >
      {children}
    </button>
  );
}
function TextBtn({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className="text-14 font-medium text-ink hover:text-gold-hover"
      {...rest}
    >
      {children}
    </button>
  );
}

// ── Off-site drawer ────────────────────────────────────────────────────
function OffSiteDrawer({
  open, onClose, onSubmit,
}: { open: boolean; onClose: () => void; onSubmit: () => void }) {
  const [locationType, setLocationType] = useState<'client_site' | 'remote' | 'field'>('client_site');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!open) return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) { setErr('A reason is required.'); return; }
    onSubmit();
    onClose();
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 flex justify-end bg-black/[0.32]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="offsite-drawer"
    >
      <div className="w-full max-w-[420px] h-full bg-surface shadow-drawer flex flex-col">
        <div className="h-14 px-5 flex items-center justify-between border-b border-border">
          <h3 className="text-16 font-semibold text-ink">Off-site check-in</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="text-inkMuted hover:text-ink">
            <X size={20} strokeWidth={1.75} />
          </button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4 flex-1">
          <label className="block">
            <span className="block text-11 uppercase tracking-[0.06em] text-inkFaint mb-1">Location type</span>
            <select
              value={locationType}
              onChange={(e) => setLocationType(e.target.value as typeof locationType)}
              className="w-full h-10 px-3 text-14 bg-surface border border-border rounded-md focus:outline-none focus:border-gold"
              data-testid="offsite-type"
            >
              <option value="client_site">Client site</option>
              <option value="remote">Remote / WFH</option>
              <option value="field">Field visit</option>
            </select>
          </label>
          <label className="block">
            <span className="block text-11 uppercase tracking-[0.06em] text-inkFaint mb-1">Reason</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              required
              className="w-full px-3 py-2 text-14 bg-surface border border-border rounded-md focus:outline-none focus:border-gold"
              data-testid="offsite-reason"
            />
          </label>
          {err ? <div className="text-12 text-danger" role="alert">{err}</div> : null}
          <div className="flex justify-end gap-3 pt-2">
            <TextBtn onClick={onClose}>Cancel</TextBtn>
            <PrimaryBtn type="submit" data-testid="offsite-submit">Check in</PrimaryBtn>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Today's attendance (stats row) ─────────────────────────────────────
function AttendanceRow({ counts }: { counts: AttendanceCounts }) {
  const stats: Array<[string, number, boolean]> = [
    ['Total', counts.total, false],
    ['Present', counts.present, false],
    ['Late', counts.late, false],
    ['Absent', counts.absent, counts.absent > 0],
    ['On Leave', counts.onLeave, false],
    ['Missing check-out', counts.missingCheckout, false],
  ];
  return (
    <div className="flex items-stretch" data-testid="attendance-row">
      {stats.map(([label, value, emph], i) => (
        <div key={label} className={'flex-1 px-3 ' + (i > 0 ? 'border-l border-border' : '')}>
          <div className={
            'text-28 font-semibold tabular-nums ' +
            (emph ? 'text-danger' : 'text-ink')
          }>
            {value}
          </div>
          <div className="text-11 font-medium uppercase tracking-[0.06em] text-inkFaint mt-1 min-h-[2em]">
            {label}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Expenses to action ─────────────────────────────────────────────────
function ExpensesRow({ expenses }: { expenses: ExpensesSnapshot }) {
  return (
    <div className="flex items-stretch" data-testid="expenses-row">
      <div className="flex-1 pr-4">
        <div className="text-13 text-inkMuted">Awaiting approval</div>
        <div className="text-28 font-semibold tabular-nums text-ink mt-1">{expenses.awaitingApproval}</div>
      </div>
      <div className="flex-1 pl-4 border-l border-border">
        <div className="text-13 text-inkMuted">Approved / unspent</div>
        <div className="text-28 font-semibold tabular-nums text-ink mt-1">{expenses.approvedUnspent}</div>
        <div className="text-14 font-medium tabular-nums text-ink mt-1" data-testid="expenses-amount">
          {formatINR(expenses.approvedAmount)}
        </div>
      </div>
    </div>
  );
}

// ── Attendance breakdown (donut) ───────────────────────────────────────
function AttendanceBreakdown({ counts }: { counts: AttendanceCounts }) {
  // Colour-map per §5. Zero segments dropped.
  const raw: Array<{ key: string; label: string; value: number; color: string }> = [
    { key: 'present', label: 'Present', value: counts.present, color: '#4F6B52' }, // success
    { key: 'late',    label: 'Late',    value: counts.late,    color: '#C8952E' }, // warning/gold
    { key: 'absent',  label: 'Absent',  value: counts.absent,  color: '#B33A2B' }, // danger
    { key: 'onLeave', label: 'On Leave', value: counts.onLeave, color: '#9A9A90' }, // inkFaint
  ].filter((s) => s.value > 0);

  return (
    <div className="flex items-center gap-5" data-testid="attendance-breakdown">
      <div style={{ width: 200, height: 200 }}>
        {raw.length === 0 ? (
          <div className="text-13 text-inkMuted">No attendance data yet today.</div>
        ) : (
          <ResponsiveContainer>
            <PieChart>
              <Pie
                data={raw}
                dataKey="value"
                cx="50%"
                cy="50%"
                innerRadius={62}
                outerRadius={95}
                strokeWidth={0}
                isAnimationActive={false}
                paddingAngle={0}
              >
                {raw.map((s) => (
                  <Cell key={s.key} fill={s.color} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>
      <ul className="flex-1 space-y-2">
        {raw.map((s) => (
          <li key={s.key} className="flex items-center justify-between text-14">
            <span className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: s.color }} aria-hidden />
              <span className="text-ink">{s.label}</span>
            </span>
            <span className="font-medium tabular-nums text-ink">{s.value}</span>
          </li>
        ))}
        {raw.length === 0 ? <li className="text-13 text-inkFaint">—</li> : null}
      </ul>
    </div>
  );
}

// ── Ledger ────────────────────────────────────────────────────────────
function LedgerBlock({ ledger }: { ledger: LedgerSnapshot }) {
  return (
    <div data-testid="ledger-block">
      <div className="text-34 font-semibold tabular-nums text-ink">
        {formatINR(ledger.balance)}
      </div>
      <div className="text-13 text-inkMuted mt-1 tabular-nums">
        This month : debit {formatINR(ledger.monthDebit)} · credit {formatINR(ledger.monthCredit)}
      </div>
    </div>
  );
}

// ── Departments ───────────────────────────────────────────────────────
function DepartmentsTable({ rows }: { rows: DepartmentRow[] }) {
  return (
    <table className="w-full border-collapse tabular-nums" data-testid="departments-table">
      <thead>
        <tr>
          {['Department', 'Headcount', 'Present', 'Absent'].map((c) => (
            <th key={c} className="text-left text-11 font-semibold uppercase tracking-[0.06em] text-inkFaint py-2 border-b border-border">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="h-9 border-b border-border last:border-b-0">
            <td className="text-14 text-ink">{r.name}</td>
            <td className="text-14 text-ink">{r.headcount}</td>
            <td className="text-14 text-ink">{r.present}</td>
            <td className={'text-14 ' + (r.absent > 0 ? 'text-ink font-medium' : 'text-inkMuted')}>{r.absent}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Payroll ───────────────────────────────────────────────────────────
function PayrollBlock({ payroll }: { payroll: PayrollSnapshot }) {
  return (
    <div data-testid="payroll-block">
      <div className="text-16 font-medium text-ink">{payroll.period}</div>
      <div className="text-13 text-inkMuted mt-1">
        Stage: <span className="text-ink font-medium">{payroll.stage}</span> · {payroll.employees} employees
      </div>
      <div className="text-20 font-semibold tabular-nums text-ink mt-3">
        Gross {formatINR(payroll.grossTotal)}
      </div>
    </div>
  );
}
