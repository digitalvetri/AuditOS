import { useState, type ReactNode } from 'react';
import { type CaseDetail, type Partner, type RegistrationDetails, type LlpDetails } from '@/modules/partnership/api';
import { Card, Field, Modal, fieldErrors, inputClass, textareaClass } from '@/modules/workstation/components';
import { Button } from '@/components/Button';
import { ENTITY_TYPE_OPTIONS, useSvc } from './shared';
import { useCaseMutation } from './PartnershipCase';

/**
 * Registration Details — the fields named in the source PDF, Part A
 * ("Details & documents required for Partnership Deed drafting"). Client
 * master data (name, GSTIN, contact) stays on the client record.
 *
 * The switch on kind is BY DESIGN — a case's Details form is
 * service-specific, and Partnership, LLP and GST Registration each ask for
 * different things. The rest of the case screens (header, checklist,
 * documents, activity) stay generic.
 */
export function CaseDetails({ c }: { c: CaseDetail }) {
  if (c.kind === 'GST') return <GstCaseDetails c={c} />;
  if (c.kind === 'LLP') return <LlpCaseDetails c={c} />;
  return <PartnershipDetails c={c} />;
}

function PartnershipDetails({ c }: { c: CaseDetail }) {
  const { api: regApi } = useSvc();
  const [d, setD] = useState<RegistrationDetails>(() => normalise(c.details));
  const [dirty, setDirty] = useState(false);
  const save = useCaseMutation(() => regApi.saveDetails(c.id, d), 'Details saved');
  const premises = useCaseMutation((v: string) => regApi.updateCase(c.id, { premises_type: v || null }), 'Premises updated');
  const ro = !c.permissions.manage;
  const set = <K extends keyof RegistrationDetails>(k: K, v: RegistrationDetails[K]) => { setD((s) => ({ ...s, [k]: v })); setDirty(true); };
  const text = (k: keyof RegistrationDetails, label: string, hint?: string, area = false) => (
    <Field label={label} hint={hint}>
      {area
        ? <textarea className={textareaClass} rows={2} disabled={ro} value={d[k] as string} onChange={(e) => set(k, e.target.value as never)} />
        : <input className={inputClass} disabled={ro} value={d[k] as string} onChange={(e) => set(k, e.target.value as never)} />}
    </Field>
  );

  return (
    <div className="space-y-4">
      <Section title="Premises">
        <Field label="Principal place of business is" hint="Decides which office-proof documents apply (Rented / Leased, or Owned).">
          <select className={inputClass + ' max-w-[260px]'} disabled={ro || premises.isPending} value={c.premises_type ?? ''} onChange={(e) => premises.mutate(e.target.value)}>
            <option value="">Not specified</option>
            <option value="RENTED">Rented / Leased</option>
            <option value="OWNED">Owned</option>
          </select>
        </Field>
      </Section>

      <Section title="1. Core Firm Details">
        <Field label="Proposed Firm Name" hint="2–3 alternate options in order of preference">
          <div className="grid md:grid-cols-3 gap-2">
            {[0, 1, 2].map((i) => (
              <input key={i} className={inputClass} disabled={ro} placeholder={`Option ${i + 1}`} value={d.firm_names[i] ?? ''}
                onChange={(e) => { const n = [...d.firm_names]; n[i] = e.target.value; set('firm_names', n); }} />
            ))}
          </div>
        </Field>
        {text('nature_of_business', 'Nature of Business', 'Detailed description of the business activities', true)}
        {text('principal_place', 'Principal Place of Business', 'Full address of the main office (including pincode)', true)}
        {text('other_branches', 'Other Branches', 'Addresses of any other branches/godowns (if applicable)', true)}
      </Section>

      <Partners c={c} />

      <Section title="3. Financial & Operational Terms">
        <div className="grid md:grid-cols-2 gap-x-4">
          {text('total_capital', 'Total Capital Contribution', 'Per-partner amounts are on the partners above')}
          {text('interest_on_capital', 'Interest on Capital', 'Max 12% per annum under the Income Tax Act')}
          {text('remuneration_terms', 'Remuneration / Salary', 'Monthly salary or commission, within Sec 40(b)')}
          {text('drawing_limits', 'Drawing Limits', 'Maximum a partner can withdraw monthly')}
        </div>
      </Section>

      <Section title="4. Management & Signing Rights">
        <div className="grid md:grid-cols-2 gap-x-4">
          {text('bank_operation', 'Bank Account Operation', 'Jointly by all, or singly by specific partners')}
          {text('authorized_signatory', 'Authorized Signatory', 'Contracts, tax bills, government registrations')}
        </div>
      </Section>

      <Section title="5. Other Details">
        <Field label="Date of Commencement">
          <input type="date" className={inputClass + ' max-w-[200px]'} disabled={ro} value={d.commencement_date} onChange={(e) => set('commencement_date', e.target.value)} />
        </Field>
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Witnesses to the deed (two)</div>
        {[0, 1].map((i) => (
          <div key={i} className="grid md:grid-cols-[1fr_2fr] gap-2 mb-2">
            <input className={inputClass} disabled={ro} placeholder={`Witness ${i + 1} — full name`} value={d.deed_witnesses[i]?.name ?? ''}
              onChange={(e) => { const w = [...d.deed_witnesses]; w[i] = { ...w[i], name: e.target.value }; set('deed_witnesses', w); }} />
            <input className={inputClass} disabled={ro} placeholder="Address" value={d.deed_witnesses[i]?.address ?? ''}
              onChange={(e) => { const w = [...d.deed_witnesses]; w[i] = { ...w[i], address: e.target.value }; set('deed_witnesses', w); }} />
          </div>
        ))}
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mt-3 mb-1">Witnesses to the ROF application (two)</div>
        {[0, 1].map((i) => (
          <div key={i} className="grid md:grid-cols-3 gap-2 mb-2">
            {(['name', 'occupation', 'pan_aadhaar'] as const).map((k) => (
              <input key={k} className={inputClass} disabled={ro}
                placeholder={k === 'name' ? `Witness ${i + 1} — full name` : k === 'occupation' ? 'Occupation' : 'PAN / Aadhaar'}
                value={d.application_witnesses[i]?.[k] ?? ''}
                onChange={(e) => { const w = [...d.application_witnesses]; w[i] = { ...w[i], [k]: e.target.value }; set('application_witnesses', w); }} />
            ))}
          </div>
        ))}
      </Section>

      {!ro ? (
        <div className="sticky bottom-0 bg-white border-t border-neutral-200 py-2 flex justify-end gap-2">
          {dirty ? <span className="text-12 text-amber self-center">Unsaved changes</span> : null}
          <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => setDirty(false) })}>Save details</Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * LLP — "BASIC BUSINESS DETAILS NEEDED" (LLP source, section 3) plus the office
 * type that decides which office proofs apply (section 2). Partner KYC files
 * are in Documents; this is only the information.
 */
function LlpCaseDetails({ c }: { c: CaseDetail }) {
  const { api: regApi } = useSvc();
  const [d, setD] = useState<LlpDetails>(() => ({
    llp_names: [c.details.llp_names?.[0] ?? '', c.details.llp_names?.[1] ?? ''],
    main_objective: c.details.main_objective ?? '',
    total_contribution: c.details.total_contribution ?? '',
  }));
  const [dirty, setDirty] = useState(false);
  const save = useCaseMutation(() => regApi.saveDetails(c.id, d as never), 'Details saved');
  const office = useCaseMutation((v: string) => regApi.updateCase(c.id, { premises_type: v || null }), 'Office type updated');
  const ro = !c.permissions.manage;
  const set = (patch: Partial<LlpDetails>) => { setD((s) => ({ ...s, ...patch })); setDirty(true); };

  return (
    <div className="space-y-4">
      <Section title="Office Type">
        <Field label="LLP registered office is" hint="Decides which office-proof documents are collected.">
          <select className={inputClass + ' max-w-[260px]'} disabled={ro || office.isPending} value={c.premises_type ?? ''} onChange={(e) => office.mutate(e.target.value)}>
            <option value="">Not specified</option>
            <option value="RENTED">Rented / Leased</option>
            <option value="OWNED">Owned</option>
          </select>
        </Field>
      </Section>

      <Section title="Basic Business Details">
        <Field label="Proposed LLP Names" hint="2 unique names in order of preference">
          <div className="grid md:grid-cols-2 gap-2">
            {[0, 1].map((i) => (
              <input key={i} className={inputClass} disabled={ro} placeholder={`Proposed LLP Name ${i + 1}`} value={d.llp_names[i]}
                onChange={(e) => { const n = [...d.llp_names]; n[i] = e.target.value; set({ llp_names: n }); }} />
            ))}
          </div>
        </Field>
        <Field label="Main Objective" hint="A brief description of the business activities you plan to run">
          <textarea className={textareaClass} rows={3} disabled={ro} value={d.main_objective} onChange={(e) => set({ main_objective: e.target.value })} />
        </Field>
        <Field label="Total LLP Contribution" hint="Total capital of the LLP — each partner's share is in the partner table below">
          <input className={inputClass + ' max-w-[260px]'} disabled={ro} value={d.total_contribution} onChange={(e) => set({ total_contribution: e.target.value })} placeholder="₹" />
        </Field>
      </Section>

      <Partners c={c} />

      {!ro ? (
        <div className="sticky bottom-0 bg-white border-t border-neutral-200 py-2 flex justify-end gap-2">
          {dirty ? <span className="text-12 text-amber self-center">Unsaved changes</span> : null}
          <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => setDirty(false) })}>Save details</Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * GST Registration Details — REG-01 has almost no free-text; the checklist
 * covers what documents to collect. The entity type decides which of the six
 * §7.1 categories apply, and the premises type decides which of the four
 * office-proof documents apply.
 */
function GstCaseDetails({ c }: { c: CaseDetail }) {
  const { api: regApi } = useSvc();
  const entity = useCaseMutation((v: string) => regApi.updateCase(c.id, { entity_type: v || null }), 'Entity type updated');
  const office = useCaseMutation((v: string) => regApi.updateCase(c.id, { premises_type: v || null }), 'Premises updated');
  const ro = !c.permissions.manage;
  return (
    <div className="space-y-4">
      <Section title="Entity">
        <Field label="Client entity type" hint="Decides which of the six §7.1 categories the checklist shows.">
          <select
            className={inputClass + ' max-w-[320px]'}
            disabled={ro || entity.isPending}
            value={c.entity_type ?? ''}
            onChange={(e) => entity.mutate(e.target.value)}
          >
            <option value="">Not specified</option>
            {ENTITY_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
      </Section>

      <Section title="Business Place">
        <Field label="Principal place of business is" hint="Decides which office-proof documents are collected.">
          <select className={inputClass + ' max-w-[260px]'} disabled={ro || office.isPending} value={c.premises_type ?? ''} onChange={(e) => office.mutate(e.target.value)}>
            <option value="">Not specified</option>
            <option value="RENTED">Rented / Leased</option>
            <option value="OWNED">Owned</option>
          </select>
        </Field>
      </Section>

      {c.entity_type === 'PARTNERSHIP' || c.entity_type === 'LLP' || c.entity_type === 'PVT_LTD' ? (
        <Partners c={c} />
      ) : null}
    </div>
  );
}

/** "5,00,000" / "₹ 5,00,000" → 500000; anything unparseable → null. */
const num = (v: string | null) => {
  if (!v) return null;
  const n = Number(v.replace(/[₹,\s%]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function normalise(d: RegistrationDetails): RegistrationDetails {
  const pad = <T,>(a: T[] | undefined, n: number, blank: T) => Array.from({ length: n }, (_, i) => a?.[i] ?? blank);
  return {
    ...d,
    firm_names: pad(d.firm_names, 3, ''),
    deed_witnesses: pad(d.deed_witnesses, 2, { name: '', address: '' }),
    application_witnesses: pad(d.application_witnesses, 2, { name: '', occupation: '', pan_aadhaar: '' }),
  };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <Card title={title}><div className="px-4 pt-3 pb-1">{children}</div></Card>;
}

function Partners({ c }: { c: CaseDetail }) {
  const { api: regApi } = useSvc();
  const [editing, setEditing] = useState<Partner | 'new' | null>(null);
  const llp = c.kind === 'LLP';
  const remove = useCaseMutation((pid: string) => regApi.removePartner(c.id, pid), 'Partner removed');
  return (
    <Card
      title={llp ? 'Partners — contribution & profit share' : '2. Partners — identity, address & share'}
      right={c.permissions.manage ? <Button size="sm" onClick={() => setEditing('new')}>+ Add Partner</Button> : undefined}
    >
      {c.partners.length === 0 ? (
        <div className="px-4 py-4 text-13 text-neutral-500">
          {llp ? 'No partners added yet. Each partner added here gets their own KYC checklist and documents.' : 'No partners yet. Each partner added here gets their own PAN, ID/address proof and photograph to collect.'}
        </div>
      ) : (
        <div className="m-cards md:overflow-x-auto">
          <table className="w-full md:min-w-[800px] border-collapse">
            <thead>
              <tr className="border-b border-neutral-200">
                {(llp ? ['Partner', 'PAN / Aadhaar', 'Mobile / Email', 'Contribution', 'Profit share', ''] : ['Partner', "Father's name", 'Permanent address', 'Mobile / Email', 'Capital', 'P&L share', '']).map((h) => (
                  <th key={h} className="h-8 px-3 text-left text-11 uppercase tracking-[0.06em] font-medium text-neutral-500">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {c.partners.map((p) => (
                <tr key={p.id} className="border-b border-neutral-200 text-13 align-top">
                  <td data-label="Partner" className="px-3 py-2 font-medium">{p.name}<div className="text-12 text-neutral-500 font-normal">{p.pan ?? ''}</div></td>
                  {llp ? (
                    <td data-label="PAN / Aadhaar" className="px-3 py-2">{p.pan ?? '—'}<div className="text-12 text-neutral-500">{p.aadhaar ?? ''}</div></td>
                  ) : (
                    <>
                      <td data-label="Father's name" className="px-3 py-2">{p.father_name ?? '—'}</td>
                      <td data-label="Permanent address" className="px-3 py-2">{p.address ?? '—'}</td>
                    </>
                  )}
                  <td data-label="Mobile / Email" className="px-3 py-2">{p.mobile ?? '—'}<div className="text-12 text-neutral-500">{p.email ?? ''}</div></td>
                  <td data-label="Capital" className="px-3 py-2 tabular-nums">{p.capital ?? '—'}</td>
                  <td data-label="P&L share" className="px-3 py-2 tabular-nums">{p.profit_share ? `${p.profit_share}%` : '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {c.permissions.manage ? (
                      <>
                        <button className="underline mr-3" onClick={() => setEditing(p)}>Edit</button>
                        <button className="underline text-red" onClick={() => { if (window.confirm(`Remove ${p.name}? Uploaded files are kept.`)) remove.mutate(p.id); }}>Remove</button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
            {llp ? <PartnerTotals partners={c.partners} /> : null}
          </table>
        </div>
      )}
      {editing ? <PartnerModal c={c} partner={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

function PartnerTotals({ partners }: { partners: Partner[] }) {
  const capital = partners.reduce((t, p) => t + (num(p.capital) ?? 0), 0);
  const share = partners.reduce((t, p) => t + (num(p.profit_share) ?? 0), 0);
  const off = partners.some((p) => p.profit_share) && Math.abs(share - 100) > 0.001;
  return (
    <tfoot>
      <tr className="text-13 font-medium">
        <td className="px-3 py-2">Total</td>
        <td /><td />
        <td className="px-3 py-2 tabular-nums">{capital ? `₹${capital.toLocaleString('en-IN')}` : '—'}</td>
        <td className={`px-3 py-2 tabular-nums ${off ? 'text-red' : ''}`}>{share ? `${share}%` : '—'}{off ? ' · should total 100%' : ''}</td>
        <td />
      </tr>
    </tfoot>
  );
}

function PartnerModal({ c, partner, onClose }: { c: CaseDetail; partner: Partner | null; onClose: () => void }) {
  const { api: regApi } = useSvc();
  const [f, setF] = useState({
    name: partner?.name ?? '', father_name: partner?.father_name ?? '', address: partner?.address ?? '',
    mobile: partner?.mobile ?? '', email: partner?.email ?? '', pan: partner?.pan ?? '',
    capital: partner?.capital ?? '', profit_share: partner?.profit_share ?? '', remuneration: partner?.remuneration ?? '',
    aadhaar: partner?.aadhaar ?? '',
  });
  const llp = c.kind === 'LLP';
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const m = useCaseMutation(() => (partner ? regApi.updatePartner(c.id, partner.id, f) : regApi.addPartner(c.id, f)), partner ? 'Partner updated' : 'Partner added');
  const errs = fieldErrors(m.error);
  return (
    <Modal open title={partner ? `Edit ${partner.name}` : 'Add Partner'} onClose={onClose} width="w-[640px]"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={m.isPending} onClick={() => m.mutate(undefined, { onSuccess: onClose })}>Save</Button></>}>
      {llp ? (
        <div className="grid grid-cols-2 gap-x-3">
          <Field label="Full name" error={errs.name}><input className={inputClass} value={f.name} onChange={set('name')} /></Field>
          <Field label="PAN" hint="Name must match exactly with Aadhaar" error={errs.pan}><input className={inputClass} value={f.pan} onChange={set('pan')} /></Field>
          <Field label="Aadhaar" error={errs.aadhaar}><input className={inputClass} value={f.aadhaar} onChange={set('aadhaar')} /></Field>
          <Field label="Mobile" hint="Active — for OTP verification" error={errs.mobile}><input className={inputClass} value={f.mobile} onChange={set('mobile')} /></Field>
          <Field label="Email" hint="For OTP verification" error={errs.email}><input className={inputClass} value={f.email} onChange={set('email')} /></Field>
          <Field label="Contribution" error={errs.capital}><input className={inputClass} value={f.capital} onChange={set('capital')} placeholder="₹" /></Field>
          <Field label="Profit share (%)" error={errs.profit_share}><input className={inputClass} value={f.profit_share} onChange={set('profit_share')} /></Field>
        </div>
      ) : (
      <div className="grid grid-cols-2 gap-x-3">
        <Field label="Full name" error={errs.name}><input className={inputClass} value={f.name} onChange={set('name')} /></Field>
        <Field label="Father's name" hint="As per official records" error={errs.father_name}><input className={inputClass} value={f.father_name} onChange={set('father_name')} /></Field>
        <div className="col-span-2"><Field label="Full permanent address" error={errs.address}><textarea className={textareaClass} rows={2} value={f.address} onChange={set('address')} /></Field></div>
        <Field label="Mobile" hint="Active — for OTP verifications" error={errs.mobile}><input className={inputClass} value={f.mobile} onChange={set('mobile')} /></Field>
        <Field label="Email" error={errs.email}><input className={inputClass} value={f.email} onChange={set('email')} /></Field>
        <Field label="PAN" hint="Name must match other documents" error={errs.pan}><input className={inputClass} value={f.pan} onChange={set('pan')} /></Field>
        <Field label="Capital contribution" error={errs.capital}><input className={inputClass} value={f.capital} onChange={set('capital')} placeholder="₹ amount or %" /></Field>
        <Field label="Profit & loss share (%)" error={errs.profit_share}><input className={inputClass} value={f.profit_share} onChange={set('profit_share')} /></Field>
        <Field label="Remuneration / salary" error={errs.remuneration}><input className={inputClass} value={f.remuneration} onChange={set('remuneration')} /></Field>
      </div>
      )}
    </Modal>
  );
}
