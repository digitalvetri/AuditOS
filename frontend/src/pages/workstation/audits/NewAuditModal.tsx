import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Field, Modal, inputClass } from '@/modules/workstation/components';
import { workstationApi } from '@/modules/workstation/api';
import { engagementApi } from '@/modules/workstation/engagement/api';
import { clientNameWithOrg } from '@/modules/workstation/organization/badges';
import { useToast } from '@/components/Toast';
import { auditApi } from '@/modules/audit/api';
import { AUDIT_TYPES, apiFieldErrors, auditTypeLabel, auditDefaultFy, errText, fyOptions, primaryBtn, smallBtn } from '@/modules/audit/components';
import type { AuditType } from '@/modules/audit/types';

/**
 * "New audit file" — client × FY × type. The server seeds the working-paper
 * index for the type and puts the signing partner and manager on the team.
 */
export function NewAuditModal({ open, onClose, clientId: presetClient }: { open: boolean; onClose: () => void; clientId?: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const [clientId, setClientId] = useState(presetClient ?? '');
  const [fy, setFy] = useState(auditDefaultFy());
  const [type, setType] = useState<AuditType>('statutory');
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [partnerId, setPartnerId] = useState('');
  const [membershipNo, setMembershipNo] = useState('');
  const [managerId, setManagerId] = useState('');
  const [start, setStart] = useState('');
  const [reportBy, setReportBy] = useState('');
  const [letterId, setLetterId] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({});

  const autoTitle = `${auditTypeLabel(type)} FY ${fy}`;
  useEffect(() => { if (!titleTouched) setTitle(autoTitle); }, [autoTitle, titleTouched]);

  const clients = useQuery({ queryKey: ['audits.clients'], queryFn: () => workstationApi.listClients(), enabled: open, staleTime: 120_000 });
  const staff = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees, enabled: open, staleTime: 120_000 });
  const letters = useQuery({
    queryKey: ['audits.letters', clientId],
    queryFn: () => engagementApi.list({ client_id: clientId, limit: 100 }),
    enabled: open && Boolean(clientId),
    retry: false,
  });
  const people = useMemo(() => staff.data?.items ?? [], [staff.data]);

  const create = useMutation({
    mutationFn: () => auditApi.create({
      client_id: clientId,
      financial_year: fy,
      audit_type: type,
      title: title.trim() || autoTitle,
      engagement_letter_id: letterId || undefined,
      signing_partner_id: partnerId || undefined,
      partner_membership_no: membershipNo.trim() || undefined,
      manager_id: managerId || undefined,
      planned_start_date: start || undefined,
      planned_report_date: reportBy || undefined,
    }),
    onSuccess: (f) => {
      toast.push('success', `${f.audit_code} created with its working-paper index.`);
      qc.invalidateQueries({ queryKey: ['audits'] });
      onClose();
      navigate(`/workstation/audits/${f.id}`);
    },
    onError: (e) => { setErrs(apiFieldErrors(e)); toast.push('error', errText(e)); },
  });

  const submit = () => {
    const e: Record<string, string> = {};
    if (!clientId) e.client_id = 'Choose a client.';
    if (!/^\d{4}-\d{2}$/.test(fy)) e.financial_year = 'Financial year as 2025-26.';
    if (membershipNo.trim() && !/^\d{1,6}$/.test(membershipNo.trim())) e.partner_membership_no = 'A membership number is up to 6 digits.';
    if (start && reportBy && reportBy < start) e.planned_report_date = 'The report date is before the start.';
    setErrs(e);
    if (Object.keys(e).length === 0) create.mutate();
  };

  return (
    <Modal open={open} onClose={onClose} title="New audit file" width="w-[640px]"
      footer={<>
        <button type="button" className={smallBtn} onClick={onClose}>Cancel</button>
        <button type="button" className={primaryBtn} disabled={create.isPending} onClick={submit}>
          {create.isPending ? 'Creating…' : 'Create audit file'}
        </button>
      </>}>
      <Field label="Client" error={errs.client_id}>
        <select className={inputClass} value={clientId} onChange={(e) => { setClientId(e.target.value); setLetterId(''); }} disabled={Boolean(presetClient)}>
          <option value="">{clients.isLoading ? 'Loading clients…' : 'Select a client…'}</option>
          {(clients.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{clientNameWithOrg(c)}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
        <Field label="Financial year" error={errs.financial_year}>
          <select className={inputClass} value={fy} onChange={(e) => setFy(e.target.value)}>
            {fyOptions().map((y) => <option key={y} value={y}>FY {y}</option>)}
          </select>
        </Field>
        <Field label="Audit type" error={errs.audit_type}>
          <select className={inputClass} value={type} onChange={(e) => setType(e.target.value as AuditType)}>
            {AUDIT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Title" error={errs.title} hint={titleTouched ? undefined : 'Follows the type and year until you edit it.'}>
        <input className={inputClass} value={title} onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); }} />
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
        <Field label="Signing partner" error={errs.signing_partner_id}>
          <select className={inputClass} value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
            <option value="">Not yet chosen</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.designation ? ` · ${p.designation}` : ''}</option>)}
          </select>
        </Field>
        <Field label="Partner's membership no." error={errs.partner_membership_no} hint="As printed on the report.">
          <input className={inputClass} inputMode="numeric" maxLength={6} value={membershipNo}
            onChange={(e) => setMembershipNo(e.target.value.replace(/\D/g, ''))} placeholder="e.g. 212345" />
        </Field>
        <Field label="Manager" error={errs.manager_id}>
          <select className={inputClass} value={managerId} onChange={(e) => setManagerId(e.target.value)}>
            <option value="">None</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        </Field>
        <Field label="Engagement letter (SA 210)" error={errs.engagement_letter_id} hint={clientId ? undefined : 'Choose a client first.'}>
          <select className={inputClass} value={letterId} onChange={(e) => setLetterId(e.target.value)} disabled={!clientId}>
            <option value="">Not linked</option>
            {(letters.data?.items ?? []).map((l) => (
              <option key={l.id} value={l.id}>{l.letter_code} · {l.subject}{l.financial_year ? ` · FY ${l.financial_year}` : ''}</option>
            ))}
          </select>
        </Field>
        <Field label="Planned start" error={errs.planned_start_date}>
          <input type="date" className={inputClass} value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Planned report date" error={errs.planned_report_date}>
          <input type="date" className={inputClass} value={reportBy} onChange={(e) => setReportBy(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
