import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { incorporationApi } from '@/modules/incorporation/api';
import { workstationApi } from '@/modules/workstation/api';
import {
  Card, Detail, Field, PageHeader, fieldErrors, inputClass, textareaClass,
} from '@/modules/workstation/components';
import { Button } from '@/components/Button';
import { titleCase } from '@/modules/incorporation/components';
import { useToast } from '@/components/Toast';
import type { EntityType } from '@/modules/incorporation/types';

/**
 * NEW CASE — a six-step wizard.
 *
 * All state lives in one object held for the whole wizard, so stepping
 * backwards loses nothing. Each step validates what it owns before letting
 * you move on, and the SERVER validates the whole thing again on submit —
 * the step checks are a courtesy, not the control.
 *
 * The case is created only on the explicit confirmation in step 6.
 */
interface PartyDraft {
  role: string; name: string; contact_number: string; email: string;
  address: string; client_contact_id: string; dsc_required: boolean;
}
interface DocDraft { category: string; document_type: string; description: string }

interface Draft {
  client_id: string;
  entity_type_id: string;
  proposed_name: string;
  alternate_name: string;
  business_activity: string;
  business_category: string;
  state: string;
  city: string;
  registered_office_info: string;
  incorporation_objective: string;
  parties: PartyDraft[];
  document_requests: DocDraft[];
  assigned_employee_id: string;
  priority: string;
  target_date: string;
  internal_notes: string;
}

const EMPTY: Draft = {
  client_id: '', entity_type_id: '', proposed_name: '', alternate_name: '',
  business_activity: '', business_category: '', state: '', city: '',
  registered_office_info: '', incorporation_objective: '',
  parties: [], document_requests: [],
  assigned_employee_id: '', priority: 'medium', target_date: '', internal_notes: '',
};

/** Requested at case creation. Editable in step 4 — these are only defaults. */
const DEFAULT_DOCS: DocDraft[] = [
  { category: 'identity_kyc', document_type: 'PAN card — each person', description: '' },
  { category: 'identity_kyc', document_type: 'Aadhaar / identity proof — each person', description: '' },
  { category: 'address_proof', document_type: 'Address proof — each person', description: '' },
  { category: 'registered_office', document_type: 'Registered office proof', description: '' },
  { category: 'registered_office', document_type: 'No-objection letter from the premises owner', description: '' },
];

const STEPS = ['Client', 'Entity', 'People', 'Documents', 'Assignment', 'Review'];

export function IncorporationCreateCasePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const [clientSearch, setClientSearch] = useState('');

  const settings = useQuery({ queryKey: ['incorporation', 'settings'], queryFn: incorporationApi.settings });
  const clients = useQuery({
    queryKey: ['workstation', 'clients', 'wizard'],
    queryFn: () => workstationApi.listClients({}),
  });
  const employees = useQuery({
    queryKey: ['workstation', 'assignable-employees'],
    queryFn: workstationApi.assignableEmployees,
  });
  // Contacts already on file for the chosen client, so a director who is
  // already a client contact is LINKED rather than re-keyed.
  const clientDetail = useQuery({
    queryKey: ['workstation', 'client', draft.client_id],
    queryFn: () => workstationApi.getClient(draft.client_id),
    enabled: !!draft.client_id,
  });

  const entityType: EntityType | undefined = settings.data?.entity_types
    .find((e) => e.id === draft.entity_type_id);

  const create = useMutation({
    mutationFn: () => incorporationApi.createCase({
      ...draft,
      alternate_name: draft.alternate_name || undefined,
      target_date: draft.target_date || undefined,
      parties: draft.parties.map((p) => ({
        role: p.role, name: p.name,
        contact_number: p.contact_number || undefined,
        email: p.email || undefined,
        address: p.address || undefined,
        client_contact_id: p.client_contact_id || undefined,
        dsc_required: p.dsc_required,
      })),
      document_requests: draft.document_requests.filter((d) => d.document_type.trim()),
    }),
    onSuccess: (row) => {
      void qc.invalidateQueries({ queryKey: ['incorporation'] });
      toast.push('success', `Case ${row.case_code} created.`);
      navigate(`../cases/${row.id}`);
    },
  });

  const serverErrors = fieldErrors(create.error);
  const errors = { ...localErrors, ...serverErrors };

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  /** Per-step validation. Returns true when the step may be left. */
  function validateStep(i: number): boolean {
    const e: Record<string, string> = {};
    if (i === 0 && !draft.client_id) e.client_id = 'Choose the client this case is for.';
    if (i === 1) {
      if (!draft.entity_type_id) e.entity_type_id = 'Choose an entity type.';
      if (!draft.proposed_name.trim()) e.proposed_name = 'Enter the proposed name.';
    }
    if (i === 2) {
      if (draft.parties.length === 0) e.parties = 'Add at least one person.';
      draft.parties.forEach((p, n) => {
        if (!p.name.trim()) e[`parties.${n}.name`] = 'Enter a name.';
        if (!p.role) e[`parties.${n}.role`] = 'Choose a role.';
      });
      if (entityType && draft.parties.length < entityType.min_parties) {
        e.parties = `${entityType.name} needs at least ${entityType.min_parties} `
          + `${entityType.min_parties === 1 ? 'person' : 'people'}.`;
      }
      if (entityType?.max_parties && draft.parties.length > entityType.max_parties) {
        e.parties = `${entityType.name} takes at most ${entityType.max_parties} people.`;
      }
    }
    if (i === 4 && !draft.assigned_employee_id) {
      e.assigned_employee_id = 'Assign the case to someone.';
    }
    setLocalErrors(e);
    return Object.keys(e).length === 0;
  }

  const next = () => { if (validateStep(step)) setStep((s) => Math.min(s + 1, STEPS.length - 1)); };
  const back = () => { setLocalErrors({}); setStep((s) => Math.max(s - 1, 0)); };

  const visibleClients = useMemo(() => {
    const all = clients.data?.items ?? [];
    const q = clientSearch.trim().toLowerCase();
    if (!q) return all.slice(0, 50);
    return all.filter((c) =>
      c.company_name.toLowerCase().includes(q) || c.client_id.toLowerCase().includes(q),
    ).slice(0, 50);
  }, [clients.data, clientSearch]);

  const chosenClient = (clients.data?.items ?? []).find((c) => c.id === draft.client_id);
  const roles = entityType?.party_roles ?? [];
  const roleLabel = (v: string) =>
    settings.data?.vocabularies.party_roles.find((r) => r.value === v)?.label ?? titleCase(v);

  return (
    <div>
      <PageHeader
        title="New Incorporation Case"
        subtitle={`Step ${step + 1} of ${STEPS.length} · ${STEPS[step]}`}
        action={<Button variant="secondary" onClick={() => navigate('..')}>Cancel</Button>}
      />

      {/* Step rail. Any completed step is clickable, so going back to fix
          something is one click and never loses what is already typed. */}
      <nav className="flex flex-wrap gap-1 mb-4">
        {STEPS.map((label, i) => (
          <button
            key={label}
            type="button"
            disabled={i > step}
            onClick={() => { setLocalErrors({}); setStep(i); }}
            className={
              'h-8 px-3 text-12 border rounded whitespace-nowrap ' +
              (i === step
                ? 'border-gold text-neutral-900 font-medium bg-white'
                : i < step
                  ? 'border-neutral-300 text-neutral-700 bg-white hover:border-neutral-400'
                  : 'border-neutral-200 text-neutral-400 bg-white')
            }
          >
            {i + 1}. {label}
          </button>
        ))}
      </nav>

      <Card>
        <div className="p-4 max-w-[760px]">
          {/* ── 1 · Client ───────────────────────────────────────────────── */}
          {step === 0 ? (
            <>
              <p className="text-13 text-neutral-500 mb-3">
                Pick an existing JNS Accounting Solutions client. Clients are created in Workstation → Clients,
                not here — one central client record, always.
              </p>
              <Field label="Find a client" error={errors.client_id}>
                <input
                  className={inputClass}
                  value={clientSearch}
                  onChange={(e) => setClientSearch(e.target.value)}
                  placeholder="Company name or client code"
                />
              </Field>
              <div className="border border-neutral-200 rounded max-h-[320px] overflow-y-auto">
                {clients.isLoading ? (
                  <div className="px-3 py-4 text-13 text-neutral-500">Loading clients…</div>
                ) : visibleClients.length === 0 ? (
                  <div className="px-3 py-4 text-13 text-neutral-500">No clients match that search.</div>
                ) : visibleClients.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => patch({ client_id: c.id })}
                    className={
                      'w-full text-left px-3 py-2 border-b border-neutral-200 last:border-b-0 hover:bg-neutral-50 ' +
                      (draft.client_id === c.id ? 'bg-neutral-50 border-l-2 border-l-gold' : '')
                    }
                  >
                    <div className="text-13 text-neutral-900">{c.company_name}</div>
                    <div className="text-12 text-neutral-500 font-mono">{c.client_id}</div>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {/* ── 2 · Entity ───────────────────────────────────────────────── */}
          {step === 1 ? (
            <>
              <Field label="Entity type" error={errors.entity_type_id}>
                <select
                  className={inputClass}
                  value={draft.entity_type_id}
                  onChange={(e) => {
                    // Changing type changes which roles are legal, so any
                    // party whose role no longer applies is reset rather than
                    // silently carried into an invalid case.
                    const et = settings.data?.entity_types.find((x) => x.id === e.target.value);
                    const allowed = et?.party_roles ?? [];
                    patch({
                      entity_type_id: e.target.value,
                      parties: draft.parties.map((p) => (allowed.includes(p.role) ? p : { ...p, role: '' })),
                    });
                  }}
                >
                  <option value="">Choose…</option>
                  {(settings.data?.entity_types ?? []).filter((e) => e.is_active).map((e) => (
                    <option key={e.id} value={e.id}>{e.name}</option>
                  ))}
                </select>
              </Field>
              {entityType ? (
                <p className="text-12 text-neutral-500 -mt-2 mb-3">
                  {entityType.description} · {entityType.min_parties}
                  {entityType.max_parties ? `–${entityType.max_parties}` : '+'} people ·
                  {' '}default target {entityType.default_target_days} days
                </p>
              ) : null}
              <Field label="Proposed name" error={errors.proposed_name}>
                <input className={inputClass} value={draft.proposed_name}
                  onChange={(e) => patch({ proposed_name: e.target.value })} />
              </Field>
              <Field label="Alternate name" error={errors.alternate_name}
                hint="A second preference, if the client has one.">
                <input className={inputClass} value={draft.alternate_name}
                  onChange={(e) => patch({ alternate_name: e.target.value })} />
              </Field>
              <Field label="Business activity" error={errors.business_activity}>
                <input className={inputClass} value={draft.business_activity}
                  onChange={(e) => patch({ business_activity: e.target.value })} />
              </Field>
              <Field label="Business category" error={errors.business_category}>
                <input className={inputClass} value={draft.business_category}
                  onChange={(e) => patch({ business_category: e.target.value })} />
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
                <Field label="State" error={errors.state}>
                  <input className={inputClass} value={draft.state}
                    onChange={(e) => patch({ state: e.target.value })} />
                </Field>
                <Field label="City" error={errors.city}>
                  <input className={inputClass} value={draft.city}
                    onChange={(e) => patch({ city: e.target.value })} />
                </Field>
              </div>
              <Field label="Registered office information" error={errors.registered_office_info}>
                <textarea className={textareaClass} rows={3} value={draft.registered_office_info}
                  onChange={(e) => patch({ registered_office_info: e.target.value })} />
              </Field>
              <Field label="Objective" error={errors.incorporation_objective}
                hint="What the client wants out of this engagement.">
                <textarea className={textareaClass} rows={2} value={draft.incorporation_objective}
                  onChange={(e) => patch({ incorporation_objective: e.target.value })} />
              </Field>
            </>
          ) : null}

          {/* ── 3 · People ───────────────────────────────────────────────── */}
          {step === 2 ? (
            <>
              <p className="text-13 text-neutral-500 mb-3">
                {entityType
                  ? `Roles below are the ones ${entityType.name} uses.`
                  : 'Choose an entity type first.'}
                {' '}Where a person is already a contact on this client, link them instead of
                typing their details again.
              </p>
              {errors.parties ? <p className="text-12 text-red mb-2">{errors.parties}</p> : null}

              {draft.parties.map((p, i) => (
                <div key={i} className="border border-neutral-200 rounded p-3 mb-3">
                  <div className="flex items-center mb-2">
                    <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">
                      Person {i + 1}
                    </span>
                    <div className="flex-1" />
                    <button
                      type="button"
                      onClick={() => patch({ parties: draft.parties.filter((_, n) => n !== i) })}
                      className="text-12 text-neutral-500 hover:text-red"
                    >
                      Remove
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
                    <Field label="Role" error={errors[`parties.${i}.role`]}>
                      <select
                        className={inputClass} value={p.role}
                        onChange={(e) => patch({
                          parties: draft.parties.map((x, n) => (n === i ? { ...x, role: e.target.value } : x)),
                        })}
                      >
                        <option value="">Choose…</option>
                        {roles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
                      </select>
                    </Field>
                    <Field label="Existing client contact" error={errors[`parties.${i}.client_contact_id`]}
                      hint="Optional — links this person to the CRM record.">
                      <select
                        className={inputClass} value={p.client_contact_id}
                        onChange={(e) => {
                          const contact = clientDetail.data?.contacts?.find((c) => c.id === e.target.value);
                          patch({
                            parties: draft.parties.map((x, n) => (n === i ? {
                              ...x,
                              client_contact_id: e.target.value,
                              // Pull their details across so nothing is re-keyed.
                              name: contact?.name ?? x.name,
                              contact_number: contact?.phone ?? x.contact_number,
                              email: contact?.email ?? x.email,
                            } : x)),
                          });
                        }}
                      >
                        <option value="">Not linked</option>
                        {(clientDetail.data?.contacts ?? []).map((c) => (
                          <option key={c.id} value={c.id}>{c.name}{c.designation ? ` · ${c.designation}` : ''}</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field label="Name" error={errors[`parties.${i}.name`]}>
                    <input className={inputClass} value={p.name}
                      onChange={(e) => patch({
                        parties: draft.parties.map((x, n) => (n === i ? { ...x, name: e.target.value } : x)),
                      })} />
                  </Field>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
                    <Field label="Contact number" error={errors[`parties.${i}.contact_number`]}>
                      <input className={inputClass} value={p.contact_number}
                        onChange={(e) => patch({
                          parties: draft.parties.map((x, n) => (n === i ? { ...x, contact_number: e.target.value } : x)),
                        })} />
                    </Field>
                    <Field label="Email" error={errors[`parties.${i}.email`]}>
                      <input className={inputClass} value={p.email}
                        onChange={(e) => patch({
                          parties: draft.parties.map((x, n) => (n === i ? { ...x, email: e.target.value } : x)),
                        })} />
                    </Field>
                  </div>
                  <label className="flex items-center gap-2 text-13 text-neutral-700">
                    <input
                      type="checkbox" checked={p.dsc_required}
                      onChange={(e) => patch({
                        parties: draft.parties.map((x, n) => (n === i ? { ...x, dsc_required: e.target.checked } : x)),
                      })}
                    />
                    DSC required for this person
                  </label>
                </div>
              ))}

              <Button
                variant="secondary"
                disabled={!entityType}
                onClick={() => patch({
                  parties: [...draft.parties, {
                    role: roles[0] ?? '', name: '', contact_number: '', email: '',
                    address: '', client_contact_id: '', dsc_required: true,
                  }],
                })}
              >
                Add a person
              </Button>
            </>
          ) : null}

          {/* ── 4 · Documents ────────────────────────────────────────────── */}
          {step === 3 ? (
            <>
              <p className="text-13 text-neutral-500 mb-3">
                These become document requests on the case. Files themselves live in the
                Documents module — this list is what the firm will ask the client for.
              </p>
              {draft.document_requests.length === 0 ? (
                <div className="border border-neutral-200 rounded px-3 py-4 mb-3 text-13 text-neutral-500">
                  No document requests yet.
                  <button
                    type="button"
                    onClick={() => patch({ document_requests: DEFAULT_DOCS.map((d) => ({ ...d })) })}
                    className="ml-2 underline text-neutral-700 hover:text-neutral-900"
                  >
                    Use the standard list
                  </button>
                </div>
              ) : null}

              {draft.document_requests.map((d, i) => (
                <div key={i} className="border border-neutral-200 rounded p-3 mb-2">
                  <div className="grid grid-cols-1 sm:grid-cols-[200px_1fr_auto] gap-x-3 items-end">
                    <Field label="Category">
                      <select
                        className={inputClass} value={d.category}
                        onChange={(e) => patch({
                          document_requests: draft.document_requests.map((x, n) => (n === i ? { ...x, category: e.target.value } : x)),
                        })}
                      >
                        {(settings.data?.vocabularies.document_categories ?? []).map((c) => (
                          <option key={c} value={c}>{titleCase(c)}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Document">
                      <input className={inputClass} value={d.document_type}
                        onChange={(e) => patch({
                          document_requests: draft.document_requests.map((x, n) => (n === i ? { ...x, document_type: e.target.value } : x)),
                        })} />
                    </Field>
                    <button
                      type="button"
                      onClick={() => patch({ document_requests: draft.document_requests.filter((_, n) => n !== i) })}
                      className="h-8 mb-3 text-12 text-neutral-500 hover:text-red"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              <Button
                variant="secondary"
                onClick={() => patch({
                  document_requests: [...draft.document_requests, { category: 'other', document_type: '', description: '' }],
                })}
              >
                Add a document
              </Button>
            </>
          ) : null}

          {/* ── 5 · Assignment ───────────────────────────────────────────── */}
          {step === 4 ? (
            <>
              <Field label="Assigned employee" error={errors.assigned_employee_id}>
                <select
                  className={inputClass} value={draft.assigned_employee_id}
                  onChange={(e) => patch({ assigned_employee_id: e.target.value })}
                >
                  <option value="">Choose…</option>
                  {(employees.data?.items ?? []).map((e) => (
                    <option key={e.id} value={e.id}>{e.full_name} · {e.designation}</option>
                  ))}
                </select>
              </Field>
              <Field label="Priority" error={errors.priority}>
                <select className={inputClass} value={draft.priority}
                  onChange={(e) => patch({ priority: e.target.value })}>
                  {(settings.data?.vocabularies.priorities ?? []).map((p) => (
                    <option key={p} value={p}>{titleCase(p)}</option>
                  ))}
                </select>
              </Field>
              <Field
                label="Target date" error={errors.target_date}
                hint={entityType
                  ? `Left blank, the case targets ${entityType.default_target_days} days from today.`
                  : undefined}
              >
                <input type="date" className={inputClass} value={draft.target_date}
                  onChange={(e) => patch({ target_date: e.target.value })} />
              </Field>
              <Field label="Internal notes" error={errors.internal_notes}>
                <textarea className={textareaClass} rows={3} value={draft.internal_notes}
                  onChange={(e) => patch({ internal_notes: e.target.value })} />
              </Field>
            </>
          ) : null}

          {/* ── 6 · Review ───────────────────────────────────────────────── */}
          {step === 5 ? (
            <>
              <p className="text-13 text-neutral-500 mb-3">
                Nothing has been created yet. The case is opened when you confirm below —
                its Case ID is allocated by the server at that moment.
              </p>
              <Detail label="Client" value={chosenClient ? `${chosenClient.company_name} · ${chosenClient.client_id}` : '—'} />
              <Detail label="Entity type" value={entityType?.name ?? '—'} />
              <Detail label="Proposed name" value={draft.proposed_name} />
              <Detail label="Alternate name" value={draft.alternate_name || '—'} />
              <Detail label="Business activity" value={draft.business_activity || '—'} />
              <Detail label="Location" value={[draft.city, draft.state].filter(Boolean).join(', ') || '—'} />
              <Detail
                label="People"
                value={draft.parties.length === 0 ? '—' : (
                  <ul className="space-y-1">
                    {draft.parties.map((p, i) => (
                      <li key={i}>
                        {p.name} · {roleLabel(p.role)}
                        {p.dsc_required ? ' · DSC required' : ''}
                        {p.client_contact_id ? ' · linked to a client contact' : ''}
                      </li>
                    ))}
                  </ul>
                )}
              />
              <Detail
                label="Documents to request"
                value={draft.document_requests.length === 0 ? '—' : (
                  <ul className="space-y-1">
                    {draft.document_requests.filter((d) => d.document_type.trim()).map((d, i) => (
                      <li key={i}>{d.document_type} <span className="text-neutral-500">· {titleCase(d.category)}</span></li>
                    ))}
                  </ul>
                )}
              />
              <Detail
                label="Assigned to"
                value={(employees.data?.items ?? []).find((e) => e.id === draft.assigned_employee_id)?.full_name ?? '—'}
              />
              <Detail label="Priority" value={titleCase(draft.priority)} />
              <Detail label="Target date" value={draft.target_date || `Default (${entityType?.default_target_days ?? 30} days)`} />
              <Detail label="Checklist" value={`Instantiated from the ${entityType?.name ?? 'entity type'} template when the case is created.`} />

              {create.isError && Object.keys(serverErrors).length === 0 ? (
                <p className="text-13 text-red mt-3">{(create.error as Error).message}</p>
              ) : null}
              {Object.keys(serverErrors).length > 0 ? (
                <p className="text-13 text-red mt-3">
                  The server rejected some fields — step back to correct the highlighted ones.
                </p>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="px-4 py-3 border-t border-neutral-200 flex items-center gap-2">
          <Button variant="secondary" onClick={back} disabled={step === 0}>Back</Button>
          <div className="flex-1" />
          {step < STEPS.length - 1 ? (
            <Button onClick={next}>Continue</Button>
          ) : (
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create case'}
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
