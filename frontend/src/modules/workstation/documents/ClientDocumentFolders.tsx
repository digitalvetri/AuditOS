import { useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight, ExternalLink, FileText, Files, Folder, FolderOpen, RefreshCw, Upload, X,
} from 'lucide-react';
import { workstationApi } from '@/modules/workstation/api';
import {
  Cell, Detail, Modal, QueryState, Row, SearchInput, Status, Table,
} from '@/modules/workstation/components';
import type { ClientDocumentFolders, ClientFolder, ClientFolderItem } from '@/modules/workstation/types';
import { Button } from '@/components/Button';
import { StatusSelect } from './StatusSelect';
import { RequestButtons, SendRequestDialog, needsRequest, type RequestChannel, type RequestTarget } from './SendRequestDialog';
import { useToast } from '@/components/Toast';
import { fmtDate, fmtTime, inr } from '@/lib/format';

/**
 * Every document the firm holds for one client, as folders — E-Way Bills,
 * E-Invoices, GST returns, invoices, letters, uploaded files by category and
 * imported source files. Refreshes on its own so a document created anywhere
 * in the app shows up here without a reload.
 */

const GROUPS: { key: ClientFolder['group']; label: string }[] = [
  { key: 'compliance', label: 'Compliance' },
  { key: 'billing', label: 'Billing & Letters' },
  { key: 'uploads', label: 'Uploaded Files' },
  { key: 'imports', label: 'Imported Files' },
];

const LIVE_REFRESH_MS = 30_000;

export interface UploadActions {
  canManage: boolean;
  canVerify: boolean;
  /** Uploads the original file as the document's next version. */
  onUpload: (documentId: string, file: File) => void;
  onVerify: (documentId: string) => void;
  onStatus: (documentId: string, status: string) => void;
}


const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt,.json,.xml,.zip';

export function ClientDocumentFolders({
  clientId, actions, headerRight,
}: {
  clientId: string;
  actions: UploadActions;
  headerRight?: ReactNode;
}) {
  const toast = useToast();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [record, setRecord] = useState<ClientFolderItem | null>(null);
  const [uploading, setUploading] = useState(0);
  const [request, setRequest] = useState<{ target: RequestTarget; channel: RequestChannel } | null>(null);
  // Selected for merging, in the order they were ticked — that is the order
  // they appear in the combined PDF. Survives moving between folders.
  const [selected, setSelected] = useState<{ key: string; source: string; ref: string; title: string }[]>([]);
  const [merging, setMerging] = useState(false);
  const [mergeHint, setMergeHint] = useState(false);
  const selKey = (i: ClientFolderItem) => `${i.source}:${i.id}`;
  const isSelected = (i: ClientFolderItem) => selected.some((x) => x.key === selKey(i));
  const toggle = (i: ClientFolderItem) => setSelected((cur) => (
    cur.some((x) => x.key === selKey(i))
      ? cur.filter((x) => x.key !== selKey(i))
      : [...cur, { key: selKey(i), source: i.source, ref: i.id, title: i.title }]
  ));
  const setMany = (items: ClientFolderItem[], on: boolean) => setSelected((cur) => {
    const keys = new Set(items.map(selKey));
    const rest = cur.filter((x) => !keys.has(x.key));
    return on ? [...rest, ...items.map((i) => ({ key: selKey(i), source: i.source, ref: i.id, title: i.title }))] : rest;
  });

  async function merge() {
    if (selected.length < 2) return;
    // Open the tab inside the click so a popup blocker allows it.
    const win = window.open('about:blank', '_blank');
    setMerging(true);
    try {
      const { blob, fileName, skipped } = await workstationApi.mergeClientDocuments(
        clientId, selected.map(({ source, ref }) => ({ source, ref })),
      );
      const url = URL.createObjectURL(blob);
      // Save a copy with a proper name, and show it.
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (win) win.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast.push(skipped > 0 ? 'error' : 'success', skipped > 0
        ? `Merged ${selected.length - skipped} of ${selected.length} — ${skipped} could not be included (see the contents page).`
        : `Merged ${selected.length} documents into ${fileName}.`);
      setSelected([]);
    } catch (e) {
      win?.close();
      toast.push('error', (e as Error).message);
    } finally {
      setMerging(false);
    }
  }
  const askClient = (item: ClientFolderItem, channel: RequestChannel) =>
    setRequest({ channel, target: { documentId: item.document_id!, documentName: item.title, clientId } });
  const qc = useQueryClient();

  async function uploadFiles(folder: ClientFolder, files: File[]) {
    setUploading((n) => n + files.length);
    let done = 0;
    for (const f of files) {
      try {
        await workstationApi.uploadToFolder(clientId, folder.key, f);
        done++;
      } catch (e) {
        toast.push('error', `${f.name}: ${(e as Error).message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (done > 0) {
      toast.push('success', done === 1 ? `Uploaded to ${folder.label}.` : `${done} files uploaded to ${folder.label}.`);
      void qc.invalidateQueries({ queryKey: ['workstation', 'client', clientId] });
    }
  }

  const query = useQuery({
    queryKey: ['workstation', 'client', clientId, 'document-folders'],
    queryFn: () => workstationApi.clientDocumentFolders(clientId),
    refetchInterval: LIVE_REFRESH_MS,
    refetchOnWindowFocus: true,
  });

  async function open(item: ClientFolderItem) {
    if (item.openable === 'record') { setRecord(item); return; }
    if (item.openable === 'none' || item.openable === 'missing') return;
    // Open the tab synchronously so a popup blocker treats it as the click's
    // own window, then point it at the signed link once it arrives.
    const win = window.open('about:blank', '_blank');
    try {
      const { url } = await workstationApi.openClientDocument(clientId, item.source, item.id);
      if (win) win.location.href = url;
      else window.location.href = url;
    } catch (e) {
      win?.close();
      toast.push('error', (e as Error).message);
    }
  }

  return (
    <div className="bg-white border border-neutral-200">
      <div className="px-4 h-12 flex items-center gap-3 border-b border-neutral-200">
        <Breadcrumb
          folder={openKey ? query.data?.folders.find((f) => f.key === openKey) ?? null : null}
          onRoot={() => setOpenKey(null)}
        />
        <div className="ml-auto flex items-center gap-3">
          {(() => {
            const f = openKey ? query.data?.folders.find((x) => x.key === openKey) : null;
            return f?.can_upload ? (
              <FolderUploadButton
                label={uploading > 0 ? `Uploading ${uploading}…` : 'Upload'}
                disabled={uploading > 0}
                onFiles={(files) => void uploadFiles(f, files)}
              />
            ) : null;
          })()}
          <Button
            variant={selected.length >= 2 ? 'primary' : undefined}
            disabled={merging}
            onClick={() => (selected.length >= 2 ? void merge() : setMergeHint(true))}
          >
            <span className="flex items-center gap-2">
              <Files size={14} />
              {merging ? 'Merging…' : selected.length > 0 ? `Merge (${selected.length})` : 'Merge'}
            </span>
          </Button>
          <LiveBadge
            at={query.data?.generated_at}
            fetching={query.isFetching}
            onRefresh={() => void query.refetch()}
          />
          {headerRight}
        </div>
      </div>

      {selected.length === 0 && mergeHint ? (
        <div className="px-4 py-2 flex items-center gap-3 border-b border-neutral-200 bg-neutral-50">
          <Files size={16} className="text-neutral-500" />
          <span className="text-13 text-neutral-700">
            Open a folder and tick the documents you want to combine — you can tick from several folders.
            Then press <span className="font-medium">Merge</span> to get one PDF.
          </span>
          <button
            type="button"
            onClick={() => setMergeHint(false)}
            className="ml-auto h-8 px-2 flex items-center gap-1 text-12 text-neutral-600 hover:text-neutral-900"
          >
            <X size={13} /> Close
          </button>
        </div>
      ) : null}
      {selected.length > 0 ? (
        <div className="px-4 py-2 flex items-center gap-3 border-b border-neutral-200 bg-neutral-50">
          <Files size={16} className="text-neutral-500" />
          <span className="text-13 text-neutral-900">
            <span className="font-medium">{selected.length}</span> selected
            <span className="text-neutral-500"> — merged in the order you ticked them</span>
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelected([])}
              className="h-8 px-2 flex items-center gap-1 text-12 text-neutral-600 hover:text-neutral-900"
            >
              <X size={13} /> Clear
            </button>
            <Button
              variant="primary"
              disabled={selected.length < 2 || merging}
              onClick={() => void merge()}
              title={selected.length < 2 ? 'Select at least two documents' : undefined}
            >
              <span className="flex items-center gap-2">
                <Files size={14} />
                {merging ? 'Merging…' : selected.length < 2 ? 'Select one more to merge' : `Merge ${selected.length} into PDF`}
              </span>
            </Button>
          </div>
        </div>
      ) : null}

      <div className="px-4 py-3 border-b border-neutral-200">
        <SearchInput value={q} onChange={setQ} placeholder="Search all documents — number, party, file name…" />
      </div>

      <QueryState query={query}>
        {(data: ClientDocumentFolders) => {
          const needle = q.trim().toLowerCase();
          if (needle) {
            const hits = data.folders.flatMap((f) =>
              f.items.filter((i) => matches(i, needle)).map((i) => ({ folder: f, item: i })));
            return hits.length === 0
              ? <Empty>No documents match “{q.trim()}”.</Empty>
              : <ItemTable rows={hits} showFolder onOpen={open} actions={actions} onRequest={askClient} selection={{ isSelected, toggle, setMany }} />;
          }
          const folder = openKey ? data.folders.find((f) => f.key === openKey) : null;
          if (folder) {
            return folder.items.length === 0
              ? <Empty>No documents in {folder.label} yet.</Empty>
              : <ItemTable rows={folder.items.map((i) => ({ folder, item: i }))} onOpen={open} actions={actions} onRequest={askClient} selection={{ isSelected, toggle, setMany }} />;
          }
          return (
            <FolderGrid
              data={data}
              onOpen={setOpenKey}
              onUpload={(f, files) => void uploadFiles(f, files)}
            />
          );
        }}
      </QueryState>

      <SendRequestDialog
        target={request?.target ?? null}
        channel={request?.channel ?? 'whatsapp'}
        onClose={() => setRequest(null)}
      />

      <Modal
        open={record !== null}
        title={record?.title ?? ''}
        onClose={() => setRecord(null)}
        footer={<Button onClick={() => setRecord(null)}>Close</Button>}
      >
        {record?.fields?.map(([label, value]) => <Detail key={label} label={label} value={value} />)}
      </Modal>
    </div>
  );
}

function matches(i: ClientFolderItem, needle: string): boolean {
  return [i.title, i.subtitle, i.file_name, i.status, ...(i.fields?.map((f) => f[1]) ?? [])]
    .some((v) => v?.toLowerCase().includes(needle));
}

function Breadcrumb({ folder, onRoot }: { folder: ClientFolder | null; onRoot: () => void }) {
  return (
    <div className="flex items-center gap-1.5 text-13 min-w-0">
      {folder ? (
        <>
          <button type="button" onClick={onRoot} className="text-neutral-500 hover:text-neutral-900 underline-offset-2 hover:underline">
            All folders
          </button>
          <ChevronRight size={14} className="text-neutral-400 shrink-0" />
          <span className="font-medium text-neutral-900 truncate">{folder.label}</span>
          <span className="text-neutral-400">· {folder.count}</span>
        </>
      ) : (
        <span className="font-medium text-neutral-900">Documents</span>
      )}
    </div>
  );
}

function LiveBadge({ at, fetching, onRefresh }: { at?: string; fetching: boolean; onRefresh: () => void }) {
  return (
    <button
      type="button"
      onClick={onRefresh}
      title="Refreshes automatically every 30 seconds — click to refresh now"
      className="flex items-center gap-1.5 text-11 text-neutral-500 hover:text-neutral-900"
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-60 animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
      </span>
      Live{at ? ` · ${fmtTime(at)}` : ''}
      <RefreshCw size={12} className={fetching ? 'animate-spin' : ''} />
    </button>
  );
}

function FolderGrid({
  data, onOpen, onUpload,
}: {
  data: ClientDocumentFolders;
  onOpen: (key: string) => void;
  onUpload: (folder: ClientFolder, files: File[]) => void;
}) {
  return (
    <div className="p-4 space-y-5">
      {GROUPS.map((g) => {
        const folders = data.folders.filter((f) => f.group === g.key);
        if (folders.length === 0) return null;
        return (
          <section key={g.key}>
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">{g.label}</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {folders.map((f) => (
                <div key={f.key} className="relative group/tile">
                <button
                  type="button"
                  onClick={() => onOpen(f.key)}
                  className={`w-full flex items-center gap-3 px-3 py-3 pr-10 border text-left transition-colors ${
                    f.count > 0
                      ? 'border-neutral-200 hover:border-gold hover:bg-neutral-50'
                      : 'border-dashed border-neutral-200 hover:bg-neutral-50'
                  }`}
                >
                  {f.count > 0
                    ? <FolderOpen size={22} className="text-gold shrink-0" />
                    : <Folder size={22} className="text-neutral-300 shrink-0" />}
                  <span className="min-w-0">
                    <span className={`block text-13 font-medium truncate ${f.count > 0 ? 'text-neutral-900' : 'text-neutral-500'}`}>
                      {f.label}
                    </span>
                    <span className="block text-11 text-neutral-500">
                      {f.count === 1 ? '1 document' : `${f.count} documents`}
                    </span>
                  </span>
                </button>
                {f.can_upload ? (
                  <div className="absolute right-2 top-1/2 -translate-y-1/2">
                    <FolderUploadButton iconOnly label={`Upload to ${f.label}`} onFiles={(files) => onUpload(f, files)} />
                  </div>
                ) : null}
                </div>
              ))}
            </div>
          </section>
        );
      })}
      <div className="text-11 text-neutral-500">{data.total} documents across {data.folders.length} folders</div>
    </div>
  );
}

interface Selection {
  isSelected: (item: ClientFolderItem) => boolean;
  toggle: (item: ClientFolderItem) => void;
  setMany: (items: ClientFolderItem[], on: boolean) => void;
}

/** Only documents that have content can go into a merged PDF. */
const mergeable = (i: ClientFolderItem) => i.openable === 'pdf' || i.openable === 'file';

function ItemTable({
  rows, showFolder = false, onOpen, actions, onRequest, selection,
}: {
  rows: { folder: ClientFolder; item: ClientFolderItem }[];
  showFolder?: boolean;
  onOpen: (item: ClientFolderItem) => void;
  actions: UploadActions;
  onRequest: (item: ClientFolderItem, channel: RequestChannel) => void;
  selection: Selection;
}) {
  const candidates = rows.map((r) => r.item).filter(mergeable);
  const allOn = candidates.length > 0 && candidates.every(selection.isSelected);
  const head = [' ', 'Document', ...(showFolder ? ['Folder'] : []), 'Date', 'Amount', 'Status', 'Actions'];
  return (
    <>
    {candidates.length > 1 ? (
      <label className="px-4 h-9 flex items-center gap-2 text-12 text-neutral-600 border-b border-neutral-200 cursor-pointer select-none w-fit">
        <input
          type="checkbox"
          className="h-4 w-4 accent-neutral-900"
          checked={allOn}
          onChange={(e) => selection.setMany(candidates, e.target.checked)}
        />
        Select all {candidates.length} for merging
      </label>
    ) : null}
    <Table head={head}>
      {rows.map(({ folder, item }) => (
        <Row key={`${item.source}:${item.id}`} status={item.status ?? undefined}>
          <Cell className="w-8">
            {mergeable(item) ? (
              <input
                type="checkbox"
                aria-label={`Select ${item.title} for merging`}
                className="h-4 w-4 accent-neutral-900 cursor-pointer"
                checked={selection.isSelected(item)}
                onChange={() => selection.toggle(item)}
              />
            ) : (
              <span title="No file uploaded yet — upload it to include this document in a merge.">
                <input type="checkbox" disabled aria-label="No file to merge" className="h-4 w-4 opacity-40 cursor-not-allowed" />
              </span>
            )}
          </Cell>
          <Cell>
            <button
              type="button"
              disabled={item.openable === 'none' || item.openable === 'missing'}
              onClick={() => onOpen(item)}
              className="flex items-start gap-2 text-left disabled:cursor-default group"
            >
              <FileText size={15} className="text-neutral-400 mt-0.5 shrink-0" />
              <span className="min-w-0">
                <span className="block font-medium text-neutral-900 group-enabled:group-hover:underline">{item.title}</span>
                {item.subtitle || item.file_name ? (
                  <span className="block text-11 text-neutral-500 truncate max-w-[360px]">
                    {[item.subtitle, item.file_name].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
              </span>
            </button>
          </Cell>
          {showFolder ? <Cell muted>{folder.label}</Cell> : null}
          <Cell muted>{item.date ? fmtDate(item.date) : '—'}</Cell>
          <Cell muted>{item.amount_paise != null ? inr(item.amount_paise) : '—'}</Cell>
          <Cell>
            {item.document_id && actions.canManage ? (
              <StatusSelect
                value={item.status ?? 'requested'}
                canVerify={actions.canVerify}
                onChange={(next) => actions.onStatus(item.document_id!, next)}
              />
            ) : item.status ? <Status value={item.status} /> : '—'}
          </Cell>
          <Cell>
            <div className="flex gap-3 items-center">
              {item.openable === 'none' || item.openable === 'missing' ? (
                <span className="text-12 text-neutral-400">Not uploaded</span>
              ) : (
                <button
                  type="button"
                  onClick={() => onOpen(item)}
                  className="flex items-center gap-1 text-12 text-neutral-700 underline hover:text-neutral-900"
                >
                  {item.openable === 'record' ? 'View' : 'Open'}
                  {item.openable !== 'record' ? <ExternalLink size={11} /> : null}
                </button>
              )}
              {item.document_id && actions.canManage ? (
                <UploadButton
                  label={item.openable === 'file' ? 'New version' : 'Upload file'}
                  onFile={(f) => actions.onUpload(item.document_id!, f)}
                />
              ) : null}
              {item.document_id && actions.canManage && needsRequest(item.status, item.openable !== 'file') ? (
                <RequestButtons onPick={(ch) => onRequest(item, ch)} />
              ) : null}
            </div>
          </Cell>
        </Row>
      ))}
    </Table>
    </>
  );
}

function FolderUploadButton({
  label, onFiles, disabled = false, iconOnly = false,
}: {
  label: string;
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  iconOnly?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      {iconOnly ? (
        <button
          type="button"
          title={label}
          aria-label={label}
          onClick={(e) => { e.stopPropagation(); input.current?.click(); }}
          className="h-7 w-7 flex items-center justify-center text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100"
        >
          <Upload size={14} />
        </button>
      ) : (
        <Button variant="primary" disabled={disabled} onClick={() => input.current?.click()}>
          <span className="flex items-center gap-2"><Upload size={14} />{label}</span>
        </Button>
      )}
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length > 0) onFiles(files);
        }}
      />
    </>
  );
}

function UploadButton({ label, onFile }: { label: string; onFile: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        className="flex items-center gap-1 text-12 text-neutral-700 underline hover:text-neutral-900"
      >
        <Upload size={11} />
        {label}
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
    </>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-8 text-13 text-neutral-500 text-center">{children}</div>;
}

