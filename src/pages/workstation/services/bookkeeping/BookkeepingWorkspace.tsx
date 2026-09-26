import { NavLink, Outlet, useParams, Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, LayoutDashboard, FolderTree, FileText, Boxes, Landmark, Receipt,
  ClipboardList, Settings, ShieldCheck, Users, Wrench, TrendingUp, ShoppingCart, Search,
} from 'lucide-react';
import { tallyApi, tallyAccountingApi } from '@/modules/tools/audit-automation/tally';
import { PeriodProvider, PeriodBar } from '@/modules/tools/tally/ui';
import type { LucideIcon } from 'lucide-react';

/**
 * Bookkeeping company workspace — the shell every company screen lives in.
 *
 * It owns the two things every child needs: which company, and which
 * period. The period lives in the URL (?fy=&from=&to=) so a report a
 * user sends to a colleague opens on the same dates.
 */
export function BookkeepingWorkspace() {
  const { companyId = '' } = useParams();
  const companyQ = useQuery({
    queryKey: ['tally.company', companyId],
    enabled: Boolean(companyId),
    queryFn: () => tallyApi.getCompany(companyId),
  });
  const fyQ = useQuery({
    queryKey: ['tally.fys', companyId],
    enabled: Boolean(companyId),
    queryFn: () => tallyApi.listFinancialYears(companyId),
  });

  if (fyQ.isLoading) {
    return <div className="max-w-[1600px] mx-auto text-13 text-neutral-500 p-6">Loading company…</div>;
  }

  return (
    <PeriodProvider financialYears={fyQ.data?.items ?? []}>
      <div className="max-w-[1600px] mx-auto" data-testid="tally-workspace">
        <div className="mb-3 flex items-center gap-3">
          <Link to="/workstation/services/bookkeeping/companies" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900">
            <ArrowLeft size={14} strokeWidth={1.75} /> Companies
          </Link>
        </div>

        <header className="mb-4 flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-baseline gap-3 min-w-0">
            <h1 className="text-20 font-semibold text-neutral-900 truncate">{companyQ.data?.name ?? 'Company'}</h1>
            {companyQ.data?.gstin ? <span className="text-11 text-neutral-500 font-mono">{companyQ.data.gstin}</span> : null}
            {companyQ.data && !companyQ.data.active ? (
              <span className="text-10 px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-500 uppercase">Inactive</span>
            ) : null}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <CompanySearch companyId={companyId} />
            <PeriodBar />
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-[210px_1fr] gap-4">
          <SecondaryNav companyId={companyId} />
          <main className="min-w-0">
            <Outlet />
          </main>
        </div>
      </div>
    </PeriodProvider>
  );
}

function CompanySearch({ companyId }: { companyId: string }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const hitsQ = useQuery({
    queryKey: ['tally.search', companyId, q],
    enabled: q.trim().length >= 2,
    queryFn: () => tallyAccountingApi.search(companyId, q.trim()),
  });

  return (
    <div className="relative">
      <label className="relative block">
        <span className="absolute inset-y-0 left-2 flex items-center text-neutral-400"><Search size={14} strokeWidth={1.75} /></span>
        <input
          type="search"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          placeholder="Search ledgers, vouchers, items…"
          className="h-8 w-[260px] pl-7 pr-3 text-12 bg-white border border-neutral-300 rounded focus:outline-none focus:border-gold"
          data-testid="tally-search"
        />
      </label>
      {open && q.trim().length >= 2 ? (
        <div className="absolute right-0 top-9 z-40 w-[340px] max-h-[320px] overflow-y-auto bg-white border border-neutral-200 rounded shadow-lg">
          {hitsQ.isLoading ? (
            <div className="px-3 py-3 text-12 text-neutral-500">Searching…</div>
          ) : (hitsQ.data?.hits.length ?? 0) === 0 ? (
            <div className="px-3 py-3 text-12 text-neutral-500">No matches.</div>
          ) : (
            hitsQ.data!.hits.map((h) => (
              <button
                key={`${h.type}-${h.id}`}
                type="button"
                onMouseDown={() => { navigate(h.route); setQ(''); setOpen(false); }}
                className="w-full text-left px-3 py-2 hover:bg-neutral-50 border-b border-neutral-100 last:border-0"
              >
                <div className="text-13 text-neutral-900 truncate">{h.label}</div>
                <div className="text-11 text-neutral-500 truncate">{h.type.replace(/_/g, ' ')}{h.sublabel ? ` · ${h.sublabel}` : ''}</div>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

interface NavRow { to: string; label: string; icon: LucideIcon; end?: boolean }

function SecondaryNav({ companyId }: { companyId: string }) {
  const base = `/tally/companies/${companyId}`;
  const sections: { heading: string; rows: NavRow[] }[] = [
    {
      heading: 'Overview',
      rows: [{ to: base, label: 'Dashboard', icon: LayoutDashboard, end: true }],
    },
    {
      heading: 'Masters',
      rows: [
        { to: `${base}/masters/groups`, label: 'Groups', icon: FolderTree },
        { to: `${base}/masters/ledgers`, label: 'Ledgers', icon: ClipboardList },
        { to: `${base}/inventory`, label: 'Inventory', icon: Boxes },
      ],
    },
    {
      heading: 'Transactions',
      rows: [
        { to: `${base}/vouchers`, label: 'Vouchers', icon: FileText },
        { to: `${base}/sales`, label: 'Sales', icon: TrendingUp },
        { to: `${base}/purchase`, label: 'Purchase', icon: ShoppingCart },
        { to: `${base}/banking`, label: 'Banking', icon: Landmark },
        { to: `${base}/payroll`, label: 'Payroll', icon: Users },
      ],
    },
    {
      heading: 'Statements',
      rows: [
        { to: `${base}/reports`, label: 'Reports', icon: Receipt },
        { to: `${base}/gst`, label: 'GST & Tax', icon: Receipt },
        { to: `${base}/audit`, label: 'Audit trail', icon: ShieldCheck },
      ],
    },
    {
      heading: 'Administration',
      rows: [
        { to: `${base}/utilities`, label: 'Import / Backup', icon: Wrench },
        { to: `${base}/settings`, label: 'Settings', icon: Settings },
      ],
    },
  ];

  return (
    <nav className="bg-white border border-neutral-200 rounded p-2 h-fit md:sticky md:top-4 print:hidden">
      {sections.map((s) => (
        <div key={s.heading} className="mb-2 last:mb-0">
          <div className="text-10 uppercase tracking-[0.08em] text-neutral-400 px-2 py-1">{s.heading}</div>
          <ul className="space-y-0.5">
            {s.rows.map((r) => (
              <li key={r.to}>
                <NavLink
                  to={r.to}
                  end={r.end}
                  className={({ isActive }) =>
                    'flex items-center gap-2 h-8 px-2 rounded text-13 transition-colors ' +
                    (isActive ? 'bg-neutral-100 text-neutral-900 font-medium' : 'text-neutral-700 hover:bg-neutral-50')
                  }
                >
                  <r.icon size={14} strokeWidth={1.75} />
                  <span className="flex-1">{r.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
