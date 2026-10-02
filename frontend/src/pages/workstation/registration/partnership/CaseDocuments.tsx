import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, CheckCircle2, Download, Eye, File, FileImage, FileText, Folder, FolderPlus,
  History, Link2, RefreshCw, Send, Trash2, Upload, XCircle,
} from 'lucide-react';
import { type CaseDetail, type DocRequirement, type DocVersion } from '@/modules/partnership/api';
import { Field, Modal, Status, inputClass, textareaClass } from '@/modules/workstation/components';
import { Button } from '@/components/Button';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { RequirementTag, fmtSize, useSvc } from './shared';
import { useCaseMutation } from './PartnershipCase';
import { AddCategoryModal } from './CaseChecklist';

const ACCEPT = '.pdf,.doc,.docx,.jpg,.jpeg,.png';
const OTHER = 'Additional Documents';
const statusKey = (s: string) => s.toLowerCase();
const partnerFolder = (name: string) => `Partner — ${name}`;
const counts = (r: DocRequirement) => r.requirement !== 'OPTIONAL' && r.status !== 'NOT_APPLICABLE';

/**
 * Documents as a file browser: one folder per category, one file per
 * requirement. Double-click (double-tap) opens a file — the preview, or the
 * upload dialog when nothing is there yet. Selecting a file shows every
 * action it allows in one bar, so the grid itself stays quiet.
 */
export function CaseDocuments({ c }: { c: CaseDetail }) {
  const [folder, setFolder] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState<DocRequirement | null>(null);
  const [uploadFor, setUploadFor] = useState<DocRequirement | 'new' | null>(null);
  const [newFolder, setNewFolder] = useState(false);

  const folders = useMemo(() => {
    const map = new Map<string, DocRequirement[]>();
    // Every checklist category that collects files, in checklist order, then anything ad hoc.
    // A per-partner category (LLP KYC) becomes one folder per partner, so one
    // partner's files never sit beside another's.
    const perPartner = new Set(c.categories.filter((x) => x.per_partner).map((x) => x.name));
    for (const cat of c.categories) if (!cat.per_partner) map.set(cat.name, []);
    for (const p of c.partners) if (perPartner.size) map.set(partnerFolder(p.name), []);
    for (const r of c.requirements) {
      const k = r.partner && perPartner.has(r.category_name ?? '') ? partnerFolder(r.partner.name) : r.category_name ?? OTHER;
      map.set(k, [...(map.get(k) ?? []), r]);
    }
    return Array.from(map).filter(([name, list]) => list.length > 0 || c.categories.find((x) => x.name === name)?.is_custom);
  }, [c]);

  const needle = q.trim().toLowerCase();
  const matches = (r: DocRequirement) =>
    !needle || `${r.name} ${r.versions.map((v) => v.original_name).join(' ')}`.toLowerCase().includes(needle);
  const files = needle
    ? c.requirements.filter(matches)
    : folder ? (folders.find(([n]) => n === folder)?.[1] ?? []) : [];
  const selected = c.requirements.find((r) => r.id === selectedId) ?? null;

  const req = c.requirements.filter(counts);
  const summary = [
    ['Required', req.length],
    ['Uploaded', req.filter((r) => r.status !== 'PENDING').length],
    ['Pending', req.filter((r) => r.status === 'PENDING').length],
    ['Under review', req.filter((r) => r.status === 'UNDER_REVIEW').length],
    ['Needs action', c.requirements.filter((r) => r.status === 'REJECTED' || r.status === 'REPLACEMENT_REQUIRED').length],
    ['Verified', req.filter((r) => r.status === 'VERIFIED').length],
  ] as const;

  const openFile = (r: DocRequirement) => {
    setSelectedId(r.id);
    if (r.current_version) setOpen(r);
    else if (c.permissions.upload && r.status !== 'NOT_APPLICABLE') setUploadFor(r);
  };

  return (
    <div className="bg-white border border-neutral-200 rounded">
      {/* Toolbar */}
      <div className="px-3 h-12 flex items-center gap-2 border-b border-neutral-200">
        {folder && !needle ? (
          <button type="button" onClick={() => { setFolder(null); setSelectedId(null); }} className="h-8 w-8 inline-flex items-center justify-center rounded hover:bg-neutral-100" aria-label="Back to folders">
            <ArrowLeft size={16} />
          </button>
        ) : null}
        <nav className="text-13 min-w-0 truncate">
          <button type="button" className={folder || needle ? 'text-neutral-500 hover:text-neutral-900' : 'font-medium text-neutral-900'} onClick={() => { setFolder(null); setQ(''); setSelectedId(null); }}>Documents</button>
          {folder && !needle ? <span className="text-neutral-900 font-medium"> / {folder}</span> : null}
          {needle ? <span className="text-neutral-900 font-medium"> / Search</span> : null}
        </nav>
        <div className="flex-1" />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setSelectedId(null); }}
          placeholder="Search files…"
          className="h-8 px-3 w-[200px] max-w-[40vw] text-13 border border-neutral-300 rounded focus:outline-none focus:border-gold"
        />
        {c.permissions.manage ? (
          <Button size="sm" onClick={() => setNewFolder(true)}><FolderPlus size={14} className="inline -mt-0.5 mr-1" />New folder</Button>
        ) : null}
        {c.permissions.upload ? (
          <Button size="sm" variant="primary" onClick={() => setUploadFor('new')}><Upload size={14} className="inline -mt-0.5 mr-1" />Upload</Button>
        ) : null}
      </div>

      {/* One-line summary instead of five cards */}
      <div className="px-3 h-9 flex items-center gap-4 text-12 text-neutral-500 border-b border-neutral-200 overflow-x-auto whitespace-nowrap">
        {summary.map(([label, n]) => (
          <span key={label}>{label} <span className={`tabular-nums font-medium ${label === 'Needs action' && n > 0 ? 'text-red' : 'text-neutral-900'}`}>{n}</span></span>
        ))}
        {c.partners.length === 0 ? <span className="text-amber">Add partners in Registration Details to collect their PAN, ID proof and photo.</span> : null}
      </div>

      {/* Selection bar */}
      {selected && (folder || needle) ? (
        <ActionBar c={c} r={selected} onOpen={() => openFile(selected)} onUpload={() => setUploadFor(selected)} onClear={() => setSelectedId(null)} />
      ) : null}

      <div className="p-3 min-h-[280px]" onClick={() => setSelectedId(null)}>
        {!folder && !needle ? (
          folders.length === 0 ? (
            <Empty text="No documents yet." action={c.permissions.upload ? () => setUploadFor('new') : undefined} />
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
              {folders.map(([name, list]) => {
                const need = list.filter(counts);
                const done = need.filter((r) => r.status !== 'PENDING').length;
                const alert = list.some((r) => r.status === 'REJECTED' || r.status === 'REPLACEMENT_REQUIRED');
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setFolder(name); }}
                    className="text-left p-3 rounded border border-transparent hover:border-neutral-200 hover:bg-neutral-50 focus:outline-none focus:border-gold"
                  >
                    <Folder size={36} className="text-neutral-500" fill="currentColor" fillOpacity={0.15} />
                    <div className="mt-1 text-13 text-neutral-900 leading-tight line-clamp-2">{name}</div>
                    <div className="text-12 text-neutral-500">
                      {list.length === 0 ? 'Empty' : need.length ? `${done} of ${need.length} uploaded` : `${list.length} file${list.length === 1 ? '' : 's'}`}
                      {alert ? <span className="text-red"> · action needed</span> : null}
                    </div>
                  </button>
                );
              })}
            </div>
          )
        ) : files.length === 0 ? (
          <Empty text={needle ? 'No files match.' : 'This folder is empty.'} action={!needle && c.permissions.upload ? () => setUploadFor('new') : undefined} />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {files.map((r) => (
              <FileTile
                key={r.id}
                r={r}
                selected={r.id === selectedId}
                onSelect={() => setSelectedId(r.id)}
                onOpen={() => openFile(r)}
              />
            ))}
          </div>
        )}
        {folder || needle ? <p className="mt-4 text-11 text-neutral-400">Double-click a file to open it. Select it for download, verification and replacement.</p> : null}
      </div>

      {open ? <FileViewer c={c} r={open} onClose={() => setOpen(null)} onUpload={() => { setOpen(null); setUploadFor(open); }} /> : null}
      {uploadFor ? <UploadModal c={c} requirement={uploadFor === 'new' ? null : uploadFor} defaultCategory={folder ?? undefined} onClose={() => setUploadFor(null)} /> : null}
      <AddCategoryModal caseId={c.id} open={newFolder} onClose={() => setNewFolder(false)} defaultName={OTHER} />
    </div>
  );
}

function Empty({ text, action }: { text: string; action?: () => void }) {
  return (
    <div className="py-12 text-center text-13 text-neutral-500">
      {text}
      {action ? <div className="mt-2"><Button size="sm" onClick={action}>Upload Document</Button></div> : null}
    </div>
  );
}

function fileIcon(r: DocRequirement) {
  const mime = r.current_version?.mime_type ?? '';
  if (!r.current_version) return File;
  if (mime.startsWith('image/')) return FileImage;
  return FileText;
}

function FileTile({ r, selected, onSelect, onOpen }: { r: DocRequirement; selected: boolean; onSelect: () => void; onOpen: () => void }) {
  const Icon = fileIcon(r);
  const empty = !r.current_version;
  const na = r.status === 'NOT_APPLICABLE';
  // Two clicks within 350 ms = open. Works for a mouse double-click and a
  // double TAP alike — mobile Safari does not reliably fire dblclick.
  const lastTap = useRef(0);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        const now = Date.now();
        if (now - lastTap.current < 350) { lastTap.current = 0; onOpen(); }
        else { lastTap.current = now; onSelect(); }
      }}
      title={empty ? 'Not uploaded — double-click to upload' : 'Double-click to open'}
      className={
        'relative text-left p-3 rounded border focus:outline-none ' +
        (selected ? 'border-gold bg-neutral-50' : 'border-transparent hover:border-neutral-200 hover:bg-neutral-50') +
        (na ? ' opacity-50' : '')
      }
    >
      <Icon size={36} strokeWidth={1.25} className={empty ? 'text-neutral-300' : r.current_version?.mime_type === 'application/pdf' ? 'text-red' : 'text-neutral-600'} />
      <div className="mt-1 text-13 text-neutral-900 leading-tight line-clamp-2 break-words">{r.name}</div>
      {r.current_version?.document_type ? <div className="text-11 text-neutral-500">{r.current_version.document_type}</div> : null}
      <div className="mt-1 flex items-center gap-1 flex-wrap">
        {empty && !na ? <span className="text-12 text-neutral-400">Not uploaded</span> : <Status value={statusKey(r.status)} />}
        {r.current_version && r.current_version.version > 1 ? <span className="text-11 text-neutral-400">v{r.current_version.version}</span> : null}
      </div>
    </button>
  );
}

/** Every action a selected file allows — shown once, for that file only. */
function ActionBar({ c, r, onOpen, onUpload, onClear }: { c: CaseDetail; r: DocRequirement; onOpen: () => void; onUpload: () => void; onClear: () => void }) {
  const a = useFileActions(c, r);
  const v = r.current_version;
  return (
    <div className="px-3 py-2 flex flex-wrap items-center gap-1 border-b border-neutral-200 bg-neutral-50" onClick={(e) => e.stopPropagation()}>
      <div className="min-w-0 mr-2">
        <div className="text-13 font-medium text-neutral-900 truncate max-w-[320px]">{r.name}</div>
        <div className="text-11 text-neutral-500 truncate max-w-[320px]">
          {v ? `${v.original_name} · v${v.version} · ${fmtSize(v.size_bytes)} · ${fmtDate(v.uploaded_at)}${v.uploaded_by ? ` · ${v.uploaded_by.full_name}` : ''}` : 'Not uploaded yet'}
        </div>
      </div>
      <div className="flex-1" />
      {v ? <Act icon={Eye} label="Open" onClick={onOpen} /> : null}
      {v ? <Act icon={Download} label="Download" onClick={() => void a.download(v)} /> : null}
      <FileActionButtons a={a} c={c} r={r} onUpload={onUpload} />
      <button type="button" onClick={onClear} className="ml-1 h-8 w-8 text-neutral-500 hover:text-neutral-900" aria-label="Clear selection">✕</button>
      {a.dialogs}
    </div>
  );
}

function Act({ icon: Icon, label, onClick, tone = '' }: { icon: typeof File; label: string; onClick: () => void; tone?: string }) {
  return (
    <button type="button" onClick={onClick} className={`h-8 px-2 inline-flex items-center gap-1 text-13 rounded hover:bg-white border border-transparent hover:border-neutral-200 ${tone}`}>
      <Icon size={14} /> {label}
    </button>
  );
}

function useFileActions(c: CaseDetail, r: DocRequirement) {
  const { api: regApi } = useSvc();
  const [review, setReview] = useState<'rejected' | 'replacement_required' | null>(null);
  const [linking, setLinking] = useState(false);
  const act = useCaseMutation((v: { status: string; note?: string }) => regApi.review(c.id, r.id, v), 'Updated');
  const patch = useCaseMutation((v: Record<string, unknown>) => regApi.updateRequirement(c.id, r.id, v), 'Saved');
  const del = useCaseMutation(() => regApi.deleteDocument(c.id, r.id), 'Document deleted');
  const download = async (ver: DocVersion) => {
    const link = await regApi.fileLink(c.id, r.id, ver.id);
    window.open(link.url, '_blank', 'noopener');
  };
  const items = c.categories.flatMap((cat) => cat.items.map((i) => ({ id: i.id, label: `${cat.name} — ${i.name}` })));
  const dialogs = (
    <>
      {review ? (
        <ReviewModal
          title={review === 'rejected' ? `Reject — ${r.name}` : `Request replacement — ${r.name}`}
          pending={act.isPending}
          onClose={() => setReview(null)}
          onSubmit={(note) => act.mutate({ status: review, note }, { onSuccess: () => setReview(null) })}
        />
      ) : null}
      {linking ? (
        <Modal open title={`Link to checklist — ${r.name}`} onClose={() => setLinking(false)}>
          <select className={inputClass} value={r.item?.id ?? ''} onChange={(e) => patch.mutate({ item_id: e.target.value || null }, { onSuccess: () => setLinking(false) })}>
            <option value="">— Not linked —</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
          </select>
        </Modal>
      ) : null}
    </>
  );
  return { act, patch, del, download, setReview, setLinking, dialogs };
}

function FileActionButtons({ a, c, r, onUpload }: { a: ReturnType<typeof useFileActions>; c: CaseDetail; r: DocRequirement; onUpload: () => void }) {
  const v = r.current_version;
  const needsReplacement = r.status === 'REJECTED' || r.status === 'REPLACEMENT_REQUIRED';
  return (
    <>
      {c.permissions.upload && r.status !== 'NOT_APPLICABLE' ? (
        <Act icon={v ? RefreshCw : Upload} label={!v ? 'Upload' : needsReplacement ? 'Upload replacement' : 'Replace'} onClick={onUpload} />
      ) : null}
      {v && r.status === 'UPLOADED' && c.permissions.upload ? (
        <Act icon={Send} label="Send for verification" onClick={() => a.act.mutate({ status: 'under_review' })} />
      ) : null}
      {v && c.permissions.verify && r.status !== 'VERIFIED' ? (
        <Act icon={CheckCircle2} label="Verify" onClick={() => a.act.mutate({ status: 'verified' })} />
      ) : null}
      {v && c.permissions.verify && !needsReplacement ? (
        <Act icon={RefreshCw} label="Request replacement" onClick={() => a.setReview('replacement_required')} />
      ) : null}
      {v && c.permissions.verify && r.status !== 'REJECTED' ? (
        <Act icon={XCircle} label="Reject" tone="text-red" onClick={() => a.setReview('rejected')} />
      ) : null}
      {c.permissions.manage ? <Act icon={Link2} label={r.item ? 'Relink' : 'Link'} onClick={() => a.setLinking(true)} /> : null}
      {c.permissions.manage && (r.requirement !== 'REQUIRED' || r.not_applicable) ? (
        <Act icon={File} label={r.not_applicable ? 'Mark applicable' : 'Not applicable'} onClick={() => a.patch.mutate({ not_applicable: !r.not_applicable })} />
      ) : null}
      {v && c.permissions.verify ? (
        <Act icon={Trash2} label="Delete" tone="text-red" onClick={() => { if (window.confirm(`Delete the uploaded file(s) for "${r.name}"?`)) a.del.mutate(undefined); }} />
      ) : null}
    </>
  );
}

function ReviewModal({ title, onClose, onSubmit, pending }: { title: string; onClose: () => void; onSubmit: (note: string) => void; pending: boolean }) {
  const [note, setNote] = useState('');
  return (
    <Modal open title={title} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!note.trim() || pending} onClick={() => onSubmit(note)}>Save</Button></>}>
      <Field label="Reason (shown on the document)"><textarea className={textareaClass} rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <p className="text-12 text-neutral-500">The uploaded file is kept in the version history.</p>
    </Modal>
  );
}

/**
 * The opened file: preview on the left, facts, actions and version history on
 * the right. PDFs and images preview in place; other types offer download.
 */
function FileViewer({ c, r, onClose, onUpload }: { c: CaseDetail; r: DocRequirement; onClose: () => void; onUpload: () => void }) {
  const { api: regApi } = useSvc();
  const live = c.requirements.find((x) => x.id === r.id) ?? r;
  const [versionId, setVersionId] = useState(live.current_version?.id ?? '');
  const version = live.versions.find((v) => v.id === versionId) ?? live.current_version;
  const a = useFileActions(c, live);
  const link = useQuery({
    queryKey: ['registration', 'file-link', version?.id],
    queryFn: () => regApi.fileLink(c.id, live.id, version!.id),
    enabled: !!version,
    staleTime: 60_000,
  });
  const mime = version?.mime_type ?? '';
  const inlineUrl = link.data ? `${link.data.url}&inline=1` : '';

  return (
    <Modal open title={live.name} onClose={onClose} width="w-[1100px]">
      <div className="grid md:grid-cols-[1fr_300px] gap-4">
        <div className="bg-neutral-100 rounded min-h-[60vh] flex items-center justify-center overflow-hidden">
          {link.isLoading ? <span className="text-13 text-neutral-500">Loading…</span> : null}
          {link.isError ? <span className="text-13 text-red">Could not open this file.</span> : null}
          {link.data && mime === 'application/pdf' ? <iframe title="Preview" src={inlineUrl} className="w-full h-[70vh] bg-white" /> : null}
          {link.data && mime.startsWith('image/') ? <img alt={version?.original_name ?? ''} src={inlineUrl} className="max-w-full max-h-[70vh]" /> : null}
          {link.data && mime !== 'application/pdf' && !mime.startsWith('image/') ? (
            <div className="text-center text-13 text-neutral-600">
              <FileText size={48} strokeWidth={1} className="mx-auto text-neutral-400" />
              <div className="mt-2">{version?.original_name}</div>
              <div className="text-neutral-500">No preview for this file type — download to open it.</div>
            </div>
          ) : null}
        </div>

        <div className="text-13 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Status value={statusKey(live.status)} />
            <RequirementTag value={live.requirement} condition={live.condition} />
          </div>
          {version ? (
            <dl className="space-y-1">
              <Row k="File" v={version.original_name ?? '—'} />
              <Row k="Size" v={fmtSize(version.size_bytes)} />
              <Row k="Uploaded" v={`${fmtDateTime(version.uploaded_at)}${version.uploaded_by ? ` · ${version.uploaded_by.full_name}` : ''}`} />
              {version.document_type ? <Row k="Document type" v={version.document_type} /> : null}
              {version.document_date ? (
                <Row k="Dated" v={<>{fmtDate(version.document_date)}{tooOld(version.document_date, live.max_age_days) ? <span className="text-red"> · older than {ageLabel(live.max_age_days!)}</span> : null}</>} />
              ) : live.max_age_days ? <Row k="Dated" v={<span className="text-amber">Date not entered — must be within {ageLabel(live.max_age_days)}</span>} /> : null}
              <Row k="Checklist" v={live.item?.name ?? 'Not linked'} />
              {version.review_note ? <Row k="Review note" v={<span className="text-red">{version.review_note}</span>} /> : null}
            </dl>
          ) : null}

          <div className="flex flex-col items-stretch gap-1 [&>button]:justify-start">
            {version ? <Act icon={Download} label="Download" onClick={() => void a.download(version)} /> : null}
            <FileActionButtons a={a} c={c} r={live} onUpload={onUpload} />
          </div>

          {live.versions.length > 0 ? (
            <div>
              <div className="flex items-center gap-1 text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1"><History size={12} /> Versions</div>
              <ul className="border border-neutral-200 rounded divide-y divide-neutral-200">
                {live.versions.map((v) => (
                  <li key={v.id}>
                    <button type="button" onClick={() => setVersionId(v.id)} className={`w-full text-left px-2 py-1.5 flex items-center gap-2 ${v.id === version?.id ? 'bg-neutral-50' : 'hover:bg-neutral-50'}`}>
                      <span className="tabular-nums w-6">v{v.version}</span>
                      <span className="flex-1 min-w-0 truncate text-12 text-neutral-500">{fmtDate(v.uploaded_at)}</span>
                      <Status value={statusKey(v.review_status)} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
      {a.dialogs}
    </Modal>
  );
}

/** The source's "not older than 2 months", judged from the date ON the document, never the upload date. */
function tooOld(documentDate: string, maxAgeDays: number | null): boolean {
  if (!maxAgeDays) return false;
  const age = (Date.now() - new Date(`${documentDate}T00:00:00`).getTime()) / 86_400_000;
  return age > maxAgeDays;
}
const ageLabel = (days: number) => (days % 30 === 0 ? `${days / 30} month${days === 30 ? '' : 's'}` : `${days} days`);

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-[84px] shrink-0 text-neutral-500">{k}</dt>
      <dd className="min-w-0 break-words text-neutral-900">{v}</dd>
    </div>
  );
}

/**
 * Upload against a requirement (a new version if one exists), or an ad-hoc
 * document that can be linked to a checklist item now or later.
 */
export function UploadModal({ c, requirement, onClose, defaultCategory }: { c: CaseDetail; requirement: DocRequirement | null; onClose: () => void; defaultCategory?: string }) {
  const { api: regApi } = useSvc();
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [target, setTarget] = useState(requirement?.id ?? '');
  const [name, setName] = useState('');
  const [itemId, setItemId] = useState('');
  const [categoryName, setCategoryName] = useState(defaultCategory ?? 'Additional Documents');
  const [notes, setNotes] = useState('');
  const [docType, setDocType] = useState('');
  const [docDate, setDocDate] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const m = useCaseMutation((form: FormData) => regApi.upload(c.id, form), 'Document uploaded');
  const open = c.requirements.filter((r) => r.status !== 'VERIFIED' && r.status !== 'NOT_APPLICABLE');
  const items = c.categories.flatMap((cat) => cat.items.map((i) => ({ id: i.id, label: `${cat.name} — ${i.name}` })));
  const categoryNames = Array.from(new Set(c.categories.map((x) => x.name).concat('Additional Documents')));

  const chosen = c.requirements.find((r) => r.id === target) ?? null;
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) setFile(f);
  };
  const submit = () => {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    if (target) form.append('requirement_id', target);
    else {
      if (name) form.append('name', name);
      if (itemId) form.append('item_id', itemId);
      form.append('category_name', categoryName);
    }
    if (notes) form.append('notes', notes);
    if (docType) form.append('document_type', docType);
    if (docDate) form.append('document_date', docDate);
    m.mutate(form, { onSuccess: onClose });
  };

  return (
    <Modal
      open
      title={requirement ? `Upload — ${requirement.name}` : 'Upload Document'}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!file || m.isPending || (!!chosen?.doc_type_options && !docType)} onClick={submit}>{m.isPending ? 'Uploading…' : 'Upload'}</Button></>}
    >
      {!requirement ? (
        <Field label="Document">
          <select className={inputClass} value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">New / miscellaneous document</option>
            {open.map((r) => <option key={r.id} value={r.id}>{r.name}{r.current_version ? ` (replace v${r.current_version.version})` : ''}</option>)}
          </select>
        </Field>
      ) : requirement.current_version ? (
        <p className="text-12 text-neutral-500 mb-2">Uploads version {requirement.current_version.version + 1}. Earlier versions stay in the history.</p>
      ) : null}
      {chosen?.doc_type_options ? (
        <Field label="Which document is this? (any one)">
          <div className="flex flex-wrap gap-3">
            {chosen.doc_type_options.map((o) => (
              <label key={o} className="inline-flex items-center gap-1.5 text-13">
                <input type="radio" name="doc-type" checked={docType === o} onChange={() => setDocType(o)} /> {o}
              </label>
            ))}
          </div>
        </Field>
      ) : null}
      {chosen?.max_age_days ? (
        <Field label="Date on the document" hint={`Must not be older than ${ageLabel(chosen.max_age_days)}.`}>
          <input type="date" className={inputClass + ' max-w-[200px]'} value={docDate} onChange={(e) => setDocDate(e.target.value)} />
          {docDate && tooOld(docDate, chosen.max_age_days) ? <span className="block text-12 text-red mt-1">This document is older than {ageLabel(chosen.max_age_days)}.</span> : null}
        </Field>
      ) : null}
      {!target ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Document name" hint="Defaults to the file name"><input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Category">
            <select className={inputClass} value={categoryName} onChange={(e) => setCategoryName(e.target.value)}>
              {categoryNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </Field>
          <div className="col-span-2">
            <Field label="Link to Checklist Item (optional)">
              <select className={inputClass} value={itemId} onChange={(e) => setItemId(e.target.value)}>
                <option value="">— Not linked —</option>
                {items.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
              </select>
            </Field>
          </div>
        </div>
      ) : null}
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onClick={() => input.current?.click()}
        className={`border border-dashed rounded px-4 py-6 text-center text-13 cursor-pointer mb-3 ${over ? 'border-gold bg-neutral-50' : 'border-neutral-300'}`}
      >
        {file ? <span className="text-neutral-900">{file.name} · {fmtSize(file.size)}</span> : <span className="text-neutral-500">Drag a file here, or click to choose</span>}
        <div className="text-11 text-neutral-400 mt-1">PDF, DOC, DOCX, JPG, JPEG, PNG · up to 25 MB</div>
        <input ref={input} type="file" accept={ACCEPT} className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      <Field label="Notes"><textarea className={textareaClass} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <p className="text-12 text-neutral-500">Uploading does not tick the checklist item — the document still needs review.</p>
    </Modal>
  );
}
