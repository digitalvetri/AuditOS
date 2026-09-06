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
  const [tab, setTab] = useState<Tab>('today');
  const [openCorrection, setOpenCorrection] = useState(false);

  const canSeeOrgRecords = can(session?.role.code, 'attendance.read', 'department');

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">HRMS</div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-1">Attendance</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setOpenCorrection(true)}>
            Request correction
          </Button>
        </div>
      </header>

      <Tabs
        active={tab}
        onChange={setTab}
        items={[
          { id: 'today', label: 'Today' },
          { id: 'records', label: canSeeOrgRecords ? 'Records' : 'My records' },
          { id: 'corrections', label: 'Corrections' },
        ]}
      />

      {tab === 'today' ? <TodayCard /> : null}
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
    <div className="border-b border-neutral-200 flex items-center gap-4">
      {items.map((it) => {
        const isActive = it.id === active;
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => onChange(it.id)}
            data-testid={`tab-${it.id}`}
            className={
              'h-10 px-1 text-13 -mb-px border-b-2 ' +
              (isActive
                ? 'border-gold text-neutral-900 font-medium'
                : 'border-transparent text-neutral-500 hover:text-neutral-900')
            }
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
