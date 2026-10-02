import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { workstationApi } from '@/modules/workstation/api';
import { NewFollowUpModal } from '@/modules/workstation/NewFollowUpModal';
import { QueryState } from '@/modules/workstation/components';
import { ListAction, ListCard, ListHeader } from '@/modules/workstation/listUi';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';
import type { FollowUp, FollowUpType, ListResponse } from '@/modules/workstation/types';

/**
 * Month-view calendar of scheduled follow-ups.
 *
 * Click a chip → open the lead or client it belongs to.
 * Click an empty day → open the "New follow-up" modal with the day prefilled,
 *   so whatever you say gets scheduled on that day. (Follow-ups ARE how
 *   Workstation schedules a thing to do with a lead or client.)
 *
 * Backend has no date-range filter on /api/follow-ups yet, so the client
 * pulls the full list and filters in-memory. Fine for a CA firm (hundreds,
 * not millions). Swap for a `scheduled_from`/`scheduled_to` server param
 * when the list grows past a few thousand entries.
 */
export function WorkstationCalendarPage() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'workstation.followup.manage', 'self');

  const today = startOfDay(new Date());
  const [cursor, setCursor] = useState<Date>(startOfMonth(today));
  const [addState, setAddState] = useState<{ open: boolean; dateTime?: string }>({ open: false });

  const list = useQuery({
    queryKey: ['workstation', 'follow-ups', 'calendar'],
    queryFn: () => workstationApi.listFollowUps(),
  });

  // 42 cells (6 rows × 7 cols), aligned so the first row contains the first of
  // the month. Days from the previous / next month fill the edges, dimmed.
  const cells = useMemo(() => buildMonthGrid(cursor), [cursor]);

  const byDay = useMemo(() => groupByDay(list.data?.items ?? []), [list.data]);

  const title = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const atToday = sameMonth(cursor, today);

  return (
    <div className="max-w-[1400px]">
      <ListHeader
        title="Calendar"
        meta={<>Follow-ups scheduled across your leads and clients. Click an empty day to add one.</>}
        action={canManage ? (
          <ListAction onClick={() => setAddState({ open: true, dateTime: defaultTimeOn(today) })} icon={<Plus size={15} />}>
            New Follow-up
          </ListAction>
        ) : undefined}
      />

      <ListCard>
        <QueryState query={list} empty={null}>
          {(_: ListResponse<FollowUp>) => (
            <>
              <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200">
                <div className="flex items-center gap-2">
                  <button
                    type="button" aria-label="Previous month"
                    onClick={() => setCursor((c) => addMonths(c, -1))}
                    className="h-8 w-8 inline-flex items-center justify-center rounded border border-neutral-200 hover:bg-neutral-50"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setCursor(startOfMonth(today))}
                    disabled={atToday}
                    className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded border border-neutral-200 hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    title={atToday ? 'Already on this month' : 'Jump to this month'}
                  >
                    <CalendarDays size={14} /> Today
                  </button>
                  <button
                    type="button" aria-label="Next month"
                    onClick={() => setCursor((c) => addMonths(c, 1))}
                    className="h-8 w-8 inline-flex items-center justify-center rounded border border-neutral-200 hover:bg-neutral-50"
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
                <div className="text-14 font-medium text-neutral-900">{title}</div>
                <div className="w-[136px]" />{/* balance the control group */}
              </div>

              <div className="grid grid-cols-7 border-b border-neutral-200 text-12 text-neutral-500">
                {WEEKDAYS.map((d) => (
                  <div key={d} className="px-2 py-1.5 text-center uppercase tracking-wide">{d}</div>
                ))}
              </div>

              <div className="grid grid-cols-7">
                {cells.map((cell) => {
                  const items = byDay.get(dayKey(cell.date)) ?? [];
                  const isToday = sameDay(cell.date, today);
                  const dim = cell.inOtherMonth;
                  return (
                    <div
                      key={dayKey(cell.date)}
                      className={
                        'min-h-[110px] border-b border-r border-neutral-100 p-1.5 flex flex-col gap-1 '
                        + (dim ? 'bg-neutral-50/40 ' : 'bg-white ')
                      }
                    >
                      <div className="flex items-center justify-between">
                        <button
                          type="button"
                          disabled={!canManage}
                          onClick={() => setAddState({ open: true, dateTime: defaultTimeOn(cell.date) })}
                          className={
                            'text-12 h-6 w-6 inline-flex items-center justify-center rounded-full '
                            + (isToday ? 'bg-primary text-white font-semibold ' : dim ? 'text-neutral-400 ' : 'text-neutral-700 ')
                            + (canManage ? 'hover:ring-1 hover:ring-neutral-300 cursor-pointer' : 'cursor-default')
                          }
                          title={canManage ? `Add a follow-up on ${cell.date.toDateString()}` : undefined}
                        >
                          {cell.date.getDate()}
                        </button>
                        {items.length > 3 ? <span className="text-10 text-neutral-500">+{items.length - 3} more</span> : null}
                      </div>
                      <div className="flex flex-col gap-0.5">
                        {items.slice(0, 3).map((f) => (
                          <FollowUpChip key={f.id} followUp={f} onOpen={() => openSubject(navigate, f)} />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </QueryState>
      </ListCard>

      <NewFollowUpModal
        open={addState.open}
        defaultDateTime={addState.dateTime}
        onClose={() => setAddState({ open: false })}
      />
    </div>
  );
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * One tone per type so the eye catches calls vs meetings vs money.
 * Only colors defined in tailwind.config.ts (primary, success, amber, gold,
 * red, neutral) — bare "blue"/"green"/"purple" are not in the theme.
 */
const TYPE_TONE: Record<FollowUpType, string> = {
  call: 'bg-primary/10 text-primary border-primary/30',
  whatsapp: 'bg-success/10 text-success border-success/30',
  email: 'bg-neutral-200/60 text-neutral-800 border-neutral-300',
  meeting: 'bg-amber/10 text-amber border-amber/30',
  document_request: 'bg-gold/10 text-gold border-gold/30',
  payment_followup: 'bg-red/10 text-red border-red/30',
  service_followup: 'bg-success/10 text-success border-success/30',
  other: 'bg-neutral-100 text-neutral-700 border-neutral-200',
};

function FollowUpChip({ followUp, onOpen }: { followUp: FollowUp; onOpen: () => void }) {
  const tone = TYPE_TONE[followUp.type] ?? TYPE_TONE.other;
  const dim = followUp.status === 'completed' || followUp.status === 'cancelled';
  return (
    <button
      type="button" onClick={onOpen}
      className={
        'text-11 text-left truncate rounded px-1.5 py-0.5 border '
        + tone
        + (dim ? ' opacity-50 line-through' : '')
      }
      title={`${followUp.title} · ${followUp.subject_name ?? ''}`}
    >
      <span className="font-medium">{hhmm(followUp.scheduled_at)}</span>{' '}
      {followUp.title}
    </button>
  );
}

function openSubject(navigate: ReturnType<typeof useNavigate>, f: FollowUp): void {
  if (f.subject_type === 'lead' && f.lead_id) navigate(`/workstation/leads/${f.lead_id}`);
  else if (f.subject_type === 'client' && f.client_id) navigate(`/workstation/clients/${f.client_id}/follow-ups`);
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Date helpers — kept inline. Project has no date-fns/dayjs dependency.    */
/* ──────────────────────────────────────────────────────────────────────── */

interface Cell { date: Date; inOtherMonth: boolean; }

function buildMonthGrid(monthStart: Date): Cell[] {
  const firstDay = monthStart.getDay(); // 0 = Sun
  const start = addDays(monthStart, -firstDay);
  const cells: Cell[] = [];
  for (let i = 0; i < 42; i += 1) {
    const d = addDays(start, i);
    cells.push({ date: d, inOtherMonth: d.getMonth() !== monthStart.getMonth() });
  }
  return cells;
}

function groupByDay(items: FollowUp[]): Map<string, FollowUp[]> {
  const m = new Map<string, FollowUp[]>();
  for (const f of items) {
    const key = dayKey(new Date(f.scheduled_at));
    const bucket = m.get(key);
    if (bucket) bucket.push(f);
    else m.set(key, [f]);
  }
  // Earlier in the day first.
  for (const bucket of m.values()) bucket.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  return m;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** `YYYY-MM-DDTHH:mm` for a datetime-local input, defaulting to 10:00 local. */
function defaultTimeOn(d: Date): string {
  return `${dayKey(d)}T10:00`;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function startOfDay(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function startOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addDays(d: Date, n: number): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function addMonths(d: Date, n: number): Date { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
function sameDay(a: Date, b: Date): boolean { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function sameMonth(a: Date, b: Date): boolean { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth(); }
function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }
