/**
 * Organization Documents — one view of every document held for an
 * organization and its clients, filterable by type ("show me all E-Way Bills
 * for this organization") and by client. Every row names the client it
 * belongs to; nothing is copied or moved.
 *
 *   - Upload: "Store Document For" picks the organization or one client; the
 *     file lands in that client's own folders.
 *   - Requests are raised on the organization (its Documents tab). When the
 *     file arrives, "Receive" stores it for the right client.
 *   - Select + Merge builds one PDF and, by default, saves it as a new
 *     document in Organization Documents. The originals are untouched.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Building2, Combine, Download, Inbox, Upload } from 'lucide-react';
import { workstationApi } from '../api';
import { Field, Modal, QueryState, Status, inputClass } from '../components';
import { SearchBox } from '../listUi';
import type {
  ClientDetail, OrganizationDocType, OrganizationDocument, OrganizationDocuments as Docs,
} from '../types';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';
import { fmtDate } from '@/lib/format';
import { LevelBanner } from './OrganizationOverview';

/** Where an upload of each type lands — mirrors UPLOAD_FOLDER_FOR_TYPE on the server. */
const UPLOAD_FOLDER: Record<OrganizationDocType, string> = {
  gst: 'uploads:gst', eway: 'eway', einvoice: 'einvoice', tds: 'uploads:tds',
  invoices: 'invoices', returns: 'gst_returns', other: 'uploads:other',
};
const UPLOAD_ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt,.json,.xml,.zip';
const ORG = '__organization__';

const selectable = (d: OrganizationDocument) => d.openable === 'pdf' || d.openable === 'file';
const keyOf = (d: OrganizationDocument) => `${d.client_id}:${d.source}:${d.id}`;
/** An organization request still waiting for its file. */
const awaiting = (d: OrganizationDocument) =>
  d.is_organization_level && d.source === 'upload' && d.openable === 'none' && !d.stored_for && !!d.document_id;

export function OrganizationDocuments({ org }: { org: ClientDetail }) {
  const { session } = useAuth();
  const role = session?.role.code;
  const canManage = can(role, 'workstation.document.manage', 'self');
  const toast = useToast();
  const [type, setType] = useState<'all' | OrganizationDocType>('all');
  const [clientFilter, setClientFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Map<string, OrganizationDocument>>(new Map());
  const [mergeOpen, setMergeOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [receiving, setReceiving] = useState<OrganizationDocument | null>(null);

  const q = useQuery({
    queryKey: ['workstation', 'organization', org.id, 'documents', type],
    queryFn: () => workstationApi.organizationDocuments(org.id, type),
  });

  async function open(d: OrganizationDocument) {
    if (!selectable(d)) return;
    const win = window.open('about:blank', '_blank');
    try {
      const { url } = await workstationApi.openClientDocument(d.client_id, d.source, d.id);
      if (win) win.location.href = url;
      else window.location.href = url;
    } catch (e) {
      win?.close();
      toast.push('error', (e as Error).message);
    }
  }

  return (
    <QueryState query={q}>
      {(data: Docs) => {
        const term = search.trim().toLowerCase();
        const rows = data.items
          .filter((d) => !clientFilter || (clientFilter === ORG ? d.is_organization_level : d.client_id === clientFilter))
          .filter((d) => !term || [d.title, d.subtitle ?? '', d.client_name, d.folder_label].some((v) => v.toLowerCase().includes(term)));
        const pickable = rows.filter(selectable);
        const allOn = pickable.length > 0 && pickable.every((d) => selected.has(keyOf(d)));
        const toggle = (d: OrganizationDocument) => setSelected((cur) => {
          const next = new Map(cur);
          if (next.has(keyOf(d))) next.delete(keyOf(d)); else next.set(keyOf(d), d);
          return next;
        });
        const toggleAll = () => setSelected((cur) => {
          const next = new Map(cur);
          for (const d of pickable) { if (allOn) next.delete(keyOf(d)); else next.set(keyOf(d), d); }
          return next;
        });
        const typeLabel = type === 'all' ? 'Documents' : data.types.find((t) => t.key === type)?.label ?? 'Documents';
        const waiting = data.items.filter(awaiting);

        return (
          <div className="space-y-4">
            <LevelBanner level="organization" name={org.company_name} />

            {waiting.length > 0 && canManage ? (
              <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
                <div className="flex items-center gap-2 text-13 font-semibold text-neutral-900">
                  <Inbox size={15} className="text-warning" /> {waiting.length} request{waiting.length === 1 ? '' : 's'} sent to the organization, awaiting files
                </div>
                <ul className="mt-2 space-y-1">
                  {waiting.map((d) => (
                    <li key={d.id} className="flex items-center gap-3 text-13">
                      <span className="flex-1 min-w-0 truncate">{d.title} <span className="text-neutral-500">· {d.folder_label}</span></span>
                      <Button onClick={() => setReceiving(d)}>Receive &amp; store…</Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Type tabs: All · GST · E-Way Bill · E-Invoice · TDS · Invoices · Returns · Other */}
            <div className="flex flex-wrap gap-1 border-b border-neutral-200" role="tablist" aria-label="Document type">
              {[{ key: 'all' as const, label: 'All' }, ...data.types].map((t) => (
                <button
                  key={t.key} type="button" role="tab" aria-selected={type === t.key}
                  onClick={() => { setType(t.key); setSelected(new Map()); }}
                  className={'px-3 h-9 text-13 -mb-px border-b-2 ' + (type === t.key ? 'border-primary text-primary font-semibold' : 'border-transparent text-neutral-600 hover:text-neutral-900')}
                >
                  {t.label} <span className="text-11 text-neutral-400 tabular-nums">{data.counts[t.key] ?? 0}</span>
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <SearchBox value={search} onChange={setSearch} placeholder="Document or client" />
              <select aria-label="Client" className={inputClass + ' !w-auto'} value={clientFilter} onChange={(e) => setClientFilter(e.target.value)}>
                <option value="">All clients</option>
                <option value={ORG}>Organization documents only</option>
                {data.clients.filter((c) => !c.is_organization).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <div className="flex-1" />
              {canManage ? (
                <Link to={`/workstation/clients/${org.id}/documents`} className="text-13 text-primary hover:underline">
                  Request documents from the organization
                </Link>
              ) : null}
              {canManage && data.can_upload ? (
                <Button onClick={() => setUploadOpen(true)}><Upload size={14} /> Upload</Button>
              ) : null}
            </div>

            {selected.size > 0 ? (
              <div className="sticky top-2 z-10 flex items-center gap-3 rounded-lg bg-neutral-900 text-white px-4 py-2 text-13">
                <span>{selected.size} selected</span>
                <span className="text-white/60">from {new Set([...selected.values()].map((d) => d.client_name)).size} client(s)</span>
                <div className="flex-1" />
                <button type="button" className="text-white/80 hover:text-white" onClick={() => setSelected(new Map())}>Clear</button>
                <button
                  type="button" disabled={selected.size < 2}
                  onClick={() => setMergeOpen(true)}
                  className="inline-flex items-center gap-1 rounded-md bg-white text-neutral-900 px-3 h-8 font-medium disabled:opacity-50"
                  title={selected.size < 2 ? 'Select at least two documents' : undefined}
                >
                  <Combine size={14} /> Merge
                </button>
              </div>
            ) : null}

            <div className="bg-white border border-neutral-200 rounded-lg overflow-x-auto">
              <table className="w-full text-13">
                <thead>
                  <tr className="text-left text-11 uppercase tracking-[0.04em] text-neutral-500 border-b border-neutral-200">
                    <th className="w-10 px-3 py-2">
                      <input type="checkbox" aria-label="Select all" checked={allOn} disabled={pickable.length === 0} onChange={toggleAll} />
                    </th>
                    <th className="px-3 py-2">Document</th>
                    <th className="px-3 py-2">Client</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Uploaded by</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={8} className="px-3 py-8 text-center text-neutral-500">No {typeLabel.toLowerCase()} for this selection.</td></tr>
                  ) : rows.map((d) => (
                    <tr key={keyOf(d)} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox" aria-label={`Select ${d.title}`}
                          disabled={!selectable(d)} checked={selected.has(keyOf(d))} onChange={() => toggle(d)}
                        />
                      </td>
                      <td className="px-3 py-2 min-w-[200px]">
                        <div className="font-medium text-neutral-900">{d.title}</div>
                        {d.subtitle ? <div className="text-11 text-neutral-500">{d.subtitle}</div> : null}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {d.is_organization_level ? (
                          <span className="inline-flex items-center gap-1 text-11 font-semibold px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                            <Building2 size={11} /> Organization
                          </span>
                        ) : (
                          <Link to={`/workstation/clients/${d.client_id}/documents`} className="text-neutral-800 hover:underline">{d.client_name}</Link>
                        )}
                      </td>
                      <td className="px-3 py-2 text-neutral-600 whitespace-nowrap">{d.folder_label}</td>
                      <td className="px-3 py-2 text-neutral-600 whitespace-nowrap">{d.date ? fmtDate(d.date) : '—'}</td>
                      <td className="px-3 py-2 text-neutral-600 whitespace-nowrap">{d.uploaded_by ?? (d.source === 'upload' ? '—' : 'Generated')}</td>
                      <td className="px-3 py-2">{d.status ? <Status value={d.status} /> : null}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {selectable(d) ? (
                          <button type="button" className="text-primary hover:underline" onClick={() => void open(d)}>Open</button>
                        ) : awaiting(d) && canManage ? (
                          <button type="button" className="text-primary hover:underline" onClick={() => setReceiving(d)}>Receive…</button>
                        ) : d.openable === 'record' ? (
                          <Link to={`/workstation/clients/${d.client_id}/documents`} className="text-primary hover:underline">View</Link>
                        ) : <span className="text-neutral-400">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <MergeModal
              org={org} open={mergeOpen} items={[...selected.values()]} defaultTitle={`Consolidated ${typeLabel}`}
              onClose={() => setMergeOpen(false)} onDone={() => { setMergeOpen(false); setSelected(new Map()); }}
            />
            <UploadModal org={org} data={data} open={uploadOpen} defaultType={type === 'all' ? 'other' : type} onClose={() => setUploadOpen(false)} />
            <ReceiveModal org={org} data={data} request={receiving} onClose={() => setReceiving(null)} />
          </div>
        );
      }}
    </QueryState>
  );
}

function MergeModal({ org, open, items, defaultTitle, onClose, onDone }: {
  org: ClientDetail; open: boolean; items: OrganizationDocument[]; defaultTitle: string;
  onClose: () => void; onDone: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { session } = useAuth();
  const canStore = can(session?.role.code, 'workstation.document.manage', 'self');
  const [title, setTitle] = useState('');
  const [store, setStore] = useState(true);
  const [busy, setBusy] = useState(false);
  const clients = useMemo(() => [...new Set(items.map((d) => d.is_organization_level ? 'Organization' : d.client_name))], [items]);
  const payload = items.map((d) => ({ client_id: d.client_id, source: d.source, ref: d.id }));
  const finalTitle = title.trim() || defaultTitle;

  async function run() {
    setBusy(true);
    try {
      if (store && canStore) {
        const r = await workstationApi.mergeOrganizationDocumentsToStore(org.id, payload, finalTitle);
        void qc.invalidateQueries({ queryKey: ['workstation'] });
        toast.push(r.skipped ? 'error' : 'success', r.skipped
          ? `Saved "${r.name}" — ${r.skipped} document(s) could not be included (marked inside the file).`
          : `Saved "${r.name}" (${r.pages} pages) to Organization Documents. Originals are unchanged.`);
      } else {
        const win = window.open('about:blank', '_blank');
        const { blob, fileName, skipped } = await workstationApi.mergeOrganizationDocumentsToFile(org.id, payload, finalTitle);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = fileName; document.body.appendChild(a); a.click(); a.remove();
        if (win) win.location.href = url;
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        toast.push(skipped ? 'error' : 'success', skipped ? `Merged with ${skipped} document(s) left out.` : `Merged ${items.length} documents.`);
      }
      onDone();
    } catch (e) {
      toast.push('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open} title="Merge into one document" onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || items.length < 2} onClick={() => void run()}>
          {busy ? 'Merging…' : store && canStore ? 'Merge & save' : <><Download size={14} /> Merge & download</>}
        </Button>
      </>}
    >
      <p className="text-13 text-neutral-700 mb-3">
        {items.length} documents from {clients.join(', ')} will be combined into one PDF, in the order shown.
        The original documents stay exactly where they are.
      </p>
      <Field label="Title">
        <input className={inputClass} value={title} placeholder={defaultTitle} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <p className="text-12 text-neutral-500 -mt-2 mb-3">Saved as “{org.company_name} - {finalTitle}.pdf”.</p>
      {canStore ? (
        <label className="flex items-start gap-2 text-13">
          <input type="checkbox" className="mt-[3px]" checked={store} onChange={(e) => setStore(e.target.checked)} />
          <span>
            Save to <b>Organization Documents</b> (Consolidated)
            <span className="block text-12 text-neutral-500">Untick to download the file without saving it.</span>
          </span>
        </label>
      ) : null}
    </Modal>
  );
}

/** "Store Document For" — the organization or one of its clients. */
function StoreForPicker({ data, value, onChange }: { data: Docs; value: string; onChange: (v: string) => void }) {
  return (
    <div className="max-h-[220px] overflow-y-auto rounded-lg border border-neutral-200 divide-y divide-neutral-100" role="radiogroup" aria-label="Store document for">
      {data.clients.map((c) => (
        <label key={c.id} className={'flex items-center gap-2 px-3 py-2 text-13 cursor-pointer ' + (value === c.id ? 'bg-primary/5' : 'hover:bg-neutral-50')}>
          <input type="radio" name="store_for" checked={value === c.id} onChange={() => onChange(c.id)} />
          {c.is_organization
            ? <span className="inline-flex items-center gap-1 font-medium"><Building2 size={13} className="text-primary" /> Organization — Organization Documents</span>
            : <span>{c.name} <span className="font-mono text-11 text-neutral-400">{c.client_id}</span></span>}
        </label>
      ))}
    </div>
  );
}

function UploadModal({ org, data, open, defaultType, onClose }: {
  org: ClientDetail; data: Docs; open: boolean; defaultType: OrganizationDocType; onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [target, setTarget] = useState(org.id);
  const [docType, setDocType] = useState<OrganizationDocType | ''>('');
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const effectiveType = docType || defaultType;
  const targetName = data.clients.find((c) => c.id === target);

  const upload = useMutation({
    mutationFn: () => workstationApi.uploadToFolder(target, UPLOAD_FOLDER[effectiveType], file!, name.trim() || undefined),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', `${r.name} stored for ${targetName?.is_organization ? 'the organization' : targetName?.name}.`);
      setFile(null); setName(''); setDocType('');
      onClose();
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  return (
    <Modal
      open={open} title="Upload document" onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!file || upload.isPending} onClick={() => upload.mutate()}>
          {upload.isPending ? 'Uploading…' : 'Upload'}
        </Button>
      </>}
    >
      <Field label="Store Document For" hint="The file is stored with the client you pick — never shared between clients.">
        <StoreForPicker data={data} value={target} onChange={setTarget} />
      </Field>
      <Field label="Document Type">
        <select className={inputClass} value={effectiveType} onChange={(e) => setDocType(e.target.value as OrganizationDocType)}>
          {data.types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
      </Field>
      <Field label="Name" hint="Optional — defaults to the file name.">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="File">
        <input type="file" accept={UPLOAD_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
    </Modal>
  );
}

function ReceiveModal({ org, data, request, onClose }: {
  org: ClientDetail; data: Docs; request: OrganizationDocument | null; onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [target, setTarget] = useState(org.id);
  const [file, setFile] = useState<File | null>(null);

  const receive = useMutation({
    mutationFn: () => workstationApi.receiveOrganizationRequest(org.id, request!.document_id!, file!, target),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', `${request?.title} received and stored for ${r.stored_for.client_id === org.id ? 'the organization' : r.stored_for.client_name}.`);
      setFile(null); setTarget(org.id);
      onClose();
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  return (
    <Modal
      open={!!request} title="Receive requested document" onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!file || receive.isPending} onClick={() => receive.mutate()}>
          {receive.isPending ? 'Saving…' : 'Store document'}
        </Button>
      </>}
    >
      <p className="text-13 text-neutral-700 mb-3">
        <b>{request?.title}</b> was requested from <b>{org.company_name}</b>. Choose where the received file belongs —
        the request stays on the organization and shows where it was stored.
      </p>
      <Field label="Store Document For">
        <StoreForPicker data={data} value={target} onChange={setTarget} />
      </Field>
      <Field label="File">
        <input type="file" accept={UPLOAD_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
    </Modal>
  );
}
