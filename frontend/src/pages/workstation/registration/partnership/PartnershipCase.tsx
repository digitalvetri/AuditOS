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
import { PortalStrip } from './PortalStrip';
import { useState } from 'react';
import { CaseCompliancePanel, REG_NO_LABEL } from '@/modules/postRegistration/ui';
import { postRegistrationKeys } from '@/modules/postRegistration/api';
import { isCin, isLlpin, normId } from '@/lib/ids';

/** Registrations with post-registration compliance (INC-20A / ADTC, LLP Form 3). */
const hasCompliance = (k: string): k is 'PRIVATE_LIMITED' | 'LLP' => k === 'PRIVATE_LIMITED' || k === 'LLP';

const TAB_KEYS = ['checklist', 'documents', 'details', 'compliance', 'activity'] as const;
type TabKey = (typeof TAB_KEYS)[number];

/**
 * Case screen shared by all six services: Partnership / LLP / GST
 * Registration and the three GST returns. The third tab's label comes
 * from the service (Registration Details vs Return Details) — same slot,
 * different data — per GST-RETURNS-CASE-SCREEN §2.
 */
export function PartnershipCase() {
  const { api: regApi, keys: regKeys, base, label, detailsLabel, kind } = useSvc();
  const { caseId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const saveRegNo = useCaseMutation((v: { registration_number: string | null }) => regApi.updateCase(caseId, v), 'Saved');
  const tab = (params.get('tab') ?? 'checklist') as TabKey;
  const tabs: { key: TabKey; label: string }[] = [
    { key: 'checklist', label: 'Checklist' },
    { key: 'documents', label: 'Documents' },
    { key: 'details', label: detailsLabel },
    // Private Limited only: INC-20A / ADTC once the registration is completed.
    ...(hasCompliance(kind) ? [{ key: 'compliance' as const, label: 'Post-Registration Compliance' }] : []),
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
            {tab === 'compliance' && hasCompliance(kind) && (
              <CaseCompliancePanel
                caseId={c.id}
                canEdit={c.permissions.manage}
                info={{
                  kind,
                  name: c.client.name,
                  status: c.status,
                  statusLabel: CASE_STATUS_OPTIONS.find((o) => o.value === c.status)?.label ?? c.status,
                  registrationNumber: c.registration_number ?? null,
                  onSaveRegistrationNumber: (v) => saveRegNo.mutateAsync({ registration_number: v }),
                }}
              />
            )}
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
      // Completing a registration can create post-registration compliance rows.
      void qc.invalidateQueries({ queryKey: postRegistrationKeys.all });
      if (success) toast.push('success', success);
    },
    onError: (e: ApiError) => toast.push('error', e.message),
  });
}

function CaseHeader({ c }: { c: CaseDetail }) {
  const { api: regApi, stageOptions, label, kind } = useSvc();
  const update = useCaseMutation((v: Record<string, unknown>) => regApi.updateCase(c.id, v), 'Saved');
  // Private Limited: completing the registration asks for the Date of
  // Incorporation — INC-20A falls due 180 days after it.
  const [completing, setCompleting] = useState(false);
  const [incDate, setIncDate] = useState('');
  const [regNo, setRegNo] = useState(c.registration_number ?? '');
  const [regNoError, setRegNoError] = useState<string | null>(null);
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
          <select
            className={sel} disabled={!canEdit} value={completing ? 'COMPLETED' : c.status}
            onChange={(e) => {
              if (hasCompliance(kind) && e.target.value === 'COMPLETED' && c.status !== 'COMPLETED') { setCompleting(true); return; }
              setCompleting(false);
              update.mutate({ status: e.target.value });
            }}
          >
            {CASE_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Stage</span>
          <select className={sel} disabled={!canEdit} value={c.stage}
            onChange={(e) => {
              // Private Limited: reaching the Completed stage is completing the
              // registration — ask for the Date of Incorporation, same as Status.
              if (hasCompliance(kind) && e.target.value === 'COMPLETED' && c.status !== 'COMPLETED') { setCompleting(true); return; }
              update.mutate({ stage: e.target.value });
            }}
          >
            {stageOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      </div>
      {completing ? (
        <form
          className="px-4 py-3 flex flex-wrap items-end gap-3 border-b border-neutral-200 bg-neutral-50"
          onSubmit={(e) => {
            e.preventDefault();
            const reg = normId(regNo);
            if (reg && hasCompliance(kind)) {
              const bad = kind === 'LLP' ? !isLlpin(reg) : !isCin(reg);
              if (bad) {
                setRegNoError(kind === 'LLP' ? 'An LLPIN is 3 letters, a hyphen and 4 digits — e.g. AAB-1234.' : 'A CIN is 21 characters — e.g. U74999TN2020PTC123456.');
                return;
              }
            }
            setRegNoError(null);
            update.mutate(
              { status: 'COMPLETED', ...(incDate ? { incorporation_date: incDate } : {}), ...(reg ? { registration_number: reg } : {}) },
              { onSuccess: () => setCompleting(false) },
            );
          }}
        >
          <div className="text-13 text-neutral-700 basis-full">
            Registration completed — enter the <b>Date of Incorporation</b> so{' '}
            {kind === 'LLP' ? 'LLP Form 3 – Initial LLP Agreement (due 30 days after it) is' : 'INC-20A (due 180 days after it) and ADTC are'} tracked under Post-Registration Compliance.
          </div>
          <label className="block">
            <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Date of Incorporation</span>
            <input type="date" className={sel} value={incDate} max={new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)} onChange={(e) => setIncDate(e.target.value)} />
          </label>
          {hasCompliance(kind) ? (
            <label className="block">
              <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">{REG_NO_LABEL[kind]} (optional)</span>
              <input className={sel + ' uppercase'} value={regNo} maxLength={40} onChange={(e) => { setRegNo(e.target.value); setRegNoError(null); }} aria-invalid={!!regNoError} />
              {regNoError ? <span className="block text-12 text-red mt-1">{regNoError}</span> : null}
            </label>
          ) : null}
          <button type="submit" className="h-8 px-3 text-13 rounded border border-neutral-900 bg-neutral-900 text-white" disabled={update.isPending}>
            {incDate ? 'Complete registration' : 'Complete without the date'}
          </button>
          <button type="button" className="h-8 px-3 text-13 rounded border border-neutral-300 bg-white" onClick={() => { setCompleting(false); setIncDate(''); }}>Cancel</button>
        </form>
      ) : null}

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
      {/* §5.4 Portal Access strip — user + OTP contact + password reveal.
          Renders on any case whose client has a GST profile: return kinds
          use it every filing, GST Registration uses it for portal look-ups
          during REG-01. The component itself hides when there's no record
          or the caller lacks permission. */}
      {c.client.gst_profile_id ? <PortalStrip gstProfileId={c.client.gst_profile_id} /> : null}
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
