import { Link } from 'react-router-dom';
import { Landmark, Info } from 'lucide-react';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';

/**
 * /audit-automation — the submodule landing.
 *
 * Per REPOTIC-MODULE.md §0, Repotic is EXACTLY two tools: the bank
 * statement → Tally pipeline (shipped) and the ecommerce seller's
 * GSTR-1 pipeline (built across the Phase 1+ PRs). The TDS tab was
 * removed per spec; 26AS vs books reconciliation is /workstation/tds-recon.
 */
export function AuditAutomationLandingPage() {
  const { session } = useAuth();
  const role = session?.role.code;
  const permitted = can(role, 'tools.audit_automation.access', 'self');

  return (
    <div className="max-w-[1400px] mx-auto" data-testid="aa-landing">
      <header className="mb-5">
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] text-neutral-900">Repotic</h1>
        <p className="text-13 text-neutral-500 mt-1">
          Files in, files out. Bank statements → Tally, ecommerce reports → GSTR-1.
        </p>
      </header>

      {!permitted ? (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500">
          You do not have access to Audit Automation.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <PipelineCard
            to="/audit-automation/bank"
            title="PDF bank statement → Tally XML / CSV"
            description="PDF, Excel or CSV statement → rows checked against the running balance → review, ledgers and rules → approve → Tally XML"
            status="active"
          />
          <PipelineCard
            to="/audit-automation/ecommerce"
            title="File ecommerce seller's GSTR-1"
            description="Amazon · Flipkart · Meesho · Myntra · … → one normalised set of rows → GSTR-1 tables → JSON for the portal, Tally XML or CSV"
            status="active"
          />
          <PipelineCard
            to="/workstation/tds-recon"
            title="26AS vs books reconciliation"
            description="Form 26AS + TDS receivable from the books → matched by TAN and section, then amount → matched, only in 26AS, only in books, differences → Excel"
            status="active"
          />
        </div>
      )}

      <div className="mt-6 flex items-start gap-2 text-12 text-neutral-500 bg-white border border-neutral-200 rounded p-3">
        <Info size={14} strokeWidth={1.75} className="mt-0.5 flex-shrink-0" />
        <div>
          GST reconciliation (GSTR-2B vs Purchase Register) lives in the GST module.
          26AS vs books reconciliation lives under <Link to="/workstation/tds-recon" className="text-primary underline">Workstation → 26AS reconciliation</Link>.
          Repotic itself is file-in / file-out only.
        </div>
      </div>
    </div>
  );
}

function PipelineCard({
  to,
  title,
  description,
  status,
}: {
  to: string;
  title: string;
  description: string;
  status: 'active' | 'coming_soon';
}) {
  const active = status === 'active';
  const inner = (
    <article
      className={
        'bg-white border rounded p-4 flex gap-3 min-h-[112px] ' +
        (active
          ? 'dash-card card-zoom border-neutral-200 cursor-pointer'
          : 'border-neutral-200 opacity-70')
      }
      data-testid={`aa-pipeline-${title.toLowerCase().replace(/\s+/g, '-')}`}
    >
      <div className="w-9 h-9 rounded flex items-center justify-center bg-amber-50 text-amber-700 flex-shrink-0">
        <Landmark size={16} strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex-1 flex flex-col">
        <h3 className="text-14 font-semibold text-neutral-900 leading-5">{title}</h3>
        <p className="text-13 text-neutral-500 mt-0.5">{description}</p>
        <div className="mt-auto pt-3">
          <span className={'text-12 font-medium ' + (active ? 'text-gold' : 'text-neutral-400')}>
            {active ? 'Open →' : 'Coming soon'}
          </span>
        </div>
      </div>
    </article>
  );
  return active ? <Link to={to}>{inner}</Link> : inner;
}
