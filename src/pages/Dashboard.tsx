/**
 * The one Dashboard route (§6.2).
 *
 * §6.2 says the hero widget IS "greeting with live clock + today's attendance
 * card". So when the hero slot has widgets, the Dashboard drops its own
 * greeting header — the widget owns the story. When no hero widgets are
 * registered, we render the minimal header so the page isn't blank.
 *
 * The Dashboard never imports from a module. Modules register into
 * platform/dashboard/registry — importing @/modules at boot triggers
 * registration side-effects (see modules/index.ts).
 */
import { useAuth } from '@/platform/auth/AuthContext';
import { allSlots, widgetsFor, type WidgetSlot } from '@/platform/dashboard/registry';
import { fmtDate, fmtTime } from '@/lib/format';
import { useEffect, useState } from 'react';

export function DashboardPage() {
  const { session } = useAuth();
  const role = session?.role.code;
  const now = useLiveClock();

  const slotsWithWidgets = allSlots()
    .map((slot) => ({ slot, widgets: role ? widgetsFor(role, slot) : [] }))
    .filter((s) => s.widgets.length > 0);

  const hasHero = slotsWithWidgets.some((s) => s.slot === 'hero');

  return (
    <div className="space-y-6">
      {!hasHero ? (
        <header>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 tabular-nums">
            {fmtDate(now)} · {fmtTime(now)}
          </div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-1">
            {greeting()}, {session?.employee?.full_name.split(' ')[0] ?? 'there'}
          </h1>
          <p className="text-13 text-neutral-500 mt-1">{session?.role.name} · Signed in</p>
        </header>
      ) : (
        <header className="tabular-nums text-11 uppercase tracking-[0.06em] text-neutral-500">
          {fmtDate(now)} · {fmtTime(now)}
        </header>
      )}

      {slotsWithWidgets.length === 0 ? (
        <EmptyDashboard />
      ) : (
        <div className="space-y-8">
          {slotsWithWidgets.map(({ slot, widgets }) => (
            <section key={slot} data-testid={`slot-${slot}`}>
              {slot !== 'hero' ? (
                <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-3">
                  {labelForSlot(slot)}
                </div>
              ) : null}
              <div
                className={
                  slot === 'hero'
                    ? 'space-y-4'
                    : 'grid grid-cols-1 md:grid-cols-2 gap-4'
                }
              >
                {widgets.map(({ id, component: W, slot: s }) => (
                  <div
                    key={id}
                    className={
                      s === 'hero'
                        ? '' /* widget renders its own shell */
                        : 'bg-white border border-neutral-200 rounded p-4'
                    }
                  >
                    <W />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyDashboard() {
  return (
    <section className="bg-white border border-neutral-200 rounded p-6">
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Dashboard</div>
      <h2 className="text-16 text-neutral-900 mt-1">No widgets yet</h2>
      <p className="text-13 text-neutral-500 mt-2 max-w-[560px]">
        Modules register widgets into slots. Attendance, Leave and the
        approvals queue land in later sessions and will appear here without
        any change to this page.
      </p>
    </section>
  );
}

function labelForSlot(slot: WidgetSlot): string {
  return slot.charAt(0).toUpperCase() + slot.slice(1);
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function useLiveClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}
