import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, RefreshCw } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { booksApi, errorText } from '@/modules/books/api';
import { BooksProvider, orgLabel, statusKey, useBooks } from '@/modules/books/context';
import { Btn, Empty, ErrorState, Select, Skeleton, dateTime } from '@/modules/books/ui';
import { NoZohoOrganisations } from './BooksSettings';

/**
 * Tools → Books. The frame every Books screen renders in: the organisation
 * switcher, sync status, and the section navigation. Screens that need Zoho
 * data sit behind the organisation gate; Settings is always reachable so a
 * user can connect in the first place.
 */
/** Mirrors Zoho Books' own sidebar — same sections, order and names. */
const NAV: { group?: string; items: { to: string; label: string; perm?: 'reports' }[] }[] = [
  { items: [{ to: '/books', label: 'Home' }] },
  { group: 'Items', items: [
    { to: '/books/items', label: 'Items' },
    { to: '/books/pricelists', label: 'Price Lists' },
    { to: '/books/inventory-adjustments', label: 'Inventory Adjustments' },
  ] },
  { items: [{ to: '/books/banking', label: 'Banking' }] },
  { group: 'Sales', items: [
    { to: '/books/customers', label: 'Customers' },
    { to: '/books/sales/estimates', label: 'Quotes' },
    { to: '/books/sales/retainerinvoices', label: 'Retainer Invoices' },
    { to: '/books/sales/salesorders', label: 'Sales Orders' },
    { to: '/books/sales/deliverychallans', label: 'Delivery Challans' },
    { to: '/books/sales/invoices', label: 'Invoices' },
    { to: '/books/sales/salesreceipts', label: 'Sales Receipts' },
    { to: '/books/sales/paymentsreceived', label: 'Payments Received' },
    { to: '/books/sales/recurringinvoices', label: 'Recurring Invoices' },
    { to: '/books/credit-notes', label: 'Credit Notes' },
    { to: '/books/sales/ewaybills', label: 'e-Way Bills' },
  ] },
  { group: 'Purchases', items: [
    { to: '/books/vendors', label: 'Vendors' },
    { to: '/books/expenses', label: 'Expenses' },
    { to: '/books/purchases/recurringexpenses', label: 'Recurring Expenses' },
    { to: '/books/purchases/purchaseorders', label: 'Purchase Orders' },
    { to: '/books/purchases/bills', label: 'Bills' },
    { to: '/books/purchases/paymentsmade', label: 'Payments Made' },
    { to: '/books/purchases/recurringbills', label: 'Recurring Bills' },
    { to: '/books/debit-notes', label: 'Vendor Credits' },
  ] },
  { group: 'Time Tracking', items: [
    { to: '/books/timetracking/projects', label: 'Projects' },
    { to: '/books/timetracking/timesheet', label: 'Timesheet' },
  ] },
  { group: 'Accountant', items: [
    { to: '/books/accountant/manualjournals', label: 'Manual Journals' },
    { to: '/books/accountant/bulkupdate', label: 'Bulk Update' },
    { to: '/books/accountant/currencyadjustments', label: 'Currency Adjustments' },
    { to: '/books/accountant/chartofaccounts', label: 'Chart of Accounts' },
    { to: '/books/accountant/budgets', label: 'Budgets' },
    { to: '/books/accountant/transactionlocking', label: 'Transaction Locking' },
  ] },
  { items: [{ to: '/books/reports', label: 'Reports', perm: 'reports' }] },
  { items: [{ to: '/books/documents', label: 'Documents' }] },
  { items: [{ to: '/books/settings', label: 'Settings' }] },
];

export function BooksShell() {
  return (
    <BooksProvider>
      {({ loading, error, ctx }) => (
        <div className="books-m max-w-[1480px] mx-auto">
          <div className="mb-5">
            <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] text-ink">Books</h1>
            <p className="text-13 text-inkMuted mt-1">Zoho Books for your clients — sales, purchases, banking and accounts in one place.</p>
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
      <nav aria-label="Books sections" className="hidden lg:block w-56 shrink-0">
        <div className="dash-card books-nav p-2 sticky top-4">
          {NAV.map((g, gi) => {
            const list = g.items.filter((i) => !i.perm || can[i.perm]);
            if (!list.length) return null;
            return (
              <div key={gi} className={gi ? 'mt-1 pt-1 border-t border-neutral-100' : ''}>
                {g.group ? <div className="px-3 pt-2 pb-1 text-12 font-semibold text-ink">{g.group}</div> : null}
                {list.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.to === '/books'}
                    className={({ isActive }) => `books-nav-item block rounded-lg px-3 py-2 text-13 ${g.group ? 'pl-5' : ''} ${isActive ? 'is-active font-semibold' : 'text-inkMuted font-medium'}`}>
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
    <div className="dash-card px-4 py-3 mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-0 flex items-center gap-3">
        <span className="h-9 w-9 rounded-lg inline-flex items-center justify-center shrink-0" style={{ background: '#efeafd', color: '#6941d9', boxShadow: 'inset 0 0 0 1px #ddd5f6' }}>
          <Building2 size={17} strokeWidth={1.9} />
        </span>
        {activeOrgs.length > 1 ? (
          <Select value={org.id} onChange={setOrg} options={activeOrgs.map((o) => ({ value: o.id, label: o.client_name ? `${orgLabel(o)} · ${o.client_name}` : orgLabel(o) }))} className="max-w-[360px]" />
        ) : (
          <span className="text-14 font-medium text-ink truncate">{orgLabel(org)}{org.client_name ? <span className="text-inkMuted font-normal"> · {org.client_name}</span> : null}</span>
        )}
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-2 text-12 text-inkMuted">
        <span className="inline-flex items-center gap-2 h-6 px-3 rounded-full font-medium"
          style={state === 'Sync failed' ? { background: '#fef2f2', color: '#b91c1c' } : state === 'Syncing' ? { background: '#fffbeb', color: '#b45309' } : { background: '#ecfdf5', color: '#047857' }}>
          <span className={'rounded-full ' + (state === 'Syncing' ? 'animate-pulse' : '')} style={{ width: 6, height: 6, background: state === 'Sync failed' ? '#ef4444' : state === 'Syncing' ? '#f59e0b' : '#10b981' }} />
          {state}
        </span>
        {org.last_sync_at ? <span>Last synced {dateTime(org.last_sync_at)}</span> : null}
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
    <div className="dash-card">
      {!status.configured ? (
        <Empty title="Zoho Books is not configured">
          The server has no Zoho Books API credentials yet. An administrator must set ZBOOKS_CLIENT_ID and ZBOOKS_CLIENT_SECRET (see docs/books-zoho/README.md).
        </Empty>
      ) : connected && status.organizations.length === 0 ? (
        <NoZohoOrganisations />
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
