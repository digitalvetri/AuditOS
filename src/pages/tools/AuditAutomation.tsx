import { Link } from 'react-router-dom';
import { Landmark, Info } from 'lucide-react';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';

/**
 * /audit-automation — the submodule landing.
 *
 * AMENDMENT-02-REPOTIC-GAPS.md is scoped to the bank-statement pipeline
 * for now (Phases 0–4 of the parent spec). Other pipelines — GSTR-2B
 * reconciliation, GSTR-3B, 26AS TDS matching — are deferred per §5 of
 * the amendment, but declared here for orientation.
 */
export function AuditAutomationLandingPage() {
  const { session } = useAuth();
  const role = session?.role.code;
  const permitted = can(role, 'tools.audit_automation.access', 'self');

  return (
    <div className="max-w-[1400px] mx-auto" data-testid="aa-landing">
      <header className="mb-5">
        <h1 className="text-20 font-semibold text-neutral-900">Repotic</h1>
        <p className="text-13 text-neutral-500 mt-1">
          Bank statements, GST filings and TDS — ingested, reconciled, exported.
        </p>
      </header>

      {!permitted ? (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500">
          You do not have access to Audit Automation.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <PipelineCard
            to="/audit-automation/bank"
            title="Bank statements"
            description="PDF statement → parsed rows → reviewed → Tally XML"
            status="active"
          />
          <PipelineCard
            to="/audit-automation/gst"
            title="GST reconciliation"
            description="GSTR-2B vs purchase register — matching and ITC classification"
            status="active"
          />
          <PipelineCard
            to="/audit-automation/tds"
            title="TDS reconciliation"
            description="Form 26AS vs client books — verified, variance and chase-deductor buckets"
            status="active"
          />
          <PipelineCard
            to="/audit-automation/tally"
            title="Tally (Preview)"
            description="Native double-entry accounting — companies, ledgers, vouchers, GST/TDS, reports"
            status="active"
          />
        </div>
      )}

      <div className="mt-6 flex items-start gap-2 text-12 text-neutral-500 bg-white border border-neutral-200 rounded p-3">
        <Info size={14} strokeWidth={1.75} className="mt-0.5 flex-shrink-0" />
        <div>
          Bank-statement pipeline follows the revised upload flow from
          AMENDMENT-02-REPOTIC-GAPS.md: user-selected bank, password-protected
          PDF support, scanned documents refused, per-client dedupe.
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
          ? 'border-neutral-200 hover:border-gold cursor-pointer transition-colors'
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
