/**
 * Portal Access editor — GST-RETURNS-CASE-SCREEN §5 / §9-5. Lives inside
 * the GST Client edit modal. Every field is optional, so an incomplete
 * record still saves cleanly.
 *
 * Two rules the UI enforces so the server-side invariant holds:
 *   - When passwordHeldBy toggles to 'client', the password input is
 *     cleared and disabled. Server rejects the combination anyway; we
 *     just don't let a user paste and then toggle away.
 *   - The password field never renders the current value. Leaving it
 *     blank on save is "no change"; a non-empty value replaces the
 *     ciphertext at rest.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye } from 'lucide-react';
import { Field, inputClass } from '@/modules/workstation/components';
import { useToast } from '@/components/Toast';
import { gstPortalApi, type PortalRecord, type PasswordField } from '@/modules/gstPortal/api';
import type { ApiError } from '@/services/api';

interface Draft {
  portal_username: string;
  password_held_by: 'firm' | 'client';
  portal_password: string;
  registered_mobile: string;  // full number typed in; server masks it
  otp_contact_name: string;
  otp_contact_number: string;
  mfa_method: 'otp_mobile' | 'authenticator' | 'none';
  ewb_username: string;
  ewb_password: string;
  irp_name: string;
  irp_username: string;
  irp_password: string;
}

const EMPTY_DRAFT: Draft = {
  portal_username: '', password_held_by: 'firm', portal_password: '',
  registered_mobile: '', otp_contact_name: '', otp_contact_number: '',
  mfa_method: 'otp_mobile',
  ewb_username: '', ewb_password: '',
  irp_name: '', irp_username: '', irp_password: '',
};

function draftFrom(record: PortalRecord | null): Draft {
  if (!record) return EMPTY_DRAFT;
  return {
    portal_username: record.portal_username ?? '',
    password_held_by: record.password_held_by,
    portal_password: '',  // never prefill
    registered_mobile: '', // server only stored the masked version
    otp_contact_name: record.otp_contact_name ?? '',
    otp_contact_number: record.otp_contact_number ?? '',  // masked
    mfa_method: record.mfa_method,
    ewb_username: record.ewb_username ?? '',
    ewb_password: '',
    irp_name: record.irp_name ?? '',
    irp_username: record.irp_username ?? '',
    irp_password: '',
  };
}

export function PortalAccessSection({ gstProfileId }: { gstProfileId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['gst-portal', gstProfileId],
    queryFn: () => gstPortalApi.get(gstProfileId),
    retry: false,
  });
  const [d, setD] = useState<Draft>(EMPTY_DRAFT);
  const [dirty, setDirty] = useState(false);
  const [revealed, setRevealed] = useState<Partial<Record<PasswordField, string>>>({});

  useEffect(() => { if (q.data) { setD(draftFrom(q.data.record)); setDirty(false); } }, [q.data]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setD((s) => ({ ...s, [k]: v }));
    setDirty(true);
  };
  const setHeldBy = (v: 'firm' | 'client') => {
    setD((s) => ({ ...s, password_held_by: v, ...(v === 'client' ? { portal_password: '' } : {}) }));
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: () => gstPortalApi.save(gstProfileId, {
      portal_username: d.portal_username || null,
      password_held_by: d.password_held_by,
      // Blank password = "no change". Only send when the user typed something.
      ...(d.portal_password ? { portal_password: d.portal_password } : {}),
      // Blank registered_mobile = "no change" (server keeps the existing mask).
      ...(d.registered_mobile ? { registered_mobile: d.registered_mobile } : {}),
      otp_contact_name: d.otp_contact_name || null,
      otp_contact_number: d.otp_contact_number || null,
      mfa_method: d.mfa_method,
      ewb_username: d.ewb_username || null,
      ...(d.ewb_password ? { ewb_password: d.ewb_password } : {}),
      irp_name: d.irp_name || null,
      irp_username: d.irp_username || null,
      ...(d.irp_password ? { irp_password: d.irp_password } : {}),
    }),
    onSuccess: (r) => {
      qc.setQueryData(['gst-portal', gstProfileId], { data: { record: r.record } });
      setD(draftFrom(r.record));
      setDirty(false);
      setRevealed({});
      toast.push('success', 'Portal access saved');
    },
    onError: (e: ApiError) => toast.push('error', e.message),
  });

  const reveal = useMutation({
    mutationFn: (field: PasswordField) => gstPortalApi.reveal(gstProfileId, field),
    onSuccess: (r) => setRevealed((s) => ({ ...s, [r.field]: r.value ?? '' })),
    onError: (e: ApiError) => toast.push('error', e.message),
  });

  const record = q.data?.record ?? null;
  const clientHolds = d.password_held_by === 'client';
  const portalPasswordStored = !!record?.portal_password_present && !clientHolds;
  const ewbPasswordStored = !!record?.ewb_password_present;
  const irpPasswordStored = !!record?.irp_password_present;

  return (
    <fieldset className="mt-4 pt-3 border-t border-neutral-200">
      <legend className="text-11 uppercase tracking-[0.06em] text-neutral-500">Portal Access</legend>
      <p className="text-12 text-neutral-500 mb-3">
        Credentials for the GST portal, E-Way Bill portal and IRP. Encrypted at rest.
        The OTP contact is who the filer rings when the portal sends the MFA code —
        the most-used field here, more valuable than the stored password.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-3">
        <Field label="Portal username" hint="Not a secret. Needed every login.">
          <input className={inputClass} value={d.portal_username} onChange={(e) => set('portal_username', e.target.value)} />
        </Field>
        <Field label="Password held by">
          <select className={inputClass} value={d.password_held_by} onChange={(e) => setHeldBy(e.target.value as 'firm' | 'client')}>
            <option value="firm">Firm (we store it)</option>
            <option value="client">Client (do not store)</option>
          </select>
        </Field>
      </div>

      <Field label="Portal password" hint={
        clientHolds ? 'Client holds the password — the firm will not store it.'
          : portalPasswordStored ? 'A password is stored. Leave blank to keep, or type a new one to replace.'
          : 'No password stored yet.'
      }>
        {clientHolds ? (
          <input className={inputClass} disabled placeholder="—" />
        ) : (
          <div className="flex items-center gap-2">
            <input
              className={`${inputClass} font-mono flex-1`}
              type="password"
              value={d.portal_password}
              onChange={(e) => set('portal_password', e.target.value)}
              placeholder={portalPasswordStored ? '••••••• (unchanged)' : ''}
            />
            {portalPasswordStored ? (
              revealed.portal_password ? (
                <span className="text-12 font-mono px-2 py-1 bg-neutral-100 rounded">{revealed.portal_password}</span>
              ) : (
                <button type="button" className="text-12 underline text-neutral-500 inline-flex items-center gap-1" disabled={reveal.isPending}
                        onClick={() => reveal.mutate('portal_password')}>
                  <Eye size={12} /> Reveal
                </button>
              )
            ) : null}
          </div>
        )}
      </Field>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-x-3">
        <Field label="Registered mobile" hint={
          record?.registered_mobile_masked ? `Currently ${record.registered_mobile_masked}. Type a new number to change.` : 'Where the portal sends the OTP.'
        }>
          <input className={inputClass} value={d.registered_mobile} onChange={(e) => set('registered_mobile', e.target.value)} inputMode="tel" placeholder={record?.registered_mobile_masked ?? '9876543210'} />
        </Field>
        <Field label="OTP contact name" hint="Whose phone to ring at 6pm.">
          <input className={inputClass} value={d.otp_contact_name} onChange={(e) => set('otp_contact_name', e.target.value)} />
        </Field>
        <Field label="OTP contact number" hint="Displayed masked on the case header.">
          <input className={inputClass} value={d.otp_contact_number} onChange={(e) => set('otp_contact_number', e.target.value)} inputMode="tel" />
        </Field>
      </div>

      <Field label="MFA method">
        <select className={inputClass + ' max-w-[240px]'} value={d.mfa_method} onChange={(e) => set('mfa_method', e.target.value as 'otp_mobile' | 'authenticator' | 'none')}>
          <option value="otp_mobile">OTP to registered mobile</option>
          <option value="authenticator">Authenticator app</option>
          <option value="none">None (rare — old logins)</option>
        </select>
      </Field>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-3 mt-3 pt-2 border-t border-neutral-100">
        <Field label="E-Way Bill username">
          <input className={inputClass} value={d.ewb_username} onChange={(e) => set('ewb_username', e.target.value)} />
        </Field>
        <Field label="E-Way Bill password" hint={ewbPasswordStored ? 'A password is stored. Leave blank to keep.' : ''}>
          <div className="flex items-center gap-2">
            <input className={inputClass + ' font-mono flex-1'} type="password" value={d.ewb_password} onChange={(e) => set('ewb_password', e.target.value)} placeholder={ewbPasswordStored ? '••••••• (unchanged)' : ''} />
            {ewbPasswordStored ? (
              revealed.ewb_password ? <span className="text-12 font-mono px-2 py-1 bg-neutral-100 rounded">{revealed.ewb_password}</span>
                : <button type="button" className="text-12 underline text-neutral-500 inline-flex items-center gap-1" disabled={reveal.isPending} onClick={() => reveal.mutate('ewb_password')}><Eye size={12} /> Reveal</button>
            ) : null}
          </div>
        </Field>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-x-3">
        <Field label="IRP name" hint="Which of the six IRPs the client uses.">
          <input className={inputClass} value={d.irp_name} onChange={(e) => set('irp_name', e.target.value)} placeholder="NIC / Alankit / …" />
        </Field>
        <Field label="IRP username">
          <input className={inputClass} value={d.irp_username} onChange={(e) => set('irp_username', e.target.value)} />
        </Field>
        <Field label="IRP password" hint={irpPasswordStored ? 'A password is stored.' : ''}>
          <div className="flex items-center gap-2">
            <input className={inputClass + ' font-mono flex-1'} type="password" value={d.irp_password} onChange={(e) => set('irp_password', e.target.value)} placeholder={irpPasswordStored ? '••••••• (unchanged)' : ''} />
            {irpPasswordStored ? (
              revealed.irp_password ? <span className="text-12 font-mono px-2 py-1 bg-neutral-100 rounded">{revealed.irp_password}</span>
                : <button type="button" className="text-12 underline text-neutral-500 inline-flex items-center gap-1" disabled={reveal.isPending} onClick={() => reveal.mutate('irp_password')}><Eye size={12} /> Reveal</button>
            ) : null}
          </div>
        </Field>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        {dirty ? <span className="text-12 text-amber">Unsaved changes</span> : null}
        <button
          type="button"
          className="h-8 px-3 text-13 bg-neutral-900 text-white rounded disabled:opacity-50"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save portal access'}
        </button>
      </div>
    </fieldset>
  );
}
