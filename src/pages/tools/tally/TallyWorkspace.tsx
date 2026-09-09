import { NavLink, Outlet, useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, LayoutDashboard, FolderTree, FileText, Boxes, Landmark, Receipt, ClipboardList, Settings } from 'lucide-react';
import { tallyApi } from '@/modules/tools/audit-automation/tally';
import type { LucideIcon } from 'lucide-react';

/**
 * Tally company workspace — secondary left nav for a single company.
 * Wraps every /tally/companies/:companyId/* route.
 *
 * Slice 1 lights up: Masters → Groups and Masters → Ledgers.
 * Other nav rows show a "coming next" pill and link to a placeholder.
 */
export function TallyWorkspace() {
  const { companyId = '' } = useParams();
  const companyQ = useQuery({
    queryKey: ['tally.company', companyId],
    enabled: Boolean(companyId),
    queryFn: () => tallyApi.getCompany(companyId),
  });

  return (
    <div className="max-w-[1600px] mx-auto" data-testid="tally-workspace">
      <div className="mb-4 flex items-center gap-3">
        <Link to="/tally/companies" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900">
          <ArrowLeft size={14} strokeWidth={1.75} /> Companies
        </Link>
      </div>

      <header className="mb-4 flex items-baseline gap-3">
        <h1 className="text-20 font-semibold text-neutral-900 truncate">
          {companyQ.data?.name ?? 'Company'}
        </h1>
        <span className="text-11 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-medium">Preview</span>
        {companyQ.data?.gstin ? (
          <span className="text-11 text-neutral-500 font-mono">{companyQ.data.gstin}</span>
        ) : null}
      </header>

      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4">
        <SecondaryNav companyId={companyId} />
        <main className="min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

interface NavRow {
  to: string;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  comingSoon?: boolean;
  end?: boolean;
}

function SecondaryNav({ companyId }: { companyId: string }) {
  const base = `/tally/companies/${companyId}`;
  const rows: NavRow[] = [
    { to: `${base}`, label: 'Dashboard', icon: LayoutDashboard, comingSoon: true, end: true },
    { to: `${base}/masters/groups`, label: 'Groups', icon: FolderTree },
    { to: `${base}/masters/ledgers`, label: 'Ledgers', icon: ClipboardList },
    { to: `${base}/vouchers`, label: 'Vouchers', icon: FileText, comingSoon: true },
    { to: `${base}/inventory`, label: 'Inventory', icon: Boxes, comingSoon: true },
    { to: `${base}/banking`, label: 'Banking', icon: Landmark, comingSoon: true },
    { to: `${base}/reports`, label: 'Reports', icon: Receipt, comingSoon: true },
    { to: `${base}/settings`, label: 'Settings', icon: Settings, comingSoon: true },
  ];
  return (
    <nav className="bg-white border border-neutral-200 rounded p-2 h-fit sticky top-4">
      <ul className="space-y-0.5">
        {rows.map((r) => (
          <li key={r.to}>
            <NavLink
              to={r.to}
              end={r.end}
              onClick={(e) => { if (r.comingSoon) e.preventDefault(); }}
              className={({ isActive }) => {
                const base = 'flex items-center gap-2 h-9 px-2 rounded text-13 transition-colors ';
                if (r.comingSoon) return base + 'text-neutral-400 cursor-not-allowed';
                return base + (isActive
                  ? 'bg-neutral-100 text-neutral-900 font-medium'
                  : 'text-neutral-700 hover:bg-neutral-50');
              }}
            >
              <r.icon size={14} strokeWidth={1.75} />
              <span className="flex-1">{r.label}</span>
              {r.comingSoon ? <span className="text-10 text-neutral-400">soon</span> : null}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
