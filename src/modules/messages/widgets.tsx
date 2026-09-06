/**
 * Messages dashboard widget (§6.2). The module registers itself into the
 * registry; the Dashboard never imports this file.
 *
 * The TopBar badge is the always-visible unread indicator; this widget gives
 * the same number a place on the dashboard alongside the other queues, and
 * names the most recent conversation so the click has a destination.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { registerWidget } from '@/platform/dashboard/registry';
import { messagesApi } from './api';

function UnreadMessagesWidget() {
  // Same query key as the TopBar badge, so both read one cached result.
  const q = useQuery({
    queryKey: ['chats', 'list'],
    queryFn: messagesApi.listChats,
    refetchInterval: 30_000,
  });
  const unread = q.data?.total_unread ?? 0;
  const busiest = (q.data?.items ?? []).find((c) => c.unread > 0);

  return (
    <Link
      to="/hrms/messages"
      className={
        'block bg-white border border-neutral-200 rounded p-4 border-l-2 hover:bg-neutral-50 ' +
        (unread > 0 ? 'border-l-gold' : 'border-l-transparent')
      }
      data-testid="widget-messages-unread"
    >
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Messages</div>
      <div className="text-28 font-semibold text-neutral-900 tabular-nums mt-1">
        {q.isLoading ? '—' : unread}
      </div>
      <div className="text-12 text-neutral-500 mt-1">
        {unread === 0
          ? 'No unread messages'
          : busiest
            ? `Oldest unread in ${busiest.display_name}`
            : `${unread} unread message${unread === 1 ? '' : 's'}`}
      </div>
    </Link>
  );
}

registerWidget({
  id: 'hrms.messages-unread',
  slot: 'secondary',
  roles: ['employee', 'dept_manager', 'hr_admin', 'finance_admin', 'md'],
  scope: 'self',
  component: UnreadMessagesWidget,
  order: 60,
});
