import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { workstationApi } from '@/modules/workstation/api';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Download, FileSpreadsheet, Plus } from 'lucide-react';
import {
  Field, Modal, QueryState, fieldErrors, inputClass, textareaClass,
} from '@/modules/workstation/components';
import {
  FilterSelect, ListAction, ListCard, ListEmpty, ListHeader, ListToolbar, SearchBox,
  StatusChip, TogglePill, statusLabel,
} from '@/modules/workstation/listUi';
import type { ClientListItem } from '@/modules/workstation/types';
import {
  clientQueryString, clientsBulkApi, downloadFile, ImportClientsDialog, type ClientPage, type ClientPageQuery,
} from '@/modules/workstation/clientImport';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';
import { Avatar, Ring } from '@/components/viz';
import { paymentSummaryApi } from '@/modules/paymentSummary/api';
import { gstApi } from '@/modules/workstation/gst/api';
import { tdsApi } from '@/modules/tds/api';
import { fyLabelForDate } from '@/pages/workstation/tds/config';
import { istToday } from '@/modules/dashboardV2/brief';
import { formatINR } from '@/modules/dashboardV2/format';
import { clientHealth, gstHistory, lastPeriods, tdsRowsFor, type PeriodState } from '@/modules/workstation/clientInsights';
import { ClientPanel } from './ClientPanel';
import { deriveShortName, OrganizationBadge, OrganizationOf } from '@/modules/workstation/organization/badges';
import { gstinError, isPan, normId } from '@/lib/ids';

/**
 * §7.3 — the client list. Search covers company · Client ID · GSTIN · contact.
 *
 * Saved views across the top (status, plus "Payment overdue" and "My
 * clients"), each with its count. Rows carry the last six GST periods as a
 * strip, the amount outstanding and a health score; clicking a row opens the
 * Client 360 panel beside the list (⌘/Ctrl-click opens the full workspace).
 * The money, GST and TDS columns appear only for roles that can read them.
 */
export function ClientsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { session } = useAuth();
  const role = session?.role.code;
  // `?add=1` (the top bar's Create menu) opens the add form on arrival;
  // `?import=1` (the setup checklist) opens the Excel import.
  const [addOpen, setAddOpen] = useState(() => params.get('add') === '1');
  const [importOpen, setImportOpen] = useState(() => params.get('import') === '1');

  const q = params.get('q') ?? '';
  const status = params.get('status') ?? '';
  const view = params.get('view') ?? '';
  const managerId = params.get('account_manager_id') ?? '';
  const serviceId = params.get('service_id') ?? '';
  const pendingDocs = params.get('pending_documents') === 'true';
  const openId = params.get('client') ?? '';
  const sort = params.get('sort') ?? '';
  const order: 'asc' | 'desc' = params.get('order') === 'desc' ? 'desc' : 'asc';
  const page = Math.max(1, Number(params.get('page')) || 1);

  // Any change to what is listed goes back to page 1 and drops the selection.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'client' && key !== 'page') { next.delete('page'); setSelected(new Set()); }
    setParams(next, { replace: true });
  };
  const setView = (v: { status?: string; view?: string }) => {
    const next = new URLSearchParams(params);
    next.delete('status'); next.delete('view'); next.delete('page');
    if (v.status) next.set('status', v.status);
    if (v.view) next.set('view', v.view);
    setSelected(new Set());
    setParams(next, { replace: true });
  };
  const sortBy = (key: string) => {
    const next = new URLSearchParams(params);
    const dir = sort === key && order === 'asc' ? 'desc' : 'asc';
    next.set('sort', key); next.set('order', dir); next.delete('page');
    setParams(next, { replace: true });
  };

  const catalog = useQuery({ queryKey: ['workstation', 'catalog'], queryFn: workstationApi.serviceCatalog });
  const employees = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees });

  // Per-client signals, each gated on the role's permission.
  const seesBilling = can(role, 'payment_summary.read', 'organisation');
  const seesGst = can(role, 'workstation.gst.read', 'self');
  const seesTds = can(role, 'workstation.service.read', 'self');
  const money = useQuery({ queryKey: ['payment-summary'], queryFn: () => paymentSummaryApi.summary(), enabled: seesBilling });
  const moneyById = useMemo(() => new Map((money.data?.clients ?? []).map((c) => [c.client_id, c])), [money.data]);
  const overdueIds = useMemo(() => (money.data?.clients ?? []).filter((c) => c.overdue_paise > 0).map((c) => c.client_id), [money.data]);

  // One paged request: the rows on this page, the total that matches, and
  // the per-view counts (facets) — no second fetch of the whole list.
  const listQuery: ClientPageQuery = {
    q, status, account_manager_id: managerId, service_id: serviceId,
    pending_documents: pendingDocs || undefined,
    mine: view === 'mine' || undefined,
    kind: view === 'organizations' ? 'organization' : undefined,
    // "Payment overdue" is known from the payment summary, so it is sent as ids.
    ids: view === 'overdue' ? (overdueIds.join(',') || '__none__') : undefined,
    sort: sort || undefined, order: sort ? order : undefined,
    page, page_size: PAGE_SIZE, facets: true,
  };
  const clients = useQuery({
    queryKey: ['workstation', 'clients', 'page', listQuery],
    queryFn: () => clientsBulkApi.page(listQuery),
    enabled: view !== 'overdue' || !!money.data,
    placeholderData: keepPreviousData,
  });
  const facets = clients.data?.facets;

  const periods = useMemo(() => lastPeriods(istToday(), 6), []);
  const gstQueries = useQueries({
    queries: periods.map((p) => ({
      queryKey: ['gst', 'client-dashboard', p],
      queryFn: () => gstApi.clientDashboard(p),
      enabled: seesGst, staleTime: 120_000,
    })),
  });
  const gstLoaded = seesGst && gstQueries.every((g) => g.isSuccess);
  const gst = useMemo(
    () => (gstLoaded ? gstHistory(periods, gstQueries.map((g) => g.data)) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gstLoaded, periods, ...gstQueries.map((g) => g.dataUpdatedAt)],
  );
  const fy = fyLabelForDate(new Date());
  const tds = useQuery({ queryKey: ['tds', 'overview', fy], queryFn: () => tdsApi.overview(fy), enabled: seesTds });

  const knows = { money: !!money.data, gst: !!gst, tds: !!tds.data };
  const healthOf = (c: ClientListItem) => clientHealth({
    client: c, money: moneyById.get(c.id), gst: gst?.byClient.get(c.id), tds: tdsRowsFor(tds.data, c.id), knows,
  });

  const canManage = can(role, 'workstation.client.manage', 'self');
  const canAssign = canManage && can(role, 'clients.view_all', 'organisation');
  const myId = session?.employee?.id;
  const views: { key: string; label: string; count: number | null; apply: { status?: string; view?: string }; show: boolean }[] = [
    { key: '', label: 'All clients', count: facets ? facets.total : null, apply: {}, show: true },
    { key: 'status:active', label: 'Active', count: facets?.by_status.active ?? (facets ? 0 : null), apply: { status: 'active' }, show: true },
    { key: 'status:onboarding', label: 'Onboarding', count: facets?.by_status.onboarding ?? (facets ? 0 : null), apply: { status: 'onboarding' }, show: true },
    { key: 'status:pending_documents', label: 'Pending documents', count: facets?.by_status.pending_documents ?? (facets ? 0 : null), apply: { status: 'pending_documents' }, show: true },
    { key: 'status:service_due', label: 'Service due', count: facets?.by_status.service_due ?? (facets ? 0 : null), apply: { status: 'service_due' }, show: true },
    { key: 'view:overdue', label: 'Payment overdue', count: money.data ? overdueIds.length : null, apply: { view: 'overdue' }, show: seesBilling },
    { key: 'view:organizations', label: 'Organizations', count: facets ? facets.organizations : null, apply: { view: 'organizations' }, show: !!facets?.organizations },
    { key: 'view:mine', label: 'My clients', count: facets ? facets.mine : null, apply: { view: 'mine' }, show: !!myId },
    { key: 'status:inactive', label: 'Inactive', count: facets?.by_status.inactive ?? (facets ? 0 : null), apply: { status: 'inactive' }, show: true },
  ];
  const activeView = status ? `status:${status}` : view ? `view:${view}` : '';

  const pageItems = clients.data?.items ?? [];
  // A client opened from a link may be on another page: fetch just that one.
  const openedOnPage = pageItems.find((c) => c.id === openId);
  const openedFetch = useQuery({
    queryKey: ['workstation', 'clients', 'one', openId],
    queryFn: () => clientsBulkApi.page({ ids: openId }),
    enabled: !!openId && !openedOnPage && clients.isSuccess,
    staleTime: 60_000,
  });
  const opened = openedOnPage ?? openedFetch.data?.items.find((c) => c.id === openId);

  const total = clients.data?.count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ── Bulk actions ──
  const pageIds = pageItems.map((c) => c.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSelected((s) => {
    const n = new Set(s);
    if (allOnPage) pageIds.forEach((id) => n.delete(id)); else pageIds.forEach((id) => n.add(id));
    return n;
  });
  const bulk = useMutation({
    mutationFn: clientsBulkApi.bulk,
    onSuccess: (r) => {
      toast.push('success', `${r.updated} client${r.updated === 1 ? '' : 's'} updated.`);
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      void qc.invalidateQueries({ queryKey: ['sidebar', 'client-count'] });
    },
    onError: (e) => toast.push('error', (e as Error).message || 'Could not update the clients.'),
  });
  const assign = (employeeId: string) => {
    const who = employees.data?.items.find((e) => e.id === employeeId)?.full_name ?? 'this employee';
    if (window.confirm(`Make ${who} the account manager of ${selected.size} client${selected.size === 1 ? '' : 's'}?`)) {
      bulk.mutate({ ids: [...selected], action: 'assign_account_manager', account_manager_id: employeeId });
    }
  };
  const restatus = (value: string) => {
    if (window.confirm(`Change the status of ${selected.size} client${selected.size === 1 ? '' : 's'} to ${statusLabel(value)}?`)) {
      bulk.mutate({ ids: [...selected], action: 'set_status', status: value });
    }
  };

  const [exporting, setExporting] = useState(false);
  const exportExcel = () => {
    setExporting(true);
    const { page: _p, page_size: _s, facets: _f, ...filters } = listQuery;
    downloadFile(`/api/clients/export${clientQueryString(filters)}`, 'clients.xlsx')
      .catch((e: Error) => toast.push('error', e.message))
      .finally(() => setExporting(false));
  };
  const fileActions = (
    <>
      {canManage ? (
        <Button size="sm" onClick={() => setImportOpen(true)}><FileSpreadsheet size={14} aria-hidden /> Import from Excel</Button>
      ) : null}
      <Button size="sm" onClick={exportExcel} disabled={exporting || total === 0}>
        <Download size={14} aria-hidden /> {exporting ? 'Exporting…' : 'Export to Excel'}
      </Button>
    </>
  );

  // A firm with no clients at all gets a way in; a filter that matches
  // nothing says so instead.
  const filtered = !!(q || status || view || managerId || serviceId || pendingDocs);
  const emptyState = !filtered ? (
    <ListEmpty>
      <div className="text-14 font-semibold text-neutral-900">No clients yet</div>
      <div className="mt-1">Every service, document and invoice hangs off a client — start with one, or bring your whole list in from Excel.</div>
      {canManage ? (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <ListAction onClick={() => setAddOpen(true)} icon={<Plus size={15} />}>Add your first client</ListAction>
          <Button onClick={() => setImportOpen(true)}><FileSpreadsheet size={15} aria-hidden /> Import from Excel</Button>
        </div>
      ) : null}
    </ListEmpty>
  ) : <ListEmpty>No clients match these filters.</ListEmpty>;

  // A plain function (not a component) so the header button keeps focus across re-renders.
  const sortIcon = (col: string) => (sort === col
    ? (order === 'asc' ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />)
    : <ArrowUpDown size={12} className="opacity-40" aria-hidden />);
  const ariaSort = (col: string) => (sort === col ? (order === 'asc' ? 'ascending' : 'descending') : 'none') as 'ascending' | 'descending' | 'none';

  return (
    <div className="max-w-[1480px]">
      <ListHeader
        title="Clients"
        meta={clients.data
          ? <>{facets ? `${facets.total} client${facets.total === 1 ? '' : 's'} · ` : ''}{clients.data.scope === 'organisation' ? 'every firm client' : 'clients assigned to you'} — services, filing record and money owed in one place.</>
          : 'One record per company. Everything else references it.'}
        action={canManage ? (
          <ListAction onClick={() => setAddOpen(true)} icon={<Plus size={15} />}>Add Client</ListAction>
        ) : undefined}
      />

      <nav className="cl-views flex gap-1 border-b border-border mb-4 overflow-x-auto" aria-label="Client views">
        {views.filter((v) => v.show).map((v) => (
          <button key={v.key} type="button" onClick={() => setView(v.apply)} aria-current={activeView === v.key ? 'page' : undefined}
            className={'cl-view relative flex items-center gap-2 px-3 pt-2 pb-[10px] text-13 font-medium whitespace-nowrap ' + (activeView === v.key ? 'is-on text-ink' : 'text-inkMuted hover:text-ink')}>
            {v.label}
            {v.count !== null ? <span className="cl-count">{v.count}</span> : null}
          </button>
        ))}
      </nav>

      {/* `contents` below 768px keeps the toolbar's sticky phone layout; from
          768px up the file actions sit at the right of the same row. */}
      <div className="contents md:flex md:items-start md:gap-3">
      <div className="contents md:block md:flex-1 md:min-w-0">
      <ListToolbar>
        <SearchBox value={q} onChange={(v) => setParam('q', v)} placeholder="Company, Client ID, GSTIN, PAN, contact" />
        <FilterSelect
          label="Service" value={serviceId} onChange={(v) => setParam('service_id', v)}
          options={(catalog.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))}
        />
        <FilterSelect
          label="Account manager" value={managerId} onChange={(v) => setParam('account_manager_id', v)}
          options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: e.full_name }))}
        />
        <TogglePill on={pendingDocs} onChange={(v) => setParam('pending_documents', v ? 'true' : '')}>
          Pending documents
        </TogglePill>
      </ListToolbar>
      </div>
      <div className="hidden md:flex items-center gap-2 shrink-0">{fileActions}</div>
      </div>
      {/* Phones: the toolbar keeps only search + Filters, so the file actions sit here. */}
      <div className="flex flex-wrap gap-2 mb-3 md:hidden">{fileActions}</div>

      <div className={'cl-split grid gap-4 items-start ' + (opened ? 'is-open' : '')}>
        <ListCard>
          {selected.size > 0 ? (
            <div className="flex flex-wrap items-center gap-2 px-5 py-2 border-b border-border bg-primary/5" role="region" aria-label="Bulk actions">
              <span className="text-13 font-semibold text-ink">{selected.size} selected</span>
              {canAssign ? (
                <select aria-label="Assign account manager" value="" disabled={bulk.isPending}
                  onChange={(e) => { if (e.target.value) assign(e.target.value); }}
                  className="h-8 px-2 text-13 bg-white text-neutral-700 border border-neutral-200 rounded-lg max-w-[220px]">
                  <option value="">Assign account manager…</option>
                  {(employees.data?.items ?? []).map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
                </select>
              ) : null}
              {canManage ? (
                <select aria-label="Change status" value="" disabled={bulk.isPending}
                  onChange={(e) => { if (e.target.value) restatus(e.target.value); }}
                  className="h-8 px-2 text-13 bg-white text-neutral-700 border border-neutral-200 rounded-lg">
                  <option value="">Change status…</option>
                  {CLIENT_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
                </select>
              ) : null}
              <button type="button" onClick={() => setSelected(new Set())} className="text-12 font-semibold text-primary hover:underline">Clear</button>
              {bulk.isPending ? <span className="text-12 text-inkMuted" role="status">Updating…</span> : null}
            </div>
          ) : null}
          <QueryState query={clients} empty={emptyState}>
            {(data: ClientPage) => {
              const items = data.items;
              if (items.length === 0) return emptyState;
              const from = (page - 1) * PAGE_SIZE + 1;
              return (
                <div className="overflow-x-auto">
                  <table className="cl-table w-full text-13">
                    <thead>
                      <tr>
                        <th aria-sort={ariaSort('company_name')}>
                          <span className="inline-flex items-center gap-3">
                            {canManage ? (
                              <input type="checkbox" aria-label={allOnPage ? 'Deselect all on this page' : 'Select all on this page'}
                                checked={allOnPage} onChange={toggleAll} />
                            ) : null}
                            <button type="button" onClick={() => sortBy('company_name')} className="inline-flex items-center gap-1 hover:text-ink">
                              Client {sortIcon('company_name')}
                            </button>
                          </span>
                        </th>
                        <th className="cl-hide-open cl-hide-xs">Services</th>
                        <th className="cl-hide-sm">Manager</th>
                        {seesGst ? <th className="cl-hide-sm" title="GSTR-1 and GSTR-3B for the last six periods">GST · 6 periods</th> : null}
                        {seesBilling ? <th className="text-right">Outstanding</th> : null}
                        <th className="cl-hide-open cl-hide-xs" aria-sort={ariaSort('status')}>
                          <button type="button" onClick={() => sortBy('status')} className="inline-flex items-center gap-1 hover:text-ink">Status {sortIcon('status')}</button>
                        </th>
                        {knows.money || knows.gst || knows.tds ? <th>Health</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((c) => {
                        const m = moneyById.get(c.id);
                        const h = healthOf(c);
                        const row = gst?.byClient.get(c.id);
                        return (
                          <tr key={c.id} tabIndex={0}
                            className={c.id === openId ? 'is-cur' : ''}
                            aria-selected={selected.has(c.id) || undefined}
                            onClick={(e) => {
                              if (e.metaKey || e.ctrlKey) { window.open(`/workstation/clients/${c.id}${c.is_organization ? '/organization' : ''}`, '_blank'); return; }
                              setParam('client', c.id === openId ? '' : c.id);
                            }}
                            onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) setParam('client', c.id); }}
                            onDoubleClick={() => navigate(`/workstation/clients/${c.id}${c.is_organization ? '/organization' : ''}`)}>
                            <td>
                              <div className="flex items-center gap-3 min-w-0">
                                {canManage ? (
                                  <input type="checkbox" aria-label={`Select ${c.company_name}`} checked={selected.has(c.id)}
                                    onClick={(e) => e.stopPropagation()} onChange={() => toggle(c.id)} />
                                ) : null}
                                <Avatar name={c.company_name} size={32} square />
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="font-semibold text-ink truncate max-w-[260px]">{c.company_name}</span>
                                    {c.is_organization ? <OrganizationBadge count={c.child_client_count} /> : null}
                                  </div>
                                  <div className="font-mono text-[11.5px] text-inkFaint truncate">{c.client_id}{c.gstin ? ` · ${c.gstin}` : ''}</div>
                                  {c.organization ? <OrganizationOf org={c.organization} /> : null}
                                </div>
                              </div>
                            </td>
                            <td className="cl-hide-open cl-hide-xs">
                              <div className="flex flex-wrap gap-1 max-w-[260px]">
                                {c.service_names.slice(0, 3).map((n) => <span key={n} className="cl-svc">{n}</span>)}
                                {c.service_names.length > 3 ? <span className="cl-svc">+{c.service_names.length - 3}</span> : null}
                                {c.service_names.length === 0 ? <span className="text-inkFaint">—</span> : null}
                              </div>
                            </td>
                            <td className="cl-hide-sm">
                              {c.account_manager ? (
                                <span
                                  className="flex items-center gap-2 text-inkMuted"
                                  title={c.secondary_manager ? `${c.account_manager.full_name} · second staff ${c.secondary_manager.full_name}` : c.account_manager.full_name}
                                >
                                  <span className="flex -space-x-2">
                                    <Avatar name={c.account_manager.full_name} size={24} />
                                    {c.secondary_manager ? <Avatar name={c.secondary_manager.full_name} size={24} /> : null}
                                  </span>
                                  <span className="truncate max-w-[120px] hidden 2xl:inline">{c.account_manager.full_name}{c.secondary_manager ? ' +1' : ''}</span>
                                </span>
                              ) : <span className="text-inkFaint">—</span>}
                            </td>
                            {seesGst ? (
                              <td className="cl-hide-sm">
                                {gst ? <Strip states={periods.map((p) => row?.get(p)?.state ?? 'none')} periods={periods} /> : <span className="text-inkFaint">…</span>}
                              </td>
                            ) : null}
                            {seesBilling ? (
                              <td className={'text-right num-display whitespace-nowrap ' + (m && m.overdue_paise > 0 ? 'text-danger' : 'text-ink')}>
                                {m && m.pending_paise > 0 ? formatINR(m.pending_paise / 100) : <span className="text-inkFaint font-normal">—</span>}
                              </td>
                            ) : null}
                            <td className="cl-hide-open cl-hide-xs"><StatusChip value={c.status} /></td>
                            {knows.money || knows.gst || knows.tds ? (
                              <td title={h ? (h.reasons.length ? h.reasons.join(' · ') : 'No issues found') : undefined}>
                                {h ? (
                                  <span className="inline-flex items-center gap-2 font-semibold text-ink tabular-nums">
                                    <Ring value={h.score / 100} size={22} />{h.score}
                                  </span>
                                ) : <span className="text-inkFaint">—</span>}
                              </td>
                            ) : null}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <nav className="flex flex-wrap items-center gap-3 px-5 py-3 border-t border-border text-12 text-inkMuted" aria-label="Pages">
                    <span>
                      {from}–{from + items.length - 1} of {data.count} client{data.count === 1 ? '' : 's'}
                      <span className="hidden md:inline"> · click a row for a quick look, double-click to open</span>
                    </span>
                    <span className="flex-1" />
                    {pages > 1 ? (
                      <span className="inline-flex items-center gap-2">
                        <Button size="sm" disabled={page <= 1} onClick={() => setParam('page', String(page - 1))} aria-label="Previous page">
                          <ChevronLeft size={14} aria-hidden /> Prev
                        </Button>
                        <span aria-live="polite">Page {page} of {pages}</span>
                        <Button size="sm" disabled={page >= pages} onClick={() => setParam('page', String(page + 1))} aria-label="Next page">
                          Next <ChevronRight size={14} aria-hidden />
                        </Button>
                      </span>
                    ) : null}
                  </nav>
                </div>
              );
            }}
          </QueryState>
        </ListCard>

        {opened ? <div className="cp-scrim" onClick={() => setParam('client', '')} aria-hidden /> : null}
        {opened ? (
          <ClientPanel
            key={opened.id}
            client={opened}
            money={moneyById.get(opened.id)}
            gst={gst}
            tds={tdsRowsFor(tds.data, opened.id)}
            health={healthOf(opened)}
            onClose={() => setParam('client', '')}
          />
        ) : null}
      </div>

      <AddClientModal open={addOpen && canManage} onClose={() => setAddOpen(false)} />
      <ImportClientsDialog open={importOpen && canManage} onClose={() => {
        setImportOpen(false);
        if (params.get('import')) setParam('import', '');
      }} />
    </div>
  );
}

const PAGE_SIZE = 50;
const CLIENT_STATUSES = ['active', 'onboarding', 'pending_documents', 'service_due', 'inactive'] as const;

/** Last six GST periods as small bars: filed · overdue · open · nothing due. */
function Strip({ states, periods }: { states: PeriodState[]; periods: string[] }) {
  const label: Record<PeriodState, string> = { filed: 'filed', overdue: 'overdue', pending: 'open', none: 'nothing due' };
  return (
    <span className="inline-flex gap-[3px]" aria-label={`GST: ${states.map((s, i) => `${periods[i]} ${label[s]}`).join(', ')}`}>
      {states.map((s, i) => (
        <i key={periods[i]} className={'cl-strip is-' + s}
          title={`${new Date(`${periods[i]}-01T00:00:00`).toLocaleString('en-IN', { month: 'short', year: 'numeric' })}: ${label[s]}`} />
      ))}
    </span>
  );
}

/**
 * Add Client (§7.3).
 *
 * A client created here starts in `onboarding`, and its Client ID is issued by
 * the server — neither is an input, because both are the record's identity
 * rather than someone's choice. A lead that converts takes the same path via
 * Leads → Convert, so there is exactly one way a Client row comes to exist.
 */
export function AddClientModal({ open, onClose, organization, defaultName, onCreated }: {
  open: boolean;
  onClose: () => void;
  /** Create the client under this organization (it stays a normal client). */
  organization?: { id: string; name: string };
  defaultName?: string;
  /** Instead of opening the new client's workspace. */
  onCreated?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const employees = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees });

  const [form, setForm] = useState({
    company_name: defaultName ?? '', business_type: '', contact_person: '', contact_number: '',
    email: '', gstin: '', pan: '', address: '', account_manager_id: '', secondary_manager_id: '',
    kind: 'client' as 'client' | 'organization', short_name: '',
  });
  const isOrg = !organization && form.kind === 'organization';
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});

  const create = useMutation({
    mutationFn: () => workstationApi.createClient({
      company_name: form.company_name,
      contact_person: form.contact_person,
      contact_number: form.contact_number,
      account_manager_id: form.account_manager_id,
      secondary_manager_id: form.secondary_manager_id || undefined,
      business_type: form.business_type || undefined,
      email: form.email || undefined,
      // GSTIN and PAN are stored upper-case; normalise here so the value the
      // user sees submitted is the value that gets stored.
      gstin: form.gstin ? form.gstin.toUpperCase() : undefined,
      pan: form.pan ? form.pan.toUpperCase() : undefined,
      address: form.address || undefined,
      ...(organization ? { organization_id: organization.id } : {}),
      ...(isOrg ? { is_organization: true, short_name: form.short_name || undefined } : {}),
    }),
    onSuccess: (client) => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', organization
        ? `${client.company_name} (${client.client_id}) added to ${organization.name}.`
        : `${isOrg ? 'Organization client' : 'Client'} ${client.client_id} created.`);
      onClose();
      if (onCreated) onCreated(client.id);
      else navigate(`/workstation/clients/${client.id}${client.is_organization ? '/organization' : ''}`);
    },
  });

  // Client-side validation mirrors the server's, so the obvious mistakes are
  // caught without a round trip — but the server validates again regardless.
  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!form.company_name.trim()) e.company_name = 'This field is required.';
    if (!form.contact_person.trim()) e.contact_person = 'This field is required.';
    if (!/^[6-9]\d{9}$/.test(form.contact_number.replace(/[\s\-()]/g, '').replace(/^\+91/, ''))) {
      e.contact_number = 'Enter a valid 10-digit Indian mobile number.';
    }
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      e.email = 'Enter a valid email address.';
    }
    const gstin = normId(form.gstin);
    const pan = normId(form.pan);
    if (gstin) {
      const ge = gstinError(gstin, pan);
      if (ge) e.gstin = ge;
    }
    if (pan && !isPan(pan)) {
      e.pan = 'Enter a valid 10-character PAN.';
    }
    if (!form.account_manager_id) e.account_manager_id = 'Select an employee.';
    setClientErrors(e);
    return Object.keys(e).length === 0;
  }

  const serverErrors = fieldErrors(create.error);
  const err = (f: string) => clientErrors[f] ?? serverErrors[f];

  return (
    <Modal
      open={open}
      title={organization ? `Add Client to ${organization.name}` : 'Add Client'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={create.isPending}
            onClick={() => { if (validate()) create.mutate(); }}
          >
            {create.isPending ? 'Saving…' : 'Create Client'}
          </Button>
        </>
      }
    >
      {organization ? (
        <div className="mb-4 rounded-lg bg-primary/5 px-3 py-2 text-12 text-neutral-700">
          This becomes a full client with its own workspace, linked to <b>{organization.name}</b>.
        </div>
      ) : (
        <Field label="Client Type" hint={isOrg ? 'An organization is a client that other clients can be added under.' : undefined}>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Client type">
            {([['client', 'Client'], ['organization', 'Organization']] as const).map(([value, label]) => (
              <label
                key={value}
                className={'flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer text-13 ' +
                  (form.kind === value ? 'border-primary bg-primary/5' : 'border-neutral-200 hover:border-neutral-300')}
              >
                <input type="radio" name="client_kind" checked={form.kind === value} onChange={() => set('kind', value)} />
                {label}
              </label>
            ))}
          </div>
        </Field>
      )}
      <Field label={isOrg ? 'Organization Name' : 'Company Name'} error={err('company_name')}>
        <input className={inputClass} value={form.company_name} onChange={(e) => set('company_name', e.target.value)} />
      </Field>
      {isOrg ? (
        <Field label="Short Name" error={err('short_name')} hint={`Used to name its clients: "${form.short_name || deriveShortName(form.company_name) || 'ABC'} DV Client 1".`}>
          <input
            className={inputClass} maxLength={20} value={form.short_name}
            placeholder={deriveShortName(form.company_name)}
            onChange={(e) => set('short_name', e.target.value.toUpperCase())}
          />
        </Field>
      ) : null}
      <Field label="Business Type" error={err('business_type')} hint="Private Limited, LLP, Proprietorship…">
        <input className={inputClass} value={form.business_type} onChange={(e) => set('business_type', e.target.value)} />
      </Field>
      <Field label="Contact Person" error={err('contact_person')}>
        <input className={inputClass} value={form.contact_person} onChange={(e) => set('contact_person', e.target.value)} />
      </Field>
      <Field label="Contact Number" error={err('contact_number')}>
        <input className={inputClass} value={form.contact_number} onChange={(e) => set('contact_number', e.target.value)} placeholder="9876543210" />
      </Field>
      <Field label="Email" error={err('email')}>
        <input className={inputClass} value={form.email} onChange={(e) => set('email', e.target.value)} />
      </Field>
      <Field label="GSTIN" error={err('gstin')} hint="Optional — leave empty if the client is unregistered.">
        <input
          className={inputClass} value={form.gstin}
          onChange={(e) => set('gstin', e.target.value.toUpperCase())}
          placeholder="33AABCU9603R1ZM" maxLength={15}
        />
      </Field>
      <Field label="PAN" error={err('pan')}>
        <input
          className={inputClass} value={form.pan}
          onChange={(e) => set('pan', e.target.value.toUpperCase())}
          placeholder="AABCU9603R" maxLength={10}
        />
      </Field>
      <Field label="Address" error={err('address')}>
        <textarea className={textareaClass} rows={3} value={form.address} onChange={(e) => set('address', e.target.value)} />
      </Field>
      <Field label="Account Manager" error={err('account_manager_id')}>
        <select className={inputClass} value={form.account_manager_id} onChange={(e) => set('account_manager_id', e.target.value)}>
          <option value="">Select an employee…</option>
          {(employees.data?.items ?? []).map((e) => (
            <option key={e.id} value={e.id}>{e.full_name} · {e.designation}</option>
          ))}
        </select>
      </Field>
      <Field label="Second Staff" error={err('secondary_manager_id')} hint="Optional. Also sees and works this client, and covers when the account manager cannot.">
        <select className={inputClass} value={form.secondary_manager_id} onChange={(e) => set('secondary_manager_id', e.target.value)}>
          <option value="">No second staff</option>
          {(employees.data?.items ?? []).filter((e) => e.id !== form.account_manager_id).map((e) => (
            <option key={e.id} value={e.id}>{e.full_name} · {e.designation}</option>
          ))}
        </select>
      </Field>
      {/* Client ID and status are system-assigned (§5.2) — stated, never edited. */}
      <div className="text-12 text-neutral-500 border-t border-neutral-200 pt-3">
        Client ID is issued on save · status starts as Onboarding.
      </div>
    </Modal>
  );
}
