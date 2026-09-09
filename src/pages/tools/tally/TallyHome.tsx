import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Landmark, Info } from 'lucide-react';
import { Button } from '@/components/Button';
import { tallyApi } from '@/modules/tools/audit-automation/tally';

/**
 * /tally — module home. If the org has no companies yet: show the
 * create-first-company CTA. Otherwise: pipeline picker (companies +
 * a placeholder "recent activity" panel).
 *
 * Preview status: this is a REVIEWABLE PREVIEW. Slice 1 delivers
 * companies + FY + groups + ledgers. Vouchers / inventory / reports
 * come in follow-on slices.
 */
export function TallyHome() {
  const companiesQ = useQuery({
    queryKey: ['tally.companies'],
    queryFn: () => tallyApi.listCompanies(),
  });

  return (
    <div className="max-w-[1200px] mx-auto" data-testid="tally-home">
      <header className="flex items-start justify-between gap-4 mb-5">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-20 font-semibold text-neutral-900">Tally</h1>
            <span className="text-11 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-medium">Preview</span>
          </div>
          <p className="text-13 text-neutral-500 mt-1">
            Native double-entry accounting — companies, ledgers, vouchers, inventory, GST/TDS, reports.
          </p>
        </div>
        <Link to="/tally/companies">
          <Button variant="secondary" size="sm">Manage companies</Button>
        </Link>
      </header>

      {companiesQ.isLoading ? (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500">Loading…</div>
      ) : (companiesQ.data?.items ?? []).length === 0 ? (
        <EmptyState />
      ) : (
        <CompanyGrid companies={companiesQ.data!.items} />
      )}

      <div className="mt-6 flex items-start gap-2 text-12 text-neutral-500 bg-white border border-neutral-200 rounded p-3">
        <Info size={14} strokeWidth={1.75} className="mt-0.5 flex-shrink-0" />
        <div>
          <strong>Preview — Slice 1 (Foundation).</strong> Companies, financial
          years, groups and ledgers are live. Vouchers, inventory, banking, GST
          and reports arrive in follow-on slices, each shipped as its own
          preview. Nothing merges to production without your approval.
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="bg-white border border-neutral-200 rounded p-8 text-center">
      <div className="w-10 h-10 rounded flex items-center justify-center bg-amber-50 text-amber-700 mx-auto mb-3">
        <Landmark size={18} strokeWidth={1.75} />
      </div>
      <div className="text-14 font-medium text-neutral-900">No companies yet</div>
      <p className="text-13 text-neutral-500 mt-1 mb-4 max-w-[420px] mx-auto">
        Every Tally session runs against one company at a time. Create your first
        company to get started — primary groups and the current financial year
        are set up automatically.
      </p>
      <Link to="/tally/companies">
        <Button variant="primary" size="sm">
          <Plus size={14} strokeWidth={1.75} className="mr-1" /> Create company
        </Button>
      </Link>
    </div>
  );
}

function CompanyGrid({ companies }: { companies: { id: string; name: string; state: string | null; gstin: string | null; books_begin_from: string }[] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {companies.map((c) => (
        <Link
          key={c.id}
          to={`/tally/companies/${c.id}/masters/ledgers`}
          className="bg-white border border-neutral-200 rounded p-4 hover:border-gold transition-colors"
          data-testid={`tally-company-card-${c.id}`}
        >
          <div className="text-14 font-semibold text-neutral-900 truncate">{c.name}</div>
          <div className="text-12 text-neutral-500 mt-0.5">
            {c.state ?? '—'}{c.gstin ? ` · ${c.gstin}` : ''}
          </div>
          <div className="text-11 text-neutral-400 mt-2">Books from {c.books_begin_from}</div>
          <div className="text-12 text-gold font-medium mt-3">Open →</div>
        </Link>
      ))}
    </div>
  );
}
