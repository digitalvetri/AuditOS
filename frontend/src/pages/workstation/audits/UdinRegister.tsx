import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, FileDown, Plus } from 'lucide-react';
import { Field, Modal, QueryState, inputClass } from '@/modules/workstation/components';
import {
  DateRange, FilterSelect, ListAction, ListCard, ListEmpty, ListHeader, ListRow, ListTable, ListToolbar, Spacer, TD,
  TogglePill, TwoLine, fmtDay,
} from '@/modules/workstation/listUi';
import { workstationApi } from '@/modules/workstation/api';
import { clientNameWithOrg } from '@/modules/workstation/organization/badges';
import { downloadFile } from '@/modules/workstation/invoices/download';
import { auditApi, udinError } from '@/modules/audit/api';
import { Chip, auditTypeLabel, linkBtn, primaryBtn, smallBtn, useAuditMutation, useMe } from '@/modules/audit/components';
import type { AuditUdin, MissingUdin } from '@/modules/audit/types';

/**
 * /workstation/audits/udins — the firm's UDIN register (ICAI): one row per
 * attested document, with the signed audit files that still lack one.
 */

const DOC_TYPES = [
  { value: 'audit_report', label: 'Audit report' },
  { value: 'tax_audit_report', label: 'Tax audit report' },
  { value: 'caro', label: 'CARO report' },
  { value: 'certificate', label: 'Certificate' },
  { value: 'other', label: 'Other' },
];
const docLabel = (v: string) => DOC_TYPES.find((d) => d.value === v)?.label ?? v;
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export function UdinRegisterPage() {
  const me = useMe();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [clientId, setClientId] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [withRevoked, setWithRevoked] = useState(false);
  const [adding, setAdding] = useState<Partial<MissingUdin> | true | null>(null);
  const [revoking, setRevoking] = useState<AuditUdin | null>(null);

  const list = useQuery({
    queryKey: ['audits', 'udins', { from, to, clientId, partnerId, withRevoked }],
    queryFn: () => auditApi.udins({ from: from || undefined, to: to || undefined, client_id: clientId || undefined, partner_id: partnerId || undefined, include_revoked: withRevoked }),
  });
  const missing = useQuery({ queryKey: ['audits', 'udins', 'missing'], queryFn: auditApi.missingUdins });
  const clients = useQuery({ queryKey: ['audits.clients'], queryFn: () => workstationApi.listClients(), staleTime: 120_000 });
  const staff = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees, staleTime: 120_000 });

  const exportCsv = (rows: AuditUdin[]) => {
    const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ['UDIN', 'Document date', 'Document type', 'Description', 'Client', 'Audit file', 'Partner', 'Membership no', 'Generated on', 'Revoked on', 'Revoked reason'];
    const lines = rows.map((u) => [u.udin, u.document_date, docLabel(u.document_type), u.document_description, u.client_name, u.audit_code,
      u.partner_name, u.membership_no, u.generated_on, u.revoked_at?.slice(0, 10), u.revoked_reason].map(esc).join(','));
    const blob = new Blob([`﻿${[head.join(','), ...lines].join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    downloadFile(url, `udin-register-${istToday()}.csv`);
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  const rows = list.data ?? [];
  const miss = missing.data ?? [];

  return (
    <div className="max-w-[1400px]">
      <Link to="/workstation/audits" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900 mb-3">
        <ChevronLeft size={15} /> Audit files
      </Link>
      <ListHeader
        title="UDIN register"
        meta={list.data ? `${rows.length} UDIN${rows.length === 1 ? '' : 's'} · every attested document, firm-wide` : 'Loading…'}
        action={me.canManage ? <ListAction onClick={() => setAdding(true)} icon={<Plus size={15} />}>Record UDIN</ListAction> : null}
      />

      {miss.length > 0 ? (
        <section className="dash-card p-5 mb-5">
          <h2 className="text-15 font-semibold text-neutral-900 flex items-center gap-2 mb-1"><AlertTriangle size={16} className="text-warning" /> Signed files missing a UDIN</h2>
          <p className="text-12 text-neutral-500 mb-3">A UDIN should be generated for every report signed; record it against the file.</p>
          <ul className="divide-y divide-neutral-100">
            {miss.map((m) => (
              <li key={m.id} className="py-2 flex items-center gap-3 flex-wrap text-13">
                <Link to={`/workstation/audits/${m.id}`} className="font-semibold text-neutral-900 hover:underline">{m.audit_code}</Link>
                <span className="text-neutral-700 min-w-0 flex-1 truncate">{m.client?.company_name ?? '—'} · {auditTypeLabel(m.audit_type)} · FY {m.financial_year}</span>
                <span className="text-neutral-500 whitespace-nowrap">Signed {fmtDay(m.report_date)}{m.signing_partner_name ? ` · ${m.signing_partner_name}` : ''}</span>
                {me.canManage ? <button type="button" className={linkBtn} onClick={() => setAdding(m)}>Record UDIN</button> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ListToolbar>
        <DateRange from={from} to={to} onFrom={setFrom} onTo={setTo} />
        <FilterSelect label="Client" value={clientId} onChange={setClientId}
          options={(clients.data?.items ?? []).map((c) => ({ value: c.id, label: clientNameWithOrg(c) }))} />
        <FilterSelect label="Partner" value={partnerId} onChange={setPartnerId}
          options={(staff.data?.items ?? []).map((p) => ({ value: p.id, label: p.full_name }))} />
        <TogglePill on={withRevoked} onChange={setWithRevoked}>Include revoked</TogglePill>
        <Spacer />
        <button type="button" className={smallBtn} disabled={rows.length === 0} onClick={() => exportCsv(rows)}><FileDown size={14} /> Export CSV</button>
      </ListToolbar>

      <ListCard>
        <QueryState query={list}>
          {() => rows.length === 0 ? <ListEmpty>No UDINs in this range.</ListEmpty> : (
            <ListTable cols={['UDIN', 'Document', 'Date', 'Client', 'Partner', 'Generated', 'Status', { label: '', key: 'act' }]}>
              {rows.map((u) => (
                <ListRow key={u.id}>
                  <TD first strong nowrap className="font-mono tracking-[0.04em]">{u.udin}</TD>
                  <TD><TwoLine top={docLabel(u.document_type)} sub={[u.document_description, u.audit_code].filter(Boolean).join(' · ') || undefined} /></TD>
                  <TD muted nowrap>{fmtDay(u.document_date)}</TD>
                  <TD muted>{u.client_name ?? '—'}</TD>
                  <TD muted nowrap>{u.partner_name ?? '—'}{u.membership_no ? <div className="text-11 text-neutral-500">M.No. {u.membership_no}</div> : null}</TD>
                  <TD muted nowrap>{fmtDay(u.generated_on)}</TD>
                  <TD nowrap>{u.revoked_at ? <span title={u.revoked_reason ?? undefined}><Chip value="revoked" text="Revoked" /></span> : <Chip value="active" text="Active" />}</TD>
                  <TD last right>
                    {!u.revoked_at && me.canManage ? <button type="button" className={linkBtn} onClick={() => setRevoking(u)}>Revoke</button> : null}
                  </TD>
                </ListRow>
              ))}
            </ListTable>
          )}
        </QueryState>
      </ListCard>

      {adding ? <AddUdinModal preset={adding === true ? null : adding} onClose={() => setAdding(null)} /> : null}
      {revoking ? <RevokeModal u={revoking} onClose={() => setRevoking(null)} /> : null}
    </div>
  );
}

function AddUdinModal({ preset, onClose }: { preset: Partial<MissingUdin> | null; onClose: () => void }) {
  const clients = useQuery({ queryKey: ['audits.clients'], queryFn: () => workstationApi.listClients(), staleTime: 120_000 });
  const staff = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees, staleTime: 120_000 });
  const [clientId, setClientId] = useState(preset?.client_id ?? '');
  const [udin, setUdin] = useState('');
  const [docType, setDocType] = useState(preset?.audit_type === 'tax' ? 'tax_audit_report' : 'audit_report');
  const [desc, setDesc] = useState(preset?.audit_code ? `${auditTypeLabel(preset.audit_type ?? '')} FY ${preset.financial_year ?? ''}` : '');
  const [docDate, setDocDate] = useState(preset?.report_date ?? '');
  const [partnerId, setPartnerId] = useState(preset?.signing_partner_id ?? '');
  const [mno, setMno] = useState(preset?.partner_membership_no ?? '');
  const [generated, setGenerated] = useState(istToday());
  const [touched, setTouched] = useState(false);

  const uErr = useMemo(() => (udin || touched ? udinError(udin, mno) : null), [udin, mno, touched]);
  const mErr = mno && !/^\d{1,6}$/.test(mno) ? 'A membership number is up to 6 digits.' : undefined;
  const live = udin.length > 0 && udin.length < 18 ? `${udin.length} / 18` : undefined;

  const add = useAuditMutation(() => auditApi.addUdin({
    client_id: clientId, engagement_id: preset?.id ?? undefined, udin: udin.trim(), document_type: docType,
    document_description: desc.trim() || undefined, document_date: docDate, partner_id: partnerId || undefined,
    membership_no: mno.trim(), generated_on: generated,
  }), 'UDIN recorded.', onClose);

  const ok = clientId && !udinError(udin, mno) && !mErr && mno && docDate && generated;
  return (
    <Modal open title="Record UDIN" onClose={onClose} width="w-[600px]"
      footer={<>
        <button type="button" className={smallBtn} onClick={onClose}>Cancel</button>
        <button type="button" className={primaryBtn} disabled={!ok || add.isPending} onClick={() => { setTouched(true); add.mutate(); }}>Save</button>
      </>}>
      {preset?.audit_code ? <p className="text-13 text-neutral-600 mb-3">For audit file <strong>{preset.audit_code}</strong>.</p> : null}
      <Field label="Client">
        <select className={inputClass} value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={Boolean(preset?.client_id)}>
          <option value="">Select a client…</option>
          {(clients.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{clientNameWithOrg(c)}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
        <Field label="Partner">
          <select className={inputClass} value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
            <option value="">—</option>
            {(staff.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        </Field>
        <Field label="Membership no." error={mErr}>
          <input className={inputClass} inputMode="numeric" maxLength={6} value={mno} onChange={(e) => setMno(e.target.value.replace(/\D/g, ''))} />
        </Field>
      </div>
      <Field label="UDIN" error={uErr ?? undefined} hint={live ?? '18 characters: year (2) + membership no. (6) + 10 letters/digits.'}>
        <input className={`${inputClass} font-mono tracking-[0.06em]`} maxLength={18} value={udin} onBlur={() => setTouched(true)}
          onChange={(e) => setUdin(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="26212345ABCDEF1234" />
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
        <Field label="Document type">
          <select className={inputClass} value={docType} onChange={(e) => setDocType(e.target.value)}>
            {DOC_TYPES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </Field>
        <Field label="Document date"><input type="date" className={inputClass} value={docDate} onChange={(e) => setDocDate(e.target.value)} /></Field>
        <Field label="Generated on"><input type="date" className={inputClass} value={generated} onChange={(e) => setGenerated(e.target.value)} /></Field>
      </div>
      <Field label="Description (optional)"><input className={inputClass} value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
    </Modal>
  );
}

function RevokeModal({ u, onClose }: { u: AuditUdin; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const go = useAuditMutation(() => auditApi.revokeUdin(u.id, { reason: reason.trim() }), 'UDIN revoked.', onClose);
  return (
    <Modal open title={`Revoke ${u.udin}`} onClose={onClose} width="w-[480px]"
      footer={<>
        <button type="button" className={smallBtn} onClick={onClose}>Cancel</button>
        <button type="button" className={primaryBtn} disabled={!reason.trim() || go.isPending} onClick={() => go.mutate()}>Revoke</button>
      </>}>
      <p className="text-13 text-neutral-600 mb-3">Revoke it on the ICAI UDIN portal too. The row stays in the register, marked revoked.</p>
      <Field label="Reason"><input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}
