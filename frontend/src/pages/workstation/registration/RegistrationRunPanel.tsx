/**
 * The three-step strip on a registration's page:
 *
 *   1  pick the client          — who this registration is for
 *   2  open the official portal — a new tab; the work happens there
 *   3  record what came back    — filed against that client's documents
 *
 * Step 3 writes through the EXISTING client-documents API, so the record
 * lands in the same place Workstation → Documents reads from. It is not a
 * new store and it is not a registration engine.
 *
 * HONEST LIMIT: this build has no file storage — the server records a
 * document and its versions as metadata, with no bytes behind them (see
 * backend/src/modules/workstation/documents.routes.ts). The panel says so
 * rather than showing a progress bar that implies otherwise.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, FileText, FileUp, Search } from 'lucide-react';
import { workstationApi } from '@/modules/workstation/api';
import { useToast } from '@/components/Toast';
import { fmtDate } from '@/lib/format';
import { MINIMAL_REGISTRATION_PAGES, type RegistrationService } from './services';
import { CREDENTIAL_REGISTRATIONS } from '@/modules/registrationCredentials/api';
import { RegistrationCredentialsCard } from './RegistrationCredentialsCard';
// Government-portal autofill (Phase 1) — remove with src/modules/portalAutofill.
import { OpenWithAutofill } from '@/modules/portalAutofill/GovernmentPortals';
import { portalForSlug } from '@/modules/portalAutofill/api';

/** GST work files under the GST category; everything else under Basic. */
function categoryFor(slug: string): string {
  return slug === 'gst' ? 'gst' : 'basic';
}

export function RegistrationRunPanel({ service }: { service: RegistrationService }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [clientId, setClientId] = useState('');
  const [notes, setNotes] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  const clientsQ = useQuery({
    queryKey: ['workstation', 'clients', { for: 'registration' }],
    queryFn: () => workstationApi.listClients({}),
  });
  const categoriesQ = useQuery({
    queryKey: ['workstation', 'document-categories'],
    queryFn: workstationApi.documentCategories,
  });

  const clients = clientsQ.data?.items ?? [];
  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () => (needle
      ? clients.filter((c) =>
          c.company_name.toLowerCase().includes(needle) ||
          (c.client_id ?? '').toLowerCase().includes(needle))
      : clients).slice(0, 8),
    [clients, needle],
  );
  const client = clients.find((c) => c.id === clientId) ?? null;

  // That client's documents, so step 3 shows what is already on file.
  const docsQ = useQuery({
    queryKey: ['workstation', 'client-documents', clientId],
    queryFn: () => workstationApi.clientDocuments(clientId),
    enabled: !!clientId,
  });
  const related = (docsQ.data?.items ?? []).filter((d) =>
    d.name.toLowerCase().includes(service.shortName.toLowerCase()) ||
    d.name.toLowerCase().includes('registration'));

  // A client holds ONE of each certificate, so recording a second time is a
  // re-issue, not a second document: the existing record gets another version.
  // Creating a fresh document each press would leave five identical rows on
  // the client and no way to tell which one is current.
  const existing = (docsQ.data?.items ?? []).find((d) => d.name === service.outputDocument) ?? null;

  const record = useMutation({
    mutationFn: async () => {
      let doc = existing;
      if (!doc) {
        const cats = categoriesQ.data?.items ?? [];
        const wanted = categoryFor(service.slug);
        const cat = cats.find((c) => c.code === wanted) ?? cats.find((c) => c.code === 'other') ?? cats[0];
        if (!cat) throw new Error('No document category is configured.');
        doc = await workstationApi.requestDocument(clientId, {
          name: service.outputDocument,
          category_id: cat.id,
          // The server's vocabulary — 'uploaded' is the state a document is in
          // once it exists but no one has verified it yet.
          status: 'uploaded',
        });
      }
      // A document starts at version 0; the version is what carries the file.
      // On an existing record this bumps it and resets it to unverified, which
      // is correct — a re-issued certificate has not been checked either.
      return workstationApi.addDocumentVersion(doc.id, { notes: notes.trim() || undefined });
    },
    onSuccess: (doc) => {
      setNotes('');
      qc.invalidateQueries({ queryKey: ['workstation', 'client-documents', clientId] });
      qc.invalidateQueries({ queryKey: ['workstation', 'documents'] });
      toast.push(
        'success',
        doc.version > 1
          ? `${service.outputDocument} updated to v${doc.version} for ${client?.company_name ?? 'the client'}.`
          : `${service.outputDocument} recorded against ${client?.company_name ?? 'the client'}.`,
      );
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const portalDisabled = !service.portalUrl;

  return (
    <section className="dash-card overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-neutral-100">
        <h2 className="text-14 font-semibold text-neutral-900 flex-1">Run {service.shortName} for a client</h2>
        <span className="text-12 text-neutral-500">{client ? <>For <span className="font-semibold text-neutral-900">{client.company_name}</span></> : 'Pick a client to begin'}</span>
      </div>
      <div className="reg-steps p-5 m-form">
        {/* ── 1 · client ─────────────────────────────────────────────── */}
        <Step n={1} title="Choose the client" done={!!client} active>
          {client ? (
            /* Chosen: one compact card, with Change to pick another. */
            <div className="reg-client is-picked flex items-center gap-3 px-4 py-3 rounded-lg">
              <span className="reg-client-tick h-6 w-6 rounded-full inline-flex items-center justify-center shrink-0" aria-hidden>
                <Check size={13} strokeWidth={3} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-14 font-semibold text-neutral-900 truncate">{client.company_name}</span>
                <span className="block text-12 text-neutral-500 mt-0.5">{client.client_id}</span>
              </span>
              <button
                type="button"
                onClick={() => { setClientId(''); setQuery(''); setPickerOpen(true); }}
                className="h-8 px-3 text-12 font-medium text-primary bg-white border border-neutral-200 rounded-lg hover:border-primary/40 hover:bg-[#f4f7fb]"
              >
                Change
              </button>
            </div>
          ) : (
            /* Searchable picker: type an ID or name; matches drop down below.
               Scales to any number of clients — only the best matches show. */
            <div className="relative" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPickerOpen(false); }}>
              <Search
                size={16}
                strokeWidth={1.75}
                className="absolute left-3 top-[20px] -translate-y-1/2 text-neutral-400 pointer-events-none"
                aria-hidden
              />
              <input
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPickerOpen(true); }}
                onFocus={() => setPickerOpen(true)}
                placeholder={`Search ${clients.length || ''} clients by ID or company name`.replace('  ', ' ')}
                aria-label="Find a client by ID or name"
                role="combobox"
                aria-expanded={pickerOpen}
                className="w-full h-10 pl-9 pr-3 text-13 bg-white text-neutral-900 border border-neutral-200 rounded-lg focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/10"
              />
              {pickerOpen ? (
                <div role="listbox" className="absolute left-0 right-0 top-full mt-1 z-20 bg-white border border-neutral-200 rounded-lg shadow-raised p-1 max-h-[280px] overflow-y-auto">
                  {clientsQ.isLoading ? (
                    <div className="px-3 py-3 text-13 text-neutral-500">Loading clients…</div>
                  ) : matches.length === 0 ? (
                    <div className="px-3 py-3 text-13 text-neutral-500">No client matches that.</div>
                  ) : matches.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="option"
                      aria-selected={false}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { setClientId(c.id); setPickerOpen(false); }}
                      className="reg-option w-full text-left flex items-center gap-3 px-3 py-2 rounded-md"
                    >
                      <span className="min-w-0 flex-1 text-13 font-medium truncate">{c.company_name}</span>
                      <span className="text-11 shrink-0 opacity-70">{c.client_id}</span>
                    </button>
                  ))}
                  {!clientsQ.isLoading && clients.length > matches.length ? (
                    <div className="px-3 pt-2 pb-1 text-11 text-neutral-400">Showing {matches.length} of {clients.length} — type to narrow down.</div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </Step>

        {/* Saved login / reference details for this client — entered once,
            shown every time after. */}
        {client && CREDENTIAL_REGISTRATIONS.has(service.slug) ? (
          <RegistrationCredentialsCard
            key={`${service.slug}:${client.id}`}
            type={service.slug}
            client={{ id: client.id, company_name: client.company_name }}
          />
        ) : null}

        {/* ── 2 · portal ─────────────────────────────────────────────── */}
        <Step n={2} title="Open the official portal" done={false} active={!!client}>
          {portalDisabled ? (
            /* No registration currently sets portalUrl to null. The branch
               stays as the guard for any registration that genuinely has
               nowhere to go, so a null can never render a dead button. */
            <p className="text-13 text-neutral-600">
              There is no portal for this one. Use{' '}
              <Link to="/workstation/services/registration/gst" className="text-primary font-medium">GST</Link>{' '}
              or{' '}
              <Link to="/workstation/services/registration/msme-udyam" className="text-primary font-medium">MSME UDYAM</Link>{' '}
              to give the business a registered identity.
            </p>
          ) : (
            <>
              <p className="text-13 text-neutral-600 mb-2">
                Opens in a new tab. Do the filing there, then come back to step 3
                {client ? '.' : ' — you can look around the portal before picking a client.'}
              </p>
              {/* Never gated on step 1. The portal is the department's own
                  site and an employee has every reason to open it before
                  picking a client — to check a fee, a form, a threshold.
                  Choosing a client is required to RECORD the outcome (step 3),
                  not to look something up. */}
              <a
                href={service.portalUrl!}
                target="_blank"
                rel="noopener noreferrer"
                className={
                  'inline-flex items-center gap-2 h-10 px-5 text-14 font-medium rounded-lg shadow-card ' +
                  'text-white bg-primary hover:bg-primaryHover'
                }
              >
                <ExternalLink size={16} strokeWidth={2} />
                {client ? `Visit portal for ${client.client_id}` : 'Visit portal'}
              </a>
              {client && portalForSlug(service.slug) ? (
                <OpenWithAutofill clientId={client.id} registrationId={portalForSlug(service.slug)!.registrationId} portalId={portalForSlug(service.slug)!.portalId} />
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-2 text-12 text-neutral-500">
                <span>{service.portalLabel}</span>
                <span className="inline-flex items-center h-6 px-3 rounded-full bg-[#f1f4f9] text-neutral-700 break-all">{service.portalUrl!.replace(/^https?:\/\//, '')}</span>
              </div>
            </>
          )}
        </Step>

        {/* ── 3 · record ─────────────────────────────────────────────── */}
        <Step n={3} title="Record what the portal returned" done={!!existing} active={!!client} last>
          <p className="text-13 text-neutral-600 mb-2">
            Files it against{' '}
            <span className="font-medium text-neutral-900">{client?.company_name ?? 'the client'}</span>{' '}
            as <span className="font-medium text-neutral-900">{service.outputDocument}</span>, where
            Workstation → Documents reads it.
            {existing ? (
              <>
                {' '}This client already holds one at v{existing.version} — recording again adds
                v{existing.version + 1} to that record rather than a second copy.
              </>
            ) : null}
          </p>
          <label className="block">
            <span className="block text-12 font-medium text-neutral-500 mb-1">
              Reference or note (optional)
            </span>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. GSTIN 33AAAAA0000A1Z5 · issued 11 Sep 2026"
              className="w-full h-10 px-3 text-13 bg-white text-neutral-900 border border-neutral-200 rounded-lg focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/10"
            />
          </label>
          <button
            type="button"
            onClick={() => record.mutate()}
            disabled={!client || record.isPending}
            className={
              'mt-3 inline-flex items-center gap-2 h-10 px-5 text-14 font-medium rounded-lg shadow-card ' +
              'text-white bg-primary hover:bg-primaryHover disabled:opacity-50 disabled:cursor-not-allowed'
            }
          >
            <FileUp size={16} strokeWidth={2} />
            {record.isPending ? 'Recording…'
              : existing ? `Record re-issue as v${existing.version + 1}`
              : 'Add to client documents'}
          </button>
          {MINIMAL_REGISTRATION_PAGES.has(service.slug) ? null : (
            <p className="text-12 text-neutral-500 mt-2">
              This build stores no file bytes — the document and its version are recorded as metadata,
              the same as everywhere else in Workstation. Attaching the actual PDF needs file storage,
              which is not built yet.
            </p>
          )}

          {client ? (
            <div className="mt-5">
              <div className="text-13 font-semibold text-neutral-900 mb-2">
                On file for {client.client_id}
              </div>
              {docsQ.isLoading ? (
                <div className="text-13 text-neutral-500">Loading…</div>
              ) : related.length === 0 ? (
                <div className="text-13 text-neutral-500">Nothing recorded for this registration yet.</div>
              ) : (
                <ul className="space-y-2">
                  {related.slice(0, 6).map((d) => (
                    <li key={d.id} className="dash-row px-3 py-2 flex items-center gap-3 rounded-lg">
                      <span className="h-8 w-8 rounded-lg inline-flex items-center justify-center shrink-0" style={{ background: '#eaf0f8', color: '#1a4b8c' }}>
                        <FileText size={15} strokeWidth={1.9} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-13 text-neutral-900 truncate">{d.name}</span>
                        <span className="block text-12 text-neutral-500">
                          v{d.version} · {d.status.replace(/_/g, ' ')}
                          {d.requested_at ? ` · ${fmtDate(d.requested_at)}` : ''}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Link
                to={`/workstation/clients/${client.id}/documents`}
                className="inline-flex items-center min-h-[44px] md:min-h-0 mt-2 text-13 text-primary font-medium"
              >
                Open this client's document section
              </Link>
            </div>
          ) : null}
        </Step>
      </div>
    </section>
  );
}

/**
 * One step on the vertical rail: a numbered dot (a tick once done), its
 * title, and the step's content indented beside the rail.
 */
function Step({
  n, title, done, active = true, last = false, children,
}: {
  n: number; title: string; done: boolean; active?: boolean; last?: boolean; children: React.ReactNode;
}) {
  return (
    <section className={'reg-step relative ' + (last ? '' : 'pb-6')}>
      {last ? null : <span className="reg-rail" aria-hidden />}
      <div className="flex items-center gap-3 mb-3">
        <span className={'reg-dot ' + (done ? 'is-done' : active ? 'is-active' : '')} aria-hidden>
          {done ? <Check size={13} strokeWidth={3} /> : n}
        </span>
        <h3 className="text-14 font-semibold text-neutral-900">{title}</h3>
        {done ? <span className="inline-flex items-center h-6 px-3 rounded-full text-11 font-semibold bg-[#ecfdf5] text-[#047857]">Done</span> : null}
      </div>
      <div className="pl-10">{children}</div>
    </section>
  );
}
