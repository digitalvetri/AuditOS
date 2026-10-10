/**
 * Edit a client's own details after onboarding: names, business type,
 * contact, address and the tax identifiers (GSTIN, PAN, TAN, CIN / LLPIN).
 * Same permission as the rest of the client record (workstation.client.manage);
 * the server checks every field again.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { workstationApi } from './api';
import { Field, Modal, fieldErrors, inputClass } from './components';
import type { ClientDetail } from './types';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';
import { gstinError, isCin, isLlpin, isPan, isTan, normId } from '@/lib/ids';

const BUSINESS_TYPES = [
  'Private Limited', 'Public Limited', 'One Person Company', 'LLP', 'Partnership',
  'Proprietorship', 'Individual', 'HUF', 'Trust', 'Society', 'AOP / BOI',
];

type Form = {
  company_name: string; legal_name: string; business_type: string;
  contact_person: string; contact_number: string; email: string; address: string;
  gstin: string; pan: string; tan: string; cin: string;
};

const fromClient = (c: ClientDetail): Form => ({
  company_name: c.company_name ?? '', legal_name: c.legal_name ?? '', business_type: c.business_type ?? '',
  contact_person: c.contact_person ?? '', contact_number: c.contact_number ?? '', email: c.email ?? '',
  address: c.address ?? '', gstin: c.gstin ?? '', pan: c.pan ?? '', tan: c.tan ?? '', cin: c.cin ?? '',
});

/** "Edit" for a card header; renders nothing for people who cannot edit clients. */
export function EditClientDetailsButton({ client }: { client: ClientDetail }) {
  const { session } = useAuth();
  const [open, setOpen] = useState(false);
  if (!can(session?.role.code, 'workstation.client.manage', 'self')) return null;
  return (
    <>
      <button type="button" className="text-12 text-primary hover:underline inline-flex items-center gap-1" onClick={() => setOpen(true)}>
        <Pencil size={12} />Edit
      </button>
      {open ? <EditClientModal client={client} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function EditClientModal({ client, onClose }: { client: ClientDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<Form>(() => fromClient(client));
  const [local, setLocal] = useState<Record<string, string>>({});
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((cur) => ({ ...cur, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: () => {
      // Send only what changed, so an untouched field is never re-validated.
      const before = fromClient(client);
      const patch: Record<string, unknown> = {};
      for (const k of Object.keys(f) as (keyof Form)[]) {
        const v = ['gstin', 'pan', 'tan', 'cin'].includes(k) ? normId(f[k]) : f[k].trim();
        if (v !== before[k]) patch[k] = v === '' && k !== 'company_name' && k !== 'contact_person' && k !== 'contact_number' ? null : v;
      }
      return workstationApi.updateClient(client.id, patch);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', 'Client details saved.');
      onClose();
    },
  });

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!f.company_name.trim()) e.company_name = 'This field is required.';
    if (!f.contact_person.trim()) e.contact_person = 'This field is required.';
    if (!f.contact_number.trim()) e.contact_number = 'This field is required.';
    if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = 'Enter a valid email address.';
    const pan = normId(f.pan), gstin = normId(f.gstin), tan = normId(f.tan), cin = normId(f.cin);
    if (pan && !isPan(pan)) e.pan = 'Enter a valid 10-character PAN.';
    if (gstin) { const ge = gstinError(gstin, pan || undefined); if (ge) e.gstin = ge; }
    if (tan && !isTan(tan)) e.tan = 'Enter a valid 10-character TAN (e.g. CHEK09876B).';
    if (cin && !isCin(cin) && !isLlpin(cin)) e.cin = 'Enter a valid CIN (U74999TN2020PTC123456) or LLPIN (AAB-1234).';
    setLocal(e);
    return Object.keys(e).length === 0;
  }

  const server = fieldErrors(save.error);
  const err = (k: string) => local[k] ?? server[k];
  const upper = (k: keyof Form) => (e: { target: { value: string } }) => setF((cur) => ({ ...cur, [k]: e.target.value.toUpperCase() }));

  return (
    <Modal
      open title={`Edit details — ${client.company_name}`} onClose={onClose} width="w-[640px]"
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={save.isPending} onClick={() => { if (validate()) save.mutate(); }}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </>}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
        <Field label="Company Name" error={err('company_name')}><input className={inputClass} value={f.company_name} onChange={set('company_name')} /></Field>
        <Field label="Legal Name" error={err('legal_name')}><input className={inputClass} value={f.legal_name} onChange={set('legal_name')} /></Field>
        <Field label="Business Type" error={err('business_type')}>
          <input className={inputClass} list="edit-client-business-types" value={f.business_type} onChange={set('business_type')} />
        </Field>
        <Field label="Contact Person" error={err('contact_person')}><input className={inputClass} value={f.contact_person} onChange={set('contact_person')} /></Field>
        <Field label="Contact Number" error={err('contact_number')}><input className={inputClass} inputMode="tel" value={f.contact_number} onChange={set('contact_number')} /></Field>
        <Field label="Email" error={err('email')}><input className={inputClass} type="email" value={f.email} onChange={set('email')} /></Field>
      </div>
      <Field label="Address" error={err('address')}><textarea className={inputClass + ' min-h-[64px]'} value={f.address} onChange={set('address')} /></Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
        <Field label="GSTIN" error={err('gstin')} hint="Leave empty if unregistered."><input className={inputClass + ' font-mono'} maxLength={15} value={f.gstin} onChange={upper('gstin')} /></Field>
        <Field label="PAN" error={err('pan')}><input className={inputClass + ' font-mono'} maxLength={10} value={f.pan} onChange={upper('pan')} /></Field>
        <Field label="TAN" error={err('tan')}><input className={inputClass + ' font-mono'} maxLength={10} value={f.tan} onChange={upper('tan')} /></Field>
        <Field label="CIN / LLPIN" error={err('cin')} hint="Companies: CIN. LLPs: LLPIN."><input className={inputClass + ' font-mono'} maxLength={21} value={f.cin} onChange={upper('cin')} /></Field>
      </div>
      <datalist id="edit-client-business-types">
        {BUSINESS_TYPES.map((t) => <option key={t} value={t} />)}
      </datalist>
      {save.error && !Object.keys(server).length ? <p className="text-12 text-danger">{(save.error as Error).message}</p> : null}
    </Modal>
  );
}
