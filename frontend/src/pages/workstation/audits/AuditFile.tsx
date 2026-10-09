import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, Download, Lock } from 'lucide-react';
import { QueryState } from '@/modules/workstation/components';
import { StatusPills } from '@/modules/workstation/listUi';
import { useToast } from '@/components/Toast';
import { auditApi, downloadBinary } from '@/modules/audit/api';
import { AuditProvider, Chip, auditTypeLabel, errText, smallBtn, useAudit } from '@/modules/audit/components';
import type { AuditFile } from '@/modules/audit/types';
import { OverviewTab } from './tabs/Overview';
import { WorkingPapersTab } from './tabs/WorkingPapers';
import { ReviewNotesTab } from './tabs/ReviewNotes';
import { RisksTab } from './tabs/Risks';
import { ObservationsTab } from './tabs/Observations';
import { ChecklistsTab } from './tabs/Checklists';

/**
 * /workstation/audits/:id — one audit file. The tab lives in `?tab=` so a
 * link (from the dashboard, a notification) can open the right one.
 */

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'papers', label: 'Working papers' },
  { value: 'notes', label: 'Review notes' },
  { value: 'risks', label: 'Risks' },
  { value: 'observations', label: 'Observations' },
  { value: 'checklists', label: 'Checklists' },
];

export function AuditFilePage() {
  const { id = '' } = useParams();
  const file = useQuery({ queryKey: ['audits', 'file', id], queryFn: () => auditApi.get(id), enabled: Boolean(id) });
  return (
    <div className="max-w-[1400px]">
      <Link to="/workstation/audits" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900 mb-3">
        <ChevronLeft size={15} /> Audit files
      </Link>
      <QueryState query={file}>
        {(f) => <AuditProvider file={f}><FileBody f={f} /></AuditProvider>}
      </QueryState>
    </div>
  );
}

function FileBody({ f }: { f: AuditFile }) {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.value === params.get('tab')) ? params.get('tab')! : 'overview';
  const setTab = (t: string) => setParams((p) => { const n = new URLSearchParams(p); n.set('tab', t); n.delete('wp'); return n; }, { replace: true });
  const toast = useToast();
  const [exporting, setExporting] = useState(false);

  const doExport = async () => {
    setExporting(true);
    try {
      await downloadBinary(auditApi.exportUrl(f.id), `${f.audit_code}-peer-review-pack.zip`);
    } catch (e) {
      toast.push('error', errText(e));
    } finally {
      setExporting(false);
    }
  };

  const p = f.progress;
  const counts: Record<string, number | undefined> = {
    notes: p?.review_notes_open,
    observations: p?.observations_open,
    checklists: p?.checklist_pending,
  };

  return (
    <>
      <header className="flex items-start gap-4 flex-wrap mb-4">
        <div className="min-w-0">
          <div className="text-12 text-neutral-500 tracking-[0.02em]">{f.audit_code} · {auditTypeLabel(f.audit_type)} · FY {f.financial_year}</div>
          <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] text-neutral-900">{f.title}</h1>
          <div className="text-13 text-neutral-600 mt-1 flex items-center gap-2 flex-wrap">
            {f.client ? <Link to={`/workstation/clients/${f.client.id}`} className="hover:underline">{f.client.company_name}</Link> : '—'}
            <Chip value={f.status} />
            {f.locked || f.locked_at ? <Chip value="locked" text="Locked" /> : null}
          </div>
        </div>
        <div className="flex-1" />
        <button type="button" className={smallBtn} onClick={() => void doExport()} disabled={exporting}
          title="Zip of the file summary, sign-offs, notes, checklists, UDINs and every working-paper file">
          <Download size={14} /> {exporting ? 'Preparing…' : 'Peer review pack'}
        </button>
      </header>

      <AddendumBar />

      <div className="mb-4">
        <StatusPills options={TABS} value={tab} onChange={setTab} counts={counts} />
      </div>

      {tab === 'overview' ? <OverviewTab /> : null}
      {tab === 'papers' ? <WorkingPapersTab /> : null}
      {tab === 'notes' ? <ReviewNotesTab /> : null}
      {tab === 'risks' ? <RisksTab /> : null}
      {tab === 'observations' ? <ObservationsTab /> : null}
      {tab === 'checklists' ? <ChecklistsTab /> : null}
    </>
  );
}

/**
 * After the lock nothing changes except an addendum (SA 230 para A24): the
 * signing partner or manager turns it on, says why, and every write then
 * carries `{ addendum: true, addendum_reason }`.
 */
function AddendumBar() {
  const a = useAudit();
  if (!a.locked) return null;
  return (
    <div className="dash-card px-4 py-3 mb-4 flex items-start gap-3 flex-wrap">
      <Lock size={16} className="text-neutral-500 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 text-13 text-neutral-700">
        <div className="font-semibold text-neutral-900">This file is locked</div>
        <div className="text-neutral-500">
          Assembled{a.file.locked_at ? ` on ${new Date(a.file.locked_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}.
          Everything is read-only. New working papers and evidence can still be added as an addendum, with the reason recorded (SA 230 para A24).
        </div>
        {a.isLead && a.addendum ? (
          <input value={a.reason} onChange={(e) => a.setReason(e.target.value)} autoFocus
            placeholder="Why this addendum is being made (required)"
            className="mt-2 block w-full h-9 px-3 text-13 bg-white text-neutral-900 border border-neutral-200 rounded-lg focus:outline-none focus:border-primary/60" />
        ) : null}
      </div>
      {a.isLead ? (
        <button type="button" role="switch" aria-checked={a.addendum} onClick={() => a.setAddendum(!a.addendum)}
          className={`h-8 px-3 inline-flex items-center gap-1 text-13 rounded-full border whitespace-nowrap ${a.addendum ? 'bg-[#f1edff] border-[#cbbdf2] text-primary font-medium' : 'bg-white border-neutral-200 text-neutral-700 hover:bg-neutral-50'}`}>
          {a.addendum ? 'Addendum on' : 'Add addendum'}
        </button>
      ) : null}
    </div>
  );
}
