/**
 * Global search (top bar). One box, four sources, grouped results:
 *
 *   Pages      the navigation the caller can see (Attendance, Payroll, …)
 *   Employees  GET /api/employees?q=      (server-scoped to the caller)
 *   Workstation GET /api/workstation/search (leads, clients, services)
 *   Tools      the Tools registry (name, description, keywords)
 *
 * Keyboard: ⌘K / Ctrl+K focuses the box, ↑↓ move, Enter opens, Esc closes.
 * The `focusRef` lets the top-bar icon button focus it too.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { employeeApi, isFullEmployee } from '@/modules/employees/api';
import { workstationApi } from '@/modules/workstation/api';
import { searchTools, TOOLS } from '@/modules/tools/registry';

export interface GlobalSearchHandle { focus: () => void }

interface Hit { group: string; label: string; hint?: string; to: string }

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
      { label: 'Payroll', to: '/hrms/payroll', visible: can(role, 'payroll.view.own', 'self') || can(role, 'payroll.view', 'organisation'), hint: 'HRMS' },
      { label: 'Expenses', to: '/hrms/expenses', visible: can(role, 'expense.submit', 'self') || can(role, 'expense.approve', 'department'), hint: 'HRMS' },
      { label: 'Accounts', to: '/hrms/accounts', visible: can(role, 'accounts.read', 'organisation') || can(role, 'accounts.manage', 'organisation'), hint: 'HRMS' },
      { label: 'Messages', to: '/hrms/messages', visible: can(role, 'chat.participate', 'organisation'), hint: 'HRMS' },
      { label: 'Documents', to: '/hrms/documents', visible: can(role, 'document.read', 'self'), hint: 'HRMS' },
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
    return all.filter((p) => p.visible && needle && p.label.toLowerCase().includes(needle)).slice(0, 5).map((p) => ({ group: 'Pages', label: p.label, hint: p.hint, to: p.to }));
  }, [q, role, session, canWorkstation, canTools]);

  const hits = useMemo<Hit[]>(() => {
    if (!q) return [];
    const out: Hit[] = [...pages];
    for (const e of (employees.data?.items ?? []).slice(0, 6)) {
      out.push({ group: 'Employees', label: e.full_name, hint: isFullEmployee(e) ? `${e.employee_code} · ${e.email}` : e.employee_code, to: `/hrms/employees/${e.id}` });
    }
    const ws = workstation.data;
    if (ws) {
      for (const l of ws.leads.slice(0, 4)) out.push({ group: 'Leads', label: l.name, hint: `${l.lead_id}${l.service_name ? ` · ${l.service_name}` : ''}`, to: `/workstation/leads/${l.id}` });
      for (const c of ws.clients.slice(0, 4)) out.push({ group: 'Clients', label: c.company_name, hint: c.client_id, to: `/workstation/clients/${c.id}` });
      for (const s of ws.services.slice(0, 3)) out.push({ group: 'Services', label: s.service_name ?? 'Service', hint: s.client_name ?? undefined, to: `/workstation/clients/${s.client_id}/services` });
    }
    if (canTools) {
      for (const t of searchTools(q, TOOLS).slice(0, 5)) out.push({ group: 'Tools', label: t.name, hint: t.description, to: t.route });
    }
    return out;
  }, [q, pages, employees.data, workstation.data, canTools]);

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
          placeholder="Search…"
          className="w-full h-12 pl-12 pr-5 text-15 bg-canvas text-ink placeholder:text-inkFaint border border-border rounded-full focus:outline-none focus:border-gold focus:bg-surface"
          aria-label="Global search"
          aria-expanded={open && Boolean(q)}
          autoComplete="off"
          data-testid="global-search"
        />
      </label>

      {open && q ? (
        <div
          className="absolute left-0 right-0 top-14 z-40 bg-surface border border-border rounded-md shadow-raised overflow-hidden"
          role="listbox"
          data-testid="global-search-results"
        >
          {hits.length === 0 ? (
            <div className="px-4 py-3 text-13 text-inkMuted">{loading ? 'Searching…' : `No results for “${q}”.`}</div>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto py-1">
              {groups.map(([group, rows]) => (
                <div key={group}>
                  <div className="px-4 pt-2 pb-1 text-11 uppercase tracking-[0.06em] text-inkFaint">{group}</div>
                  {rows.map(({ hit, index }) => (
                    <button
                      key={`${hit.to}-${index}`}
                      type="button"
                      role="option"
                      aria-selected={index === active}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => go(hit)}
                      className={'block w-full text-left px-4 py-2 ' + (index === active ? 'bg-canvas' : 'hover:bg-canvas')}
                    >
                      <div className="text-13 text-ink">{hit.label}</div>
                      {hit.hint ? <div className="text-12 text-inkMuted truncate">{hit.hint}</div> : null}
                    </button>
                  ))}
                </div>
              ))}
              {loading ? <div className="px-4 py-2 text-12 text-inkFaint">Searching…</div> : null}
            </div>
          )}
          <div className="px-4 py-1.5 border-t border-border text-11 text-inkFaint flex gap-3">
            <span>↑↓ move</span><span>↵ open</span><span>esc close</span>
          </div>
        </div>
      ) : null}
    </div>
  );
});
