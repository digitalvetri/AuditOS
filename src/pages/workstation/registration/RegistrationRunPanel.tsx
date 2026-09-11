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
 * server/src/modules/workstation/documents.routes.ts). The panel says so
 * rather than showing a progress bar that implies otherwise.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileUp, Search } from 'lucide-react';
import { workstationApi } from '@/modules/workstation/api';
import { Card } from '@/modules/workstation/components';
import { useToast } from '@/components/Toast';
import { fmtDate } from '@/lib/format';
import type { RegistrationService } from './services';

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
    <Card title={`Run ${service.shortName} for a client`}>
      <div className="p-4 space-y-5 m-form">
        {/* ── 1 · client ─────────────────────────────────────────────── */}
        <Step n={1} title="Choose the client" done={!!client}>
          <div className="relative">
            <Search
              size={16}
              strokeWidth={1.75}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 pointer-events-none"
              aria-hidden
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Client ID or company name"
              aria-label="Find a client by ID or name"
              className="w-full h-10 pl-9 pr-3 text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-primary"
            />
          </div>
          <div className="mt-2 border border-neutral-200 rounded max-h-[220px] overflow-y-auto">
            {clientsQ.isLoading ? (
              <div className="px-3 py-4 text-13 text-neutral-500">Loading clients…</div>
            ) : matches.length === 0 ? (
              <div className="px-3 py-4 text-13 text-neutral-500">No client matches that.</div>
            ) : matches.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setClientId(c.id)}
                className={
                  'w-full text-left px-3 py-2 min-h-[44px] border-b border-neutral-200 last:border-b-0 ' +
                  'hover:bg-neutral-50 border-l-2 ' +
                  (clientId === c.id ? 'bg-neutral-50 border-l-primary' : 'border-l-transparent')
                }
              >
                <div className="text-13 text-neutral-900">{c.company_name}</div>
                <div className="text-12 text-neutral-500 font-mono">{c.client_id}</div>
              </button>
            ))}
          </div>
        </Step>

        {/* ── 2 · portal ─────────────────────────────────────────────── */}
        <Step n={2} title="Open the official portal" done={false}>
          {portalDisabled ? (
            /* No registration currently sets portalUrl to null — Proprietorship,
               the one that used to, now points at the GST portal. The branch
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
                  'inline-flex items-center gap-2 h-10 px-4 text-14 font-medium rounded-md ' +
                  'text-white bg-primary hover:bg-primaryHover'
                }
              >
                <ExternalLink size={16} strokeWidth={2} />
                {client ? `Visit portal for ${client.client_id}` : 'Visit portal'}
              </a>
              <div className="text-12 text-neutral-500 mt-2 break-words">
                {service.portalLabel} ·{' '}
                <span className="font-mono">{service.portalUrl!.replace(/^https?:\/\//, '')}</span>
              </div>
            </>
          )}
        </Step>

        {/* ── 3 · record ─────────────────────────────────────────────── */}
        <Step n={3} title="Record what the portal returned" done={false} last>
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
            <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">
              Reference or note (optional)
            </span>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. GSTIN 33AAAAA0000A1Z5 · issued 11 Sep 2026"
              className="w-full h-10 px-3 text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-primary"
            />
          </label>
          <button
            type="button"
            onClick={() => record.mutate()}
            disabled={!client || record.isPending}
            className={
              'mt-3 inline-flex items-center gap-2 h-10 px-4 text-14 font-medium rounded-md ' +
              'text-white bg-primary hover:bg-primaryHover disabled:opacity-50 disabled:cursor-not-allowed'
            }
          >
            <FileUp size={16} strokeWidth={2} />
            {record.isPending ? 'Recording…'
              : existing ? `Record re-issue as v${existing.version + 1}`
              : 'Add to client documents'}
          </button>
          <p className="text-12 text-neutral-500 mt-2">
            This build stores no file bytes — the document and its version are recorded as metadata,
            the same as everywhere else in Workstation. Attaching the actual PDF needs file storage,
            which is not built yet.
          </p>

          {client ? (
            <div className="mt-4">
              <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">
                On file for {client.client_id}
              </div>
              {docsQ.isLoading ? (
                <div className="text-13 text-neutral-500">Loading…</div>
              ) : related.length === 0 ? (
                <div className="text-13 text-neutral-500">Nothing recorded for this registration yet.</div>
              ) : (
                <ul className="border border-neutral-200 rounded divide-y divide-neutral-200">
                  {related.slice(0, 6).map((d) => (
                    <li key={d.id} className="px-3 py-2 flex items-center gap-3">
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
    </Card>
  );
}

function Step({
  n, title, done, last = false, children,
}: {
  n: number; title: string; done: boolean; last?: boolean; children: React.ReactNode;
}) {
  return (
    <section className={last ? '' : 'pb-5 border-b border-neutral-200'}>
      <div className="flex items-center gap-2 mb-2">
        <span
          className={
            'inline-flex items-center justify-center w-6 h-6 rounded-full text-12 font-semibold shrink-0 ' +
            (done ? 'bg-primary text-white' : 'bg-neutral-100 text-neutral-600')
          }
          aria-hidden
        >
          {n}
        </span>
        <h3 className="text-14 font-semibold text-neutral-900">{title}</h3>
      </div>
      <div className="pl-8">{children}</div>
    </section>
  );
}
