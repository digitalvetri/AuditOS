import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { type CaseDetail } from '@/modules/partnership/api';
import { Card, QueryState } from '@/modules/workstation/components';
import { useToast } from '@/components/Toast';
import { fmtDate, fmtDateTime } from '@/lib/format';
import type { ApiError } from '@/services/api';
import { CASE_STATUS_OPTIONS, DueChip, EmployeeSelect, ProgressBar, useSvc } from './shared';
import { CaseChecklist } from './CaseChecklist';
import { CaseDocuments } from './CaseDocuments';
import { CaseDetails } from './CaseDetails';

const TAB_KEYS = ['checklist', 'documents', 'details', 'activity'] as const;
type TabKey = (typeof TAB_KEYS)[number];

/**
 * Case screen shared by all six services: Partnership / LLP / GST
 * Registration and the three GST returns. The third tab's label comes
 * from the service (Registration Details vs Return Details) — same slot,
 * different data — per GST-RETURNS-CASE-SCREEN §2.
 */
export function PartnershipCase() {
  const { api: regApi, keys: regKeys, base, label, detailsLabel } = useSvc();
  const { caseId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'checklist') as TabKey;
  const tabs: { key: TabKey; label: string }[] = [
    { key: 'checklist', label: 'Checklist' },
    { key: 'documents', label: 'Documents' },
    { key: 'details', label: detailsLabel },
    { key: 'activity', label: 'Activity' },
  ];
  const q = useQuery({ queryKey: regKeys.case(caseId), queryFn: () => regApi.getCase(caseId) });

  return (
    <>
      <Link to={`${base}/clients`} className="text-13 text-neutral-500 hover:text-neutral-900">← Back to {label} Clients</Link>
      <QueryState query={q}>
        {(c) => (
          <>
            <CaseHeader c={c} />
            <nav className="flex gap-1 border-b border-neutral-200 mb-4 overflow-x-auto">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => { const n = new URLSearchParams(params); n.set('tab', t.key); setParams(n, { replace: true }); }}
                  className={
                    'px-3 h-9 text-13 whitespace-nowrap border-b-2 -mb-px ' +
                    (tab === t.key ? 'border-gold text-neutral-900 font-medium' : 'border-transparent text-neutral-500 hover:text-neutral-900')
                  }
                >
                  {t.label}
                  {t.key === 'documents' ? <span className="ml-1 text-neutral-400 tabular-nums">{c.progress.docs_uploaded}/{c.progress.docs_required}</span> : null}
                </button>
              ))}
            </nav>
            {tab === 'checklist' && <CaseChecklist c={c} onOpenDocuments={() => setParams({ tab: 'documents' }, { replace: true })} onOpenDetails={() => setParams({ tab: 'details' }, { replace: true })} />}
            {tab === 'documents' && <CaseDocuments c={c} />}
            {tab === 'details' && <CaseDetails c={c} />}
            {tab === 'activity' && <CaseActivity caseId={c.id} />}
          </>
        )}
      </QueryState>
    </>
  );
}

export function useCaseMutation<T>(fn: (v: T) => Promise<unknown>, success?: string) {
  const { keys: regKeys } = useSvc();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: regKeys.all });
      if (success) toast.push('success', success);
    },
    onError: (e: ApiError) => toast.push('error', e.message),
  });
}

function CaseHeader({ c }: { c: CaseDetail }) {
  const { api: regApi, stageOptions, label } = useSvc();
  const update = useCaseMutation((v: Record<string, unknown>) => regApi.updateCase(c.id, v), 'Saved');
  const canEdit = c.permissions.manage;
  const sel = 'h-8 px-2 text-13 bg-white border border-neutral-300 rounded focus:outline-none focus:border-gold';
  const p = c.progress;

  return (
    <section className="mt-2 mb-4 bg-white border border-neutral-200 rounded">
      <div className="px-4 py-3 flex flex-wrap items-start gap-x-6 gap-y-3 border-b border-neutral-200">
        <div className="min-w-0">
          {/* Return cases lead with "GSTR-1 · SEPTEMBER 2026" per
              GST-RETURNS-CASE-SCREEN §7.3 mockup. Registrations show just
              the service label. */}
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">
            {label}{c.period ? ` · ${c.period}` : ''}
          </div>
          <h1 className="text-20 font-semibold text-neutral-900">{c.client.name}</h1>
          <div className="text-13 text-neutral-500">
            {c.case_code} · Created {fmtDate(c.created_at)} ·{' '}
            <Link className="underline" to={`/workstation/clients/${c.client.id}`}>Client profile</Link>
          </div>
        </div>
        <div className="flex-1" />
        <label className="block">
          <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Status</span>
          <select className={sel} disabled={!canEdit} value={c.status} onChange={(e) => update.mutate({ status: e.target.value })}>
            {CASE_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Stage</span>
          <select className={sel} disabled={!canEdit} value={c.stage} onChange={(e) => update.mutate({ stage: e.target.value })}>
            {stageOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      </div>

      <div className="px-4 py-3 grid grid-cols-2 md:grid-cols-6 gap-4">
        <div className="col-span-2">
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Progress</div>
          <ProgressBar pct={p.pct} className="w-full" />
          <div className="text-12 text-neutral-500 mt-1">
            Completed {p.items_done} / {p.items_total} · Remaining {p.items_pending} · Required items {p.items_required_done} / {p.items_required}
          </div>
        </div>
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Documents</div>
          <div className="text-13 tabular-nums">{p.docs_uploaded} / {p.docs_required} uploaded</div>
          <div className="text-12 text-neutral-500">{p.docs_verified} verified ({p.docs_pct}%)</div>
        </div>
        <Person label="Assigned to" value={c.assigned?.id ?? ''} disabled={!canEdit} onChange={(v) => update.mutate({ assigned_employee_id: v || null })} />
        <Person label="Reviewer" value={c.reviewer?.id ?? ''} disabled={!canEdit} onChange={(v) => update.mutate({ reviewer_employee_id: v || null })} />
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Due date</div>
          {canEdit ? (
            <input type="date" className={sel + ' w-full'} value={c.due_date ?? ''} onChange={(e) => update.mutate({ due_date: e.target.value || null })} />
          ) : null}
          <div className="mt-1"><DueChip date={c.due_date} state={c.due_state} /></div>
        </div>
      </div>
      {canEdit || c.approver ? (
        <div className="px-4 pb-3 text-12 text-neutral-500 flex items-center gap-2">
          Manager / Approver:
          {canEdit
            ? <EmployeeSelect value={c.approver?.id ?? ''} placeholder="None" onChange={(v) => update.mutate({ approver_employee_id: v || null })} />
            : <span className="text-neutral-900">{c.approver?.full_name}</span>}
        </div>
      ) : null}
    </section>
  );
}

function Person({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled: boolean }) {
  return (
    <div>
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">{label}</div>
      {disabled
        ? <EmployeeSelect value={value} onChange={() => undefined} className="w-full pointer-events-none opacity-80" />
        : <EmployeeSelect value={value} onChange={onChange} className="w-full" />}
    </div>
  );
}

function CaseActivity({ caseId }: { caseId: string }) {
  const { api: regApi, keys: regKeys } = useSvc();
  const q = useQuery({ queryKey: regKeys.activity(caseId), queryFn: () => regApi.activity(caseId) });
  return (
    <Card title="Activity">
      <QueryState query={q} empty="No activity yet.">
        {(d) => (
          <ol className="divide-y divide-neutral-200">
            {d.items.map((a) => (
              <li key={a.id} className="px-4 py-2 flex gap-4 text-13">
                <span className="w-[150px] shrink-0 text-neutral-500 tabular-nums">{fmtDateTime(a.created_at)}</span>
                <span className="flex-1 min-w-0 text-neutral-900">{a.detail}</span>
                <span className="w-[160px] shrink-0 text-neutral-500 text-right">{a.actor?.full_name ?? 'System'}</span>
              </li>
            ))}
          </ol>
        )}
      </QueryState>
    </Card>
  );
}
