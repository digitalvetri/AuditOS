/**
 * Client portal extras: the documents the firm is waiting for (with an
 * upload button on each), and a read-only job status — active services,
 * compliance due in the next 60 days and audit files. Styled with the
 * portal's own `xp-` stylesheet (PORTAL_EXTRAS_CSS is appended to it).
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Briefcase, CalendarClock, CheckCircle2, ClipboardCheck, Loader2, Upload } from 'lucide-react';
import { api, type ApiError } from '@/services/api';
import { fmtDate } from '@/lib/format';

interface PortalRequest {
  id: string;
  name: string;
  category: string;
  financial_year: string | null;
  status: 'requested' | 'rejected' | 'replacement_required';
  reason: string | null;
  requested_at: string | null;
}
interface PortalRequests { items: PortalRequest[]; max_mb: number; accepted: string[] }
interface PortalStatus {
  services: { id: string; name: string; status: string; due_date: string | null }[];
  compliance: { id: string; form: string; period: string; due_date: string; status: string; overdue: boolean; days_left: number | null }[];
  audits: { id: string; code: string; title: string; financial_year: string; status: string; planned_report_date: string | null; report_date: string | null }[];
  window_days: number;
}

const base = (token: string) => `/api/client-portal/${encodeURIComponent(token)}`;
const LIVE_REFRESH_MS = 30_000;
const human = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const day = (iso: string | null) => (iso ? fmtDate(`${iso}T00:00:00+05:30`) : '—');

function statusTone(s: string): 'ok' | 'warn' | 'bad' | 'info' | 'mute' {
  if (['completed', 'ready', 'submitted', 'signed', 'filed'].includes(s)) return 'ok';
  if (['in_progress', 'under_review', 'fieldwork', 'review', 'reporting', 'documents_pending'].includes(s)) return 'warn';
  if (['failed', 'rejected', 'replacement_required'].includes(s)) return 'bad';
  if (['planning', 'requested'].includes(s)) return 'info';
  return 'mute';
}
const Pill = ({ status, label }: { status: string; label?: string }) => (
  <span className={`xp-pill t-${statusTone(status)}`}><i />{label ?? human(status)}</span>
);

/** The documents the firm has asked for, each with its own upload button. */
export function PortalRequestsSection({ token, onUploaded, onMessage }: { token: string; onUploaded: () => void; onMessage: (m: string) => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['client-portal', token, 'requests'],
    queryFn: () => api.get<PortalRequests>(`${base(token)}/requests`),
    refetchInterval: LIVE_REFRESH_MS,
    retry: false,
  });
  const [done, setDone] = useState<string[]>([]);
  const up = useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => {
      const form = new FormData();
      form.append('file', file);
      return api.postForm<{ id: string; version: number }>(`${base(token)}/requests/${id}/upload`, form);
    },
    onSuccess: (_r, v) => {
      setDone((d) => [...d, v.id]);
      void qc.invalidateQueries({ queryKey: ['client-portal', token, 'requests'] });
      onUploaded();
    },
    onError: (e) => onMessage((e as ApiError).message || 'Upload failed. Try again.'),
  });

  const items = q.data?.items ?? [];
  if (!items.length && !done.length) return null;
  return (
    <section className="xp-card xp-req">
      <div className="xp-req-head">
        <Upload size={15} strokeWidth={2} />
        <h2>{items.length ? `${items.length} document${items.length === 1 ? '' : 's'} needed from you` : 'Thank you — all requested documents received'}</h2>
        {items.length ? <span className="xp-dim">Upload each one here. {q.data ? `Up to ${q.data.max_mb} MB · ${q.data.accepted.map((a) => a.toUpperCase()).join(', ')}` : ''}</span> : null}
      </div>
      {items.length ? (
        <ul className="xp-req-list">
          {items.map((r) => (
            <RequestRow key={r.id} r={r} accept={(q.data?.accepted ?? []).map((a) => `.${a}`).join(',')}
              busy={up.isPending && up.variables?.id === r.id} disabled={up.isPending}
              onFile={(file) => up.mutate({ id: r.id, file })} />
          ))}
        </ul>
      ) : null}
      {done.length ? (
        <div className="xp-req-done"><CheckCircle2 size={14} /> {done.length} file{done.length === 1 ? '' : 's'} sent to your accountant for review.</div>
      ) : null}
    </section>
  );
}

function RequestRow({ r, accept, busy, disabled, onFile }: { r: PortalRequest; accept: string; busy: boolean; disabled: boolean; onFile: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <li className="xp-req-row">
      <div className="xp-req-main">
        <div className="xp-req-name">{r.name}</div>
        <div className="xp-req-sub">
          {r.category}{r.financial_year ? ` · FY ${r.financial_year}` : ''}
          {r.status !== 'requested' ? <> · <Pill status={r.status} label={r.status === 'rejected' ? 'Sent back' : 'Replacement needed'} /></> : null}
        </div>
        {r.reason ? <div className="xp-req-reason">{r.reason}</div> : null}
      </div>
      <input ref={input} type="file" accept={accept} hidden
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} />
      <button type="button" className="xp-btn is-solid" disabled={disabled} onClick={() => input.current?.click()}
        aria-label={`Upload ${r.name}`}>
        {busy ? <Loader2 size={14} className="xp-spin" /> : <Upload size={14} />}
        {busy ? 'Uploading…' : 'Upload'}
      </button>
    </li>
  );
}

/** Read-only: where the client's work stands. */
export function PortalJobStatusSection({ token }: { token: string }) {
  const q = useQuery({
    queryKey: ['client-portal', token, 'status'],
    queryFn: () => api.get<PortalStatus>(`${base(token)}/status`),
    refetchInterval: LIVE_REFRESH_MS,
    retry: false,
  });
  const d = q.data;
  if (!d || (!d.services.length && !d.compliance.length && !d.audits.length)) return null;
  return (
    <section className="xp-jobs">
      {d.services.length ? (
        <div className="xp-card xp-job">
          <div className="xp-job-head"><Briefcase size={14} /><h2>Work in progress</h2></div>
          <ul>
            {d.services.map((s) => (
              <li key={s.id}>
                <span className="xp-job-name">{s.name}</span>
                <span className="xp-job-meta">{s.due_date ? `Due ${day(s.due_date)}` : ''}<Pill status={s.status} /></span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {d.compliance.length ? (
        <div className="xp-card xp-job">
          <div className="xp-job-head"><CalendarClock size={14} /><h2>Due in the next {d.window_days} days</h2></div>
          <ul>
            {d.compliance.map((c) => (
              <li key={c.id}>
                <span className="xp-job-name">{c.form}<span className="xp-dim"> · {c.period}</span></span>
                <span className="xp-job-meta">
                  {day(c.due_date)}
                  {c.overdue ? <Pill status="failed" label="Overdue" /> : <Pill status={c.status} />}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {d.audits.length ? (
        <div className="xp-card xp-job">
          <div className="xp-job-head"><ClipboardCheck size={14} /><h2>Audits</h2></div>
          <ul>
            {d.audits.map((a) => (
              <li key={a.id}>
                <span className="xp-job-name">{a.title}<span className="xp-dim"> · FY {a.financial_year}</span></span>
                <span className="xp-job-meta">
                  {a.report_date ? `Signed ${day(a.report_date)}` : a.planned_report_date ? `Report by ${day(a.planned_report_date)}` : ''}
                  <Pill status={a.status} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export const PORTAL_EXTRAS_CSS = `
.xp-req{padding:14px 16px;margin-bottom:16px;border-color:#fde68a;background:linear-gradient(90deg,#fffbeb,#fff)}
.xp-req-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--warn)}
.xp-req-head h2{font-size:13.5px;color:var(--ink)}
.xp-req-head .xp-dim{font-size:12px}
.xp-req-list{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
.xp-req-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}
.xp-req-main{flex:1;min-width:0}
.xp-req-name{font-weight:600;overflow:hidden;text-overflow:ellipsis}
.xp-req-sub{display:flex;align-items:center;gap:4px;flex-wrap:wrap;color:var(--mute);font-size:12px;margin-top:2px}
.xp-req-reason{margin-top:4px;font-size:12px;color:var(--bad)}
.xp-req-done{display:flex;align-items:center;gap:6px;margin-top:10px;color:var(--ok);font-size:12.5px}
.xp-jobs{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-bottom:16px}
.xp-job{padding:12px 14px}
.xp-job-head{display:flex;align-items:center;gap:7px;color:var(--mute);margin-bottom:6px}
.xp-job-head h2{font-size:13px;color:var(--ink)}
.xp-job ul{list-style:none;margin:0;padding:0}
.xp-job li{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid var(--line-2)}
.xp-job li:first-child{border-top:0}
.xp-job-name{min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.xp-job-meta{display:inline-flex;align-items:center;gap:8px;flex-shrink:0;color:var(--mute);font-size:12px;white-space:nowrap}
@media (max-width:760px){
  .xp-req-row{flex-direction:column;align-items:stretch}
  .xp-req-row .xp-btn{width:100%}
  .xp-job li{flex-direction:column;align-items:flex-start}
}
`;
