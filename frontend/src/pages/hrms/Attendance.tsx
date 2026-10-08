/**
 * /hrms/attendance — the attendance module page.
 *
 * Tabs: Today · Records · Corrections
 *
 * Today is the state-aware card (check-in / check-out flow).
 * Records is the filtered list (self / dept / org scope handled server-side).
 * Corrections is the request modal + review queue.
 */
import { useState } from 'react';
import { TodayCard } from '@/modules/attendance/TodayCard';
import { RecordsTable } from '@/modules/attendance/RecordsTable';
import { CorrectionsQueue } from '@/modules/attendance/CorrectionsQueue';
import { CorrectionRequestModal } from '@/modules/attendance/CorrectionRequestModal';
import { Button } from '@/components/Button';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';

type Tab = 'today' | 'records' | 'corrections';

export function AttendancePage() {
  const { session } = useAuth();
  // Login-only accounts (the owner logins) have no attendance of their own:
  // no Today card, no correction requests — just the team's records.
  const hasOwn = Boolean(session?.employee);
  const [tab, setTab] = useState<Tab>(hasOwn ? 'today' : 'records');
  const [openCorrection, setOpenCorrection] = useState(false);

  const canSeeOrgRecords = can(session?.role.code, 'attendance.read', 'department');

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] text-neutral-900">Attendance</h1>
        </div>
        {hasOwn ? (
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setOpenCorrection(true)}>
              Request correction
            </Button>
          </div>
        ) : null}
      </header>

      <Tabs
        active={tab}
        onChange={setTab}
        items={[
          ...(hasOwn ? [{ id: 'today' as const, label: 'Today' }] : []),
          { id: 'records', label: canSeeOrgRecords ? 'Records' : 'My records' },
          { id: 'corrections', label: 'Corrections' },
        ]}
      />

      {tab === 'today' && hasOwn ? <TodayCard /> : null}
      {tab === 'records' ? <RecordsTable /> : null}
      {tab === 'corrections' ? <CorrectionsQueue /> : null}

      <CorrectionRequestModal open={openCorrection} onClose={() => setOpenCorrection(false)} />
    </div>
  );
}

function Tabs({
  items,
  active,
  onChange,
}: {
  items: { id: Tab; label: string }[];
  active: Tab;
  onChange: (t: Tab) => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {items.map((it) => {
        const isActive = it.id === active;
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => onChange(it.id)}
            data-testid={`tab-${it.id}`}
            className={
              'h-8 px-3 inline-flex items-center text-13 rounded-full border transition-colors whitespace-nowrap ' +
              (isActive
                ? 'bg-[#f1edff] border-[#cbbdf2] text-primary font-medium'
                : 'bg-white border-neutral-200 text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50')
            }
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
