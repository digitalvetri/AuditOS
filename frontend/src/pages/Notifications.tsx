/**
 * /notifications — full page. Same data as the bell dropdown, no cap.
 *
 * Snooze: each row has a clock button that opens a popover with five
 * presets (1 hour / 4 hours / Tomorrow 9am / Next Monday / 1 week).
 * Snoozed items are hidden from the default view and the bell badge; a
 * "Snoozed" tab reveals them for review and offers an Unsnooze action.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notificationsApi, snoozePresets } from '@/platform/notifications/api';
import { fmtDateTime } from '@/lib/format';
import { Button } from '@/components/Button';
import type { Notification } from '@/data/models';

type Tab = 'active' | 'snoozed';

export function NotificationsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('active');

  const q = useQuery({
    queryKey: ['notifications', 'list', 'all', tab],
    queryFn: () => notificationsApi.list(100, tab === 'snoozed'),
  });
  const markAll = useMutation({
    mutationFn: () => notificationsApi.markAllRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const markRead = useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const snoozeM = useMutation({
    mutationFn: ({ id, until }: { id: string; until: Date }) => notificationsApi.snooze(id, until),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const unsnoozeM = useMutation({
    mutationFn: (id: string) => notificationsApi.unsnooze(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const onOpen = (n: Notification) => {
    if (!n.is_read) markRead.mutate(n.id);
    if (n.action_url) navigate(n.action_url);
  };

  // Only show currently-snoozed rows in the Snoozed tab (the server also
  // sends past-snoozed rows in the include_snoozed=1 response because
  // they're otherwise visible; filter so the tab is strictly future-dated).
  const now = Date.now();
  const items = (q.data?.items ?? []).filter((n) => {
    if (tab === 'snoozed') return n.snoozed_until && Date.parse(n.snoozed_until) > now;
    return true;
  });

  return (
    <div className="max-w-[840px] mx-auto space-y-6">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Platform</div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-1">Notifications</h1>
        </div>
        {tab === 'active' && q.data && q.data.unread > 0 ? (
          <Button variant="secondary" onClick={() => markAll.mutate()} disabled={markAll.isPending}>
            Mark all read
          </Button>
        ) : null}
      </header>

      <div className="flex gap-1 border-b border-neutral-200">
        {(['active', 'snoozed'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={
              'px-3 h-9 text-13 border-b-2 -mb-px ' +
              (tab === t ? 'border-neutral-900 text-neutral-900 font-medium' : 'border-transparent text-neutral-500 hover:text-neutral-900')
            }
          >
            {t === 'active' ? 'Active' : 'Snoozed'}
            {q.data ? (
              <span className="ml-1.5 text-11 text-neutral-400">
                {t === 'active' ? q.data.unread : q.data.snoozed}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="bg-white border border-neutral-200 rounded overflow-hidden">
        {q.isLoading ? (
          <div className="h-40 bg-neutral-100" aria-label="Loading" />
        ) : items.length === 0 ? (
          <div className="p-6 text-13 text-neutral-500">
            {tab === 'snoozed' ? 'Nothing snoozed right now.' : "You're all caught up."}
          </div>
        ) : (
          <ul>
            {items.map((n) => (
              <NotificationRow
                key={n.id}
                n={n}
                tab={tab}
                onOpen={() => onOpen(n)}
                onSnooze={(until) => snoozeM.mutate({ id: n.id, until })}
                onUnsnooze={() => unsnoozeM.mutate(n.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function NotificationRow({ n, tab, onOpen, onSnooze, onUnsnooze }: {
  n: Notification;
  tab: Tab;
  onOpen: () => void;
  onSnooze: (until: Date) => void;
  onUnsnooze: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const presets = snoozePresets();
  return (
    <li className="border-b border-neutral-200 last:border-b-0 relative">
      <div
        className={
          'flex items-center gap-2 px-4 py-3 hover:bg-neutral-50 border-l-2 ' +
          (n.is_read || tab === 'snoozed' ? 'border-l-transparent' : 'border-l-amber-500')
        }
      >
        <button type="button" onClick={onOpen} className="flex-1 text-left">
          <div className="flex items-baseline justify-between gap-3">
            <div className={'text-13 ' + (n.is_read ? 'text-neutral-700' : 'text-neutral-900 font-medium')}>
              {n.title}
            </div>
            <div className="text-11 text-neutral-400 tabular-nums shrink-0">
              {fmtDateTime(n.created_at)}
            </div>
          </div>
          <div className="text-12 text-neutral-500 mt-1">{n.body}</div>
          {n.snoozed_until && tab === 'snoozed' ? (
            <div className="text-11 text-neutral-400 mt-1">Snoozed until {fmtDateTime(n.snoozed_until)}</div>
          ) : null}
        </button>
        {tab === 'snoozed' ? (
          <button
            type="button"
            onClick={onUnsnooze}
            className="h-7 px-2 text-11 border border-neutral-300 rounded hover:border-neutral-500 shrink-0"
          >
            Unsnooze
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            title="Snooze"
            aria-expanded={menuOpen}
            className="h-7 w-7 text-14 text-neutral-500 border border-neutral-300 rounded hover:border-neutral-500 shrink-0 inline-flex items-center justify-center"
          >
            ⏰
          </button>
        )}
      </div>
      {menuOpen ? (
        <div className="absolute right-3 top-11 z-30 w-48 bg-white border border-neutral-300 rounded shadow-lg">
          <div className="px-3 py-1.5 text-11 text-neutral-500 border-b border-neutral-100">Snooze for</div>
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => { onSnooze(p.until); setMenuOpen(false); }}
              className="w-full text-left px-3 py-2 text-13 hover:bg-neutral-50"
            >
              {p.label}
            </button>
          ))}
        </div>
      ) : null}
    </li>
  );
}
