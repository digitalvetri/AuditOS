/**
 * Global search (top bar). One box, four sources, grouped results:
 *
 *   Pages      the navigation the caller can see (Attendance, Payroll, …)
 *   Employees  GET /api/employees?q=      (server-scoped to the caller)
 *   Workstation GET /api/workstation/search (leads, clients, services)
 *   Tools      the Tools registry (name, description, keywords)
 *
 * With an empty box it offers quick actions (every "new …" the role may
 * start) and jump-to pages; a client hit adds "New invoice" / "Record
 * payment" actions for that client. Follow-ups and documents from the
 * Workstation search are listed too.
 *
 * Keyboard: ⌘K / Ctrl+K focuses the box, ↑↓ move, Enter opens, Esc closes.
 * The `focusRef` lets the top-bar icon button focus it too.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight, CalendarClock, FileSignature, FileText, Handshake, IndianRupee, LayoutGrid, PhoneCall, Plane, Plus, Receipt,
  ReceiptText, ScrollText, Search, UserPlus, Users, Wrench, type LucideIcon,
} from 'lucide-react';
import { Avatar } from '@/components/viz';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { employeeApi, isFullEmployee } from '@/modules/employees/api';
import { workstationApi } from '@/modules/workstation/api';
import { searchTools, TOOLS } from '@/modules/tools/registry';

export interface GlobalSearchHandle { focus: () => void }

interface Hit { group: string; label: string; hint?: string; to: string; icon?: LucideIcon; avatar?: string }

export const GlobalSearch = forwardRef<GlobalSearchHandle>(function GlobalSearch(_props, ref) {
  const { session } = useAuth();
  const role = session?.role.code;
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [value, setValue] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  useImperativeHandle(ref, () => ({ focus: () => { inputRef.current?.focus(); inputRef.current?.select(); } }), []);

  // Debounce network queries; the registry and page lists filter instantly.
  useEffect(() => {
    const t = window.setTimeout(() => setQ(value.trim()), 180);
    return () => window.clearTimeout(t);
  }, [value]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); inputRef.current?.focus(); inputRef.current?.select(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const canEmployees = can(role, 'employee.read', 'self') || can(role, 'employee.read.restricted', 'organisation');
  const canWorkstation = can(role, 'workstation.access', 'self');
  const canTools = can(role, 'tools.access', 'self');

  const employees = useQuery({
    queryKey: ['search', 'employees', q],
    queryFn: () => employeeApi.list({ q }),
    enabled: open && q.length >= 2 && canEmployees,
    staleTime: 30_000,
  });
  const workstation = useQuery({
    queryKey: ['search', 'workstation', q],
    queryFn: () => workstationApi.search(q),
    enabled: open && q.length >= 2 && canWorkstation,
    staleTime: 30_000,
  });

  const pages = useMemo<Hit[]>(() => {
    const all: { label: string; to: string; visible: boolean; hint: string }[] = [
      { label: 'Dashboard', to: '/', visible: true, hint: 'Home' },
      { label: 'Employees', to: '/hrms/employees', visible: can(role, 'employee.read', 'department'), hint: 'HRMS' },
      { label: 'Attendance', to: '/hrms/attendance', visible: can(role, 'attendance.read', 'self'), hint: 'HRMS' },
      { label: 'Leave', to: '/hrms/leave', visible: can(role, 'leave.read', 'self'), hint: 'HRMS' },
      { label: 'Payroll', to: '/hrms/accounts/payroll', visible: can(role, 'payroll.view.own', 'self') || can(role, 'payroll.view', 'organisation'), hint: 'HRMS · Accounts' },
      { label: 'Expenses', to: '/hrms/accounts/expenses', visible: can(role, 'expense.submit', 'self') || can(role, 'expense.approve', 'department'), hint: 'HRMS · Accounts' },
      { label: 'Accounts', to: '/hrms/accounts', visible: can(role, 'accounts.read', 'organisation') || can(role, 'accounts.manage', 'organisation'), hint: 'HRMS' },
      { label: 'Messages', to: '/hrms/messages', visible: can(role, 'chat.participate', 'organisation'), hint: 'HRMS' },
      { label: 'Employee Data', to: '/hrms/documents', visible: can(role, 'document.read', 'self'), hint: 'HRMS' },
      { label: 'Payment summary', to: '/hrms/payment-summary', visible: can(role, 'payment_summary.read', 'organisation'), hint: 'HRMS' },
      { label: 'Reports', to: '/hrms/reports', visible: can(role, 'reports.hr', 'department') || can(role, 'reports.finance', 'organisation') || can(role, 'reports.all', 'organisation'), hint: 'HRMS' },
      { label: 'Settings', to: '/hrms/settings', visible: can(role, 'settings.manage', 'organisation'), hint: 'HRMS' },
      { label: 'Workstation overview', to: '/workstation', visible: canWorkstation, hint: 'Workstation' },
      { label: 'Leads', to: '/workstation/leads', visible: can(role, 'workstation.lead.read', 'self'), hint: 'Workstation' },
      { label: 'Clients', to: '/workstation/clients', visible: can(role, 'workstation.client.read', 'self'), hint: 'Workstation' },
      { label: 'Follow-ups', to: '/workstation/follow-ups', visible: can(role, 'workstation.followup.read', 'self'), hint: 'Workstation' },
      { label: 'Services', to: '/workstation/services', visible: can(role, 'workstation.service.read', 'self'), hint: 'Workstation' },
      { label: 'Client documents', to: '/workstation/documents', visible: can(role, 'workstation.document.read', 'self'), hint: 'Workstation' },
      { label: 'Tools & Converters', to: '/tools', visible: canTools, hint: 'Tools' },
      { label: 'Converted documents', to: '/tools/documents', visible: can(role, 'tools.documents.read', 'self'), hint: 'Tools' },
      { label: 'Notifications', to: '/notifications', visible: true, hint: 'Platform' },
      { label: 'My profile', to: '/me/profile', visible: Boolean(session?.employee), hint: 'Me' },
      { label: 'My payslips', to: '/me/payslips', visible: Boolean(session?.employee), hint: 'Me' },
    ];
    const needle = q.toLowerCase();
    return all.filter((p) => p.visible && needle && p.label.toLowerCase().includes(needle)).slice(0, 5).map((p) => ({ group: 'Pages', label: p.label, hint: p.hint, to: p.to, icon: LayoutGrid }));
  }, [q, role, session, canWorkstation, canTools]);

  // Quick actions — links into the existing "new …" forms the role may use.
  const actions = useMemo<Hit[]>(() => [
    { label: 'Create invoice', to: '/workstation/invoices/new', icon: ReceiptText, show: can(role, 'workstation.invoice.manage', 'self') },
    { label: 'Create quotation', to: '/workstation/quotations/new', icon: FileSignature, show: can(role, 'workstation.quotation.manage', 'self') },
    { label: 'Create engagement letter', to: '/workstation/engagement/new', icon: ScrollText, show: can(role, 'workstation.engagement.manage', 'self') },
    { label: 'Add client', to: '/workstation/clients?add=1', icon: Handshake, show: can(role, 'workstation.client.manage', 'self') },
    { label: 'Add lead', to: '/workstation/leads?add=1', icon: PhoneCall, show: can(role, 'workstation.lead.manage', 'self') },
    { label: 'Add employee', to: '/hrms/employees?add=1', icon: UserPlus, show: can(role, 'employee.manage', 'organisation') },
    { label: 'Request leave', to: '/me/leave', icon: Plane, show: can(role, 'leave.request', 'self') },
    { label: 'Submit an expense', to: '/me/expenses', icon: Receipt, show: can(role, 'expense.submit', 'self') },
  ].filter((a) => a.show).map(({ label, to, icon }) => ({ group: 'Actions', label, to, icon })), [role]);

  const hits = useMemo<Hit[]>(() => {
    if (!q) {
      // Empty box: what you can start, then the most-used places.
      return [
        ...actions.slice(0, 5),
        ...[
          { label: 'Dashboard', to: '/', show: true },
          { label: 'Clients', to: '/workstation/clients', show: can(role, 'workstation.client.read', 'self') },
          { label: 'Invoices', to: '/workstation/invoices', show: can(role, 'workstation.invoice.read', 'self') },
          { label: 'Attendance', to: '/hrms/attendance', show: can(role, 'attendance.read', 'self') },
          { label: 'Payment summary', to: '/hrms/payment-summary', show: can(role, 'payment_summary.read', 'organisation') },
        ].filter((p) => p.show).map((p) => ({ group: 'Jump to', label: p.label, to: p.to, icon: ArrowRight })),
      ];
    }
    const needle = q.toLowerCase();
    const out: Hit[] = [...actions.filter((a) => a.label.toLowerCase().includes(needle)).slice(0, 3), ...pages];
    for (const e of (employees.data?.items ?? []).slice(0, 6)) {
      out.push({ group: 'Employees', label: e.full_name, hint: isFullEmployee(e) ? `${e.employee_code} · ${e.email}` : e.employee_code, to: `/hrms/employees/${e.id}`, avatar: e.full_name });
    }
    const ws = workstation.data;
    if (ws) {
      for (const c of ws.clients.slice(0, 4)) out.push({ group: 'Clients', label: c.company_name, hint: [c.client_id, c.gstin].filter(Boolean).join(' · '), to: `/workstation/clients/${c.id}`, avatar: c.company_name });
      // The top client match also gets its most common next steps.
      const top = ws.clients[0];
      if (top && can(role, 'workstation.invoice.manage', 'self')) {
        out.push({ group: 'Client actions', label: `New invoice for ${top.company_name}`, to: `/workstation/invoices/new?client_id=${top.id}`, icon: Plus });
      }
      if (top && can(role, 'workstation.invoice.read', 'self')) {
        out.push({ group: 'Client actions', label: `Record payment for ${top.company_name}`, hint: 'Opens the client’s invoices', to: `/workstation/clients/${top.id}/invoices`, icon: IndianRupee });
      }
      for (const l of ws.leads.slice(0, 4)) out.push({ group: 'Leads', label: l.name, hint: `${l.lead_id}${l.service_name ? ` · ${l.service_name}` : ''}`, to: `/workstation/leads/${l.id}`, icon: PhoneCall });
      for (const s of ws.services.slice(0, 3)) out.push({ group: 'Services', label: s.service_name ?? 'Service', hint: s.client_name ?? undefined, to: `/workstation/clients/${s.client_id}/services`, icon: LayoutGrid });
      for (const f of ws.follow_ups.slice(0, 3)) out.push({ group: 'Follow-ups', label: f.title, hint: [f.subject_name, new Date(f.scheduled_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })].filter(Boolean).join(' · '), to: '/workstation/follow-ups', icon: CalendarClock });
      for (const d of ws.documents.slice(0, 3)) out.push({ group: 'Documents', label: d.name, hint: d.client_name ?? undefined, to: `/workstation/clients/${d.client_id}/documents`, icon: FileText });
    }
    if (canTools) {
      for (const t of searchTools(q, TOOLS).slice(0, 5)) out.push({ group: 'Tools', label: t.name, hint: t.description, to: t.route, icon: Wrench });
    }
    return out;
  }, [q, pages, actions, role, employees.data, workstation.data, canTools]);

  useEffect(() => { setActive(0); }, [hits.length, q]);

  const go = (hit: Hit) => {
    setOpen(false);
    setValue('');
    navigate(hit.to);
  };

  const loading = (employees.isFetching || workstation.isFetching) && q.length >= 2;
  const groups = useMemo(() => {
    const map = new Map<string, { hit: Hit; index: number }[]>();
    hits.forEach((hit, index) => { map.set(hit.group, [...(map.get(hit.group) ?? []), { hit, index }]); });
    return [...map.entries()];
  }, [hits]);

  return (
    <div className="relative" ref={boxRef}>
      <label className="relative block">
        <span className="absolute inset-y-0 left-5 flex items-center text-inkMuted">
          <Search size={18} strokeWidth={1.75} />
        </span>
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={(e) => { setValue(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); return; }
            if (!hits.length) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % hits.length); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + hits.length) % hits.length); }
            else if (e.key === 'Enter') { e.preventDefault(); go(hits[active] ?? hits[0]); }
          }}
          placeholder="Search clients, invoices, people, actions…"
          className="w-full h-12 pl-12 pr-16 text-15 bg-surface text-ink placeholder:text-inkFaint border border-border/70 rounded-lg shadow-card transition-shadow hover:shadow-raised focus:outline-none focus:border-gold focus:ring-4 focus:ring-gold/15"
          aria-label="Global search"
          aria-expanded={open && Boolean(q)}
          autoComplete="off"
          data-testid="global-search"
        />
        {!value ? (
          <kbd className="pointer-events-none absolute inset-y-0 right-3 my-auto h-6 px-2 inline-flex items-center rounded-md border border-border bg-neutral-50 text-11 font-medium text-inkMuted">⌘ K</kbd>
        ) : null}
      </label>

      {open && (q || hits.length) ? (
        <div
          className="gs-panel absolute left-0 right-0 top-14 z-40 bg-surface border border-border rounded-[14px] shadow-drawer overflow-hidden"
          role="listbox"
          data-testid="global-search-results"
        >
          {hits.length === 0 ? (
            <div className="px-4 py-4 text-13 text-inkMuted">{loading ? 'Searching…' : `No results for “${q}”.`}</div>
          ) : (
            <div className="max-h-[62vh] overflow-y-auto p-2">
              {groups.map(([group, rows]) => (
                <div key={group}>
                  <div className="px-3 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-inkFaint">{group}</div>
                  {rows.map(({ hit, index }) => {
                    const Icon = hit.icon ?? Users;
                    const on = index === active;
                    return (
                      <button
                        key={`${hit.to}-${index}`}
                        type="button"
                        role="option"
                        aria-selected={on}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => go(hit)}
                        className={'flex items-center gap-3 w-full text-left px-3 py-2 rounded-[10px] transition-colors ' + (on ? 'bg-primary/10' : 'hover:bg-canvas')}
                      >
                        {hit.avatar ? <Avatar name={hit.avatar} size={28} square /> : (
                          <span className={'h-7 w-7 shrink-0 rounded-[8px] grid place-items-center ' + (on ? 'bg-primary text-white' : 'bg-neutral-100 text-inkMuted')}>
                            <Icon size={14} strokeWidth={2} />
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block text-13 font-medium text-ink truncate">{hit.label}</span>
                          {hit.hint ? <span className="block text-12 text-inkMuted truncate">{hit.hint}</span> : null}
                        </span>
                        {on ? <span className="shrink-0 text-11 text-inkFaint">↵</span> : null}
                      </button>
                    );
                  })}
                </div>
              ))}
              {loading ? <div className="px-3 py-2 text-12 text-inkFaint">Searching…</div> : null}
            </div>
          )}
          <div className="px-4 py-2 border-t border-border bg-neutral-50 text-11 text-inkFaint flex gap-4">
            <span><kbd className="gs-kbd">↑</kbd><kbd className="gs-kbd">↓</kbd> move</span>
            <span><kbd className="gs-kbd">↵</kbd> open</span>
            <span><kbd className="gs-kbd">esc</kbd> close</span>
          </div>
        </div>
      ) : null}
    </div>
  );
});
