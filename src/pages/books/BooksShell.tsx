import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { booksApi, errorText } from '@/modules/books/api';
import { BooksProvider, statusKey, useBooks } from '@/modules/books/context';
import { Btn, Empty, ErrorState, Select, Skeleton, dateTime } from '@/modules/books/ui';

/**
 * Tools → Books. The frame every Books screen renders in: the organisation
 * switcher, sync status, and the section navigation. Screens that need Zoho
 * data sit behind the organisation gate; Settings is always reachable so a
 * user can connect in the first place.
 */
const NAV: { group?: string; items: { to: string; label: string; perm?: 'reports' }[] }[] = [
  { items: [{ to: '/books', label: 'Dashboard' }] },
  { items: [{ to: '/books/customers', label: 'Customers' }, { to: '/books/vendors', label: 'Vendors' }, { to: '/books/items', label: 'Items' }] },
  { group: 'Sales', items: [{ to: '/books/sales/estimates', label: 'Estimates' }, { to: '/books/sales/salesorders', label: 'Sales Orders' }, { to: '/books/sales/invoices', label: 'Invoices' }] },
  { group: 'Purchases', items: [{ to: '/books/purchases/purchaseorders', label: 'Purchase Orders' }, { to: '/books/purchases/bills', label: 'Bills' }] },
  { items: [{ to: '/books/expenses', label: 'Expenses' }, { to: '/books/payments', label: 'Payments' }, { to: '/books/credit-notes', label: 'Credit Notes' }, { to: '/books/debit-notes', label: 'Debit Notes' }] },
  { items: [{ to: '/books/banking', label: 'Banking' }, { to: '/books/reconciliation', label: 'Reconciliation' }, { to: '/books/taxes', label: 'Taxes' }, { to: '/books/reports', label: 'Reports', perm: 'reports' }] },
  { items: [{ to: '/books/settings', label: 'Settings' }] },
];

export function BooksShell() {
  return (
    <BooksProvider>
      {({ loading, error, ctx }) => (
        <div className="max-w-[1480px] mx-auto">
          <div className="mb-4">
            <div className="text-11 uppercase tracking-[0.06em] text-inkMuted">Tools</div>
            <h1 className="text-20 font-semibold text-ink mt-0.5">Books</h1>
          </div>
          {loading ? <Skeleton rows={6} /> : error || !ctx ? <ErrorState error={errorText(error)} /> : <Frame />}
        </div>
      )}
    </BooksProvider>
  );
}

function Frame() {
  const { org, can } = useBooks();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const onSettings = pathname.startsWith('/books/settings');
  const items = NAV.flatMap((g) => g.items).filter((i) => !i.perm || can[i.perm]);

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      {/* Section nav: a sidebar on desktop, a select on small screens. */}
      <nav aria-label="Books sections" className="hidden lg:block w-52 shrink-0">
        <div className="bg-surface border border-border rounded py-2 sticky top-4">
          {NAV.map((g, gi) => {
            const list = g.items.filter((i) => !i.perm || can[i.perm]);
            if (!list.length) return null;
            return (
              <div key={gi} className={gi ? 'mt-2 pt-2 border-t border-border' : ''}>
                {g.group ? <div className="px-4 pt-1 pb-1 text-11 uppercase tracking-[0.06em] text-inkFaint">{g.group}</div> : null}
                {list.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.to === '/books'}
                    className={({ isActive }) => `block px-4 py-1.5 text-13 ${g.group ? 'pl-6' : ''} ${isActive ? 'text-ink font-medium bg-canvas border-l-2 border-primary' : 'text-inkMuted hover:text-ink border-l-2 border-transparent'}`}>
                    {i.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </div>
      </nav>
      <div className="lg:hidden">
        <Select value={items.find((i) => i.to === pathname || (i.to !== '/books' && pathname.startsWith(i.to)))?.to ?? '/books'} onChange={(v) => navigate(v)} options={items.map((i) => ({ value: i.to, label: i.label }))} />
      </div>

      <div className="flex-1 min-w-0">
        {org ? <OrgBar /> : null}
        {org || onSettings ? <Outlet /> : <NotReady />}
      </div>
    </div>
  );
}

function OrgBar() {
  const { org, activeOrgs, setOrg, can } = useBooks();
  const qc = useQueryClient();
  const toast = useToast();
  const sync = useMutation({
    mutationFn: () => booksApi.org(org!.id).sync(),
    onSuccess: (d) => {
      qc.setQueryData(['books', org!.id, 'dashboard'], d);
      void qc.invalidateQueries({ queryKey: ['books', org!.id] });
      void qc.invalidateQueries({ queryKey: statusKey });
      toast.push('success', 'Books synced with Zoho.');
    },
    onError: (e) => { void qc.invalidateQueries({ queryKey: statusKey }); toast.push('error', errorText(e)); },
  });
  if (!org) return null;
  const state = sync.isPending || org.sync_status === 'syncing' ? 'Syncing' : org.sync_status === 'failed' ? 'Sync failed' : org.last_sync_at ? 'Synced' : 'Connected';
  return (
    <div className="bg-surface border border-border rounded px-4 py-2 mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-0 flex items-center gap-2">
        {activeOrgs.length > 1 ? (
          <Select value={org.id} onChange={setOrg} options={activeOrgs.map((o) => ({ value: o.id, label: o.client_name ? `${o.name} · ${o.client_name}` : o.name }))} className="max-w-[320px]" />
        ) : (
          <span className="text-14 font-medium text-ink truncate">{org.name}{org.client_name ? <span className="text-inkMuted font-normal"> · {org.client_name}</span> : null}</span>
        )}
      </div>
      <div className="flex-1" />
      <div className="text-12 text-inkMuted">
        <span className={state === 'Sync failed' ? 'text-danger' : state === 'Syncing' ? 'text-warning' : 'text-success'}>{state}</span>
        {org.last_sync_at ? <> · last synced {dateTime(org.last_sync_at)}</> : null}
      </div>
      {can.manage ? (
        <Btn onClick={() => sync.mutate()} loading={sync.isPending} disabled={org.sync_status === 'syncing'}>
          {sync.isPending ? null : <RefreshCw size={14} />}Sync now
        </Btn>
      ) : null}
    </div>
  );
}

function NotReady() {
  const { status, can } = useBooks();
  const navigate = useNavigate();
  const connected = status.connections.some((c) => c.status === 'connected');
  const expired = status.connections.some((c) => ['expired', 'revoked'].includes(c.status));
  return (
    <div className="bg-surface border border-border rounded">
      {!status.configured ? (
        <Empty title="Zoho Books is not configured">
          The server has no Zoho Books API credentials yet. An administrator must set ZBOOKS_CLIENT_ID and ZBOOKS_CLIENT_SECRET (see docs/books-zoho/README.md).
        </Empty>
      ) : connected ? (
        <Empty title="Select a Zoho Books organisation">
          Your Zoho account is connected. Choose which organisation to use in Books → Settings.
          {can.settings ? <div className="mt-3"><Btn variant="primary" onClick={() => navigate('/books/settings')}>Choose organisation</Btn></div> : null}
        </Empty>
      ) : (
        <Empty title={expired ? 'Reconnect Zoho Books' : 'Connect Zoho Books'}>
          {expired ? 'The Zoho Books connection has expired or was revoked.' : 'Connect your Zoho Books organisation to start managing your accounting data from Audit OS.'}
          {can.settings ? <div className="mt-3"><Btn variant="primary" onClick={() => navigate('/books/settings')}>{expired ? 'Reconnect' : 'Connect Zoho Books'}</Btn></div> : <div className="mt-2">Ask an administrator with Books settings access to connect it.</div>}
        </Empty>
      )}
    </div>
  );
}
