import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { useToast } from '@/components/Toast';
import { fmtDate } from '@/lib/format';
import { toolsApi, downloadDocument } from '../api';
import { formatBytes } from '../format';
import { Checkbox, Notice, RadioGroup, SelectField, TextField, Field } from '../workspace/fields';
import type { OptionsProps, ToolUI } from './types';
import type { LocalFile } from '../workspace/useToolWorkspace';

const pageNote = (f: LocalFile) => (typeof f.doc?.meta.page_count === 'number' ? `${f.doc.meta.page_count} page${f.doc.meta.page_count === 1 ? '' : 's'}` : null);
const encryptedGuard = (_v: unknown, files: LocalFile[]) => (files.some((f) => f.doc?.meta.encrypted === true) ? 'One of the files is password-protected. Use Unlock PDF first.' : null);

/* ── Page thumbnails (Split, e-Sign) ───────────────────────────────────── */
function useThumbs(doc: LocalFile['doc']) {
  return useQuery({
    queryKey: ['tools', 'pages', doc?.id],
    queryFn: () => toolsApi.documents.pages(doc!.id),
    enabled: Boolean(doc && doc.meta.encrypted !== true),
    staleTime: 5 * 60_000,
  });
}

function ThumbGrid({ doc, selected, onToggle, single = false }: { doc: LocalFile['doc']; selected: Set<number>; onToggle: (page: number) => void; single?: boolean }) {
  const q = useThumbs(doc);
  if (!doc) return null;
  if (q.isLoading) return <div className="text-12 text-neutral-500">Rendering page thumbnails…</div>;
  if (!q.data || q.data.thumbs.length === 0) return null;
  return (
    <div>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))' }}>
        {q.data.thumbs.map((t) => {
          const on = selected.has(t.page);
          return (
            <button
              key={t.page}
              type="button"
              onClick={() => onToggle(t.page)}
              aria-pressed={on}
              className={'group rounded border p-1 bg-white text-left transition-colors ' + (on ? 'border-gold ring-1 ring-gold' : 'border-neutral-200 hover:border-neutral-400')}
              title={single ? `Sign on page ${t.page}` : `Page ${t.page}`}
            >
              <img src={t.url} alt={`Page ${t.page}`} className="w-full h-auto rounded-sm bg-neutral-50" loading="lazy" />
              <span className={'block text-center text-11 mt-1 tabular-nums ' + (on ? 'text-neutral-900 font-medium' : 'text-neutral-500')}>{t.page}</span>
            </button>
          );
        })}
      </div>
      {q.data.truncated ? <p className="text-12 text-neutral-500 mt-2">Showing the first {q.data.thumbs.length} of {q.data.page_count} pages. Ranges may still name any page.</p> : null}
    </div>
  );
}

/* ── Merge ─────────────────────────────────────────────────────────────── */
export const mergePdfUI: ToolUI = {
  actionLabel: 'Merge PDFs',
  processingLabel: 'Merging…',
  reorderable: true,
  minFiles: 2,
  fileNote: pageNote,
  validate: encryptedGuard,
  Options: ({ files }) => {
    const pages = files.reduce((n, f) => n + (typeof f.doc?.meta.page_count === 'number' ? f.doc.meta.page_count : 0), 0);
    return files.length < 2
      ? <Notice>Add at least two PDFs. Use the arrows to set the order — the merged file follows it.</Notice>
      : <div className="text-13 text-neutral-500">{files.length} files · {pages} pages in total. The output follows the order above.</div>;
  },
  ResultNote: ({ output }) => <div className="text-13 text-neutral-500">{String(output.meta.files ?? 0)} files combined into {String(output.meta.page_count ?? 0)} pages.</div>,
};

/* ── Split ─────────────────────────────────────────────────────────────── */
function parseSelection(ranges: string, max: number): Set<number> {
  const s = new Set<number>();
  for (const part of ranges.split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]); const b = m[2] ? Number(m[2]) : a;
    for (let i = a; i <= Math.min(b, max); i++) if (i >= 1) s.add(i);
  }
  return s;
}
function toRanges(pages: Set<number>): string {
  const sorted = [...pages].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    let end = start;
    while (sorted[i + 1] === end + 1) { end = sorted[++i]; }
    out.push(start === end ? String(start) : `${start}-${end}`);
  }
  return out.join(', ');
}
function SplitOptions({ files, value, onChange, disabled }: OptionsProps) {
  const doc = files[0]?.doc;
  const pageCount = typeof doc?.meta.page_count === 'number' ? doc.meta.page_count : 0;
  const mode = value.mode === 'every' ? 'every' : 'ranges';
  const ranges = String(value.ranges ?? '');
  const selected = useMemo(() => parseSelection(ranges, pageCount), [ranges, pageCount]);
  if (!doc) return null;
  if (doc.meta.encrypted === true) return <Notice tone="warn">This PDF is password-protected. Use Unlock PDF first.</Notice>;
  return (
    <div className={disabled ? 'opacity-60 pointer-events-none' : ''}>
      <div className="text-13 text-neutral-500 mb-3">{pageCount} page{pageCount === 1 ? '' : 's'}. Each range becomes its own PDF; more than one range is delivered as a ZIP.</div>
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_200px] gap-3">
        <RadioGroup label="Split by" value={mode} onChange={(v) => onChange({ mode: v })}
          options={[{ value: 'ranges', label: 'Pages or ranges', hint: 'e.g. 1-3, 7, 10-12 — click thumbnails to pick' }, { value: 'every', label: 'Every N pages', hint: 'Equal chunks from the first page' }]} />
        {mode === 'ranges' ? (
          <TextField label="Ranges" value={ranges} onChange={(v) => onChange({ ranges: v })} placeholder="1-3, 7, 10-12" />
        ) : (
          <Field label="Pages per file">
            <input type="number" min={1} max={Math.max(pageCount, 1)} value={String(value.every ?? 1)} onChange={(e) => onChange({ every: Number(e.target.value) })}
              className="h-8 w-full px-2 text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold" />
          </Field>
        )}
      </div>
      {mode === 'ranges' ? (
        <div className="mt-4">
          <ThumbGrid doc={doc} selected={selected} onToggle={(p) => { const next = new Set(selected); if (next.has(p)) next.delete(p); else next.add(p); onChange({ ranges: toRanges(next) }); }} />
        </div>
      ) : null}
    </div>
  );
}
export const splitPdfUI: ToolUI = {
  actionLabel: 'Split PDF',
  processingLabel: 'Splitting…',
  defaults: { mode: 'ranges', ranges: '', every: 1 },
  fileNote: pageNote,
  Options: SplitOptions,
  validate: (v, files) => {
    const guard = encryptedGuard(v, files);
    if (guard) return guard;
    if (v.mode === 'every') return Number(v.every) >= 1 ? null : 'Enter how many pages each file should have.';
    return String(v.ranges ?? '').trim() ? null : 'Enter at least one page or range, or click thumbnails to pick pages.';
  },
  ResultNote: ({ output }) => {
    const ranges = (output.meta.ranges as string[] | undefined) ?? [];
    return <div className="text-13 text-neutral-500">{String(output.meta.parts ?? ranges.length)} file{output.meta.parts === 1 ? '' : 's'}: {ranges.join(', ')}{output.file_type === 'zip' ? ' — bundled as a ZIP.' : '.'}</div>;
  },
};

/* ── Compress ──────────────────────────────────────────────────────────── */
function CompressOptions({ files, value, onChange, disabled }: OptionsProps) {
  const f = files[0];
  return (
    <div className={disabled ? 'opacity-60 pointer-events-none' : ''}>
      {f ? <div className="text-13 text-neutral-500 mb-3">Original size: <span className="text-neutral-900 tabular-nums">{formatBytes(f.file.size)}</span></div> : null}
      <RadioGroup label="Compression level" value={String(value.level ?? 'recommended')} onChange={(v) => onChange({ level: v })}
        options={[
          { value: 'low', label: 'Low', hint: 'Best quality — images kept at print resolution (300 dpi)' },
          { value: 'recommended', label: 'Recommended', hint: 'Good for email and portal uploads (150 dpi)' },
          { value: 'high', label: 'High', hint: 'Smallest file — screen resolution (72 dpi), scans may soften' },
        ]} />
    </div>
  );
}
export const compressPdfUI: ToolUI = {
  actionLabel: 'Compress PDF',
  processingLabel: 'Compressing…',
  defaults: { level: 'recommended' },
  fileNote: pageNote,
  validate: encryptedGuard,
  Options: CompressOptions,
  ResultNote: ({ output }) => {
    const before = Number(output.meta.original_size ?? 0); const after = Number(output.meta.new_size ?? output.file_size);
    const pct = Number(output.meta.reduction_pct ?? 0);
    return <div className="text-13 text-neutral-900 tabular-nums">{formatBytes(before)} → {formatBytes(after)} <span className="text-neutral-500">· {pct > 0 ? `${pct}% smaller` : 'no reduction'}</span></div>;
  },
};

/* ── Unlock ────────────────────────────────────────────────────────────── */
function UnlockOptions({ files, value, onChange, disabled }: OptionsProps) {
  const doc = files[0]?.doc;
  if (doc && doc.meta.encrypted === false) return <Notice>This PDF isn't password-protected — there is nothing to unlock.</Notice>;
  return (
    <div className={'space-y-3 ' + (disabled ? 'opacity-60 pointer-events-none' : '')}>
      <TextField label="Password" type="password" autoComplete="off" value={String(value.password ?? '')} onChange={(v) => onChange({ password: v })} className="max-w-[320px]"
        hint="The password is used once to decrypt this file and is not stored." />
      <Checkbox checked={value.authorised === true} onChange={(v) => onChange({ authorised: v })}>
        I am authorised to decrypt this document
        <span className="block text-12 text-neutral-500">This confirmation is recorded in the audit trail with your name and the time.</span>
      </Checkbox>
      <Notice>Unlock PDF removes a password you already know. It does not guess, crack or bypass one.</Notice>
    </div>
  );
}
export const unlockPdfUI: ToolUI = {
  actionLabel: 'Unlock PDF',
  processingLabel: 'Decrypting…',
  defaults: { password: '', authorised: false },
  fileNote: (f) => (f.doc?.meta.encrypted === true ? 'password-protected' : f.doc?.meta.encrypted === false ? 'not encrypted' : null),
  Options: UnlockOptions,
  validate: (v, files) => {
    if (files[0]?.doc?.meta.encrypted === false) return "This PDF isn't password-protected.";
    if (!String(v.password ?? '')) return 'Enter the password for this PDF.';
    if (v.authorised !== true) return 'Confirm you are authorised to decrypt this document.';
    return null;
  },
  ResultNote: ({ output }) => <div className="text-13 text-neutral-500">Password removed. {String(output.meta.page_count ?? 0)} page{output.meta.page_count === 1 ? '' : 's'}, unencrypted.</div>,
};

/* ── e-Sign ────────────────────────────────────────────────────────────── */
function SignaturePad({ value, onChange, disabled }: { value: string; onChange: (png: string) => void; disabled: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const ctx = c.getContext('2d'); if (!ctx) return;
    ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1b2a55';
    if (!value) { ctx.clearRect(0, 0, c.width, c.height); dirty.current = false; }
  }, [value]);
  const pos = (e: React.PointerEvent) => {
    const c = ref.current!; const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };
  return (
    <div className="max-w-[360px]">
      <canvas
        ref={ref}
        width={720}
        height={200}
        className={'w-full h-[100px] rounded border border-neutral-300 bg-white touch-none ' + (disabled ? 'opacity-60' : 'cursor-crosshair')}
        onPointerDown={(e) => { if (disabled) return; drawing.current = true; const p = pos(e); const ctx = ref.current!.getContext('2d')!; ctx.beginPath(); ctx.moveTo(p.x, p.y); (e.target as Element).setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { if (!drawing.current) return; const p = pos(e); const ctx = ref.current!.getContext('2d')!; ctx.lineTo(p.x, p.y); ctx.stroke(); dirty.current = true; }}
        onPointerUp={() => { drawing.current = false; if (dirty.current) onChange(ref.current!.toDataURL('image/png')); }}
        aria-label="Draw your signature"
      />
      <div className="flex items-center justify-between mt-1">
        <span className="text-12 text-neutral-500">Draw with the mouse or finger (optional).</span>
        <button type="button" disabled={disabled || !value} onClick={() => onChange('')} className="text-12 text-neutral-500 hover:text-neutral-900 disabled:opacity-40">Clear</button>
      </div>
    </div>
  );
}
function ESignOptions({ files, value, onChange, disabled }: OptionsProps) {
  const doc = files[0]?.doc;
  const pageCount = typeof doc?.meta.page_count === 'number' ? doc.meta.page_count : 1;
  const page = Number(value.page ?? 1);
  if (doc?.meta.encrypted === true) return <Notice tone="warn">This PDF is password-protected. Use Unlock PDF first.</Notice>;
  return (
    <div className={'space-y-4 ' + (disabled ? 'opacity-60 pointer-events-none' : '')}>
      <Notice tone="warn">
        This applies a <strong>visible approval mark</strong> (name, designation, date) to the page. It is <strong>not</strong> a Digital Signature Certificate (DSC) signature and the output is not labelled as digitally signed.
      </Notice>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField label="Signer name" value={String(value.signer_name ?? '')} onChange={(v) => onChange({ signer_name: v })} />
        <TextField label="Designation" value={String(value.designation ?? '')} onChange={(v) => onChange({ designation: v })} placeholder="Partner, Manager…" />
        <TextField label="Date" value={String(value.date ?? '')} onChange={(v) => onChange({ date: v })} />
        <TextField label="Reason (optional)" value={String(value.reason ?? '')} onChange={(v) => onChange({ reason: v })} placeholder="Approved, Reviewed…" />
        <SelectField label="Placement" value={String(value.placement ?? 'bottom-right')} onChange={(v) => onChange({ placement: v })}
          options={[{ value: 'bottom-right', label: 'Bottom right' }, { value: 'bottom-left', label: 'Bottom left' }, { value: 'top-right', label: 'Top right' }, { value: 'top-left', label: 'Top left' }]} />
        <Field label={`Page (1–${pageCount})`}>
          <input type="number" min={1} max={pageCount} value={page} onChange={(e) => onChange({ page: Number(e.target.value) })}
            className="h-8 w-full px-2 text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold" />
        </Field>
      </div>
      <Field label="Drawn signature (optional)">
        <SignaturePad value={String(value.signature_png ?? '')} onChange={(png) => onChange({ signature_png: png })} disabled={disabled} />
      </Field>
      {pageCount > 1 ? (
        <Field label="Pick the page">
          <ThumbGrid doc={doc} selected={new Set([page])} onToggle={(p) => onChange({ page: p })} single />
        </Field>
      ) : null}
    </div>
  );
}
function useSignDefaults() {
  const { session } = useAuth();
  return useMemo(() => ({ signer_name: session?.employee?.full_name ?? '', designation: '', date: fmtDate(new Date()), reason: '', placement: 'bottom-right', page: 1, signature_png: '' }), [session]);
}
function ESignOptionsWithDefaults(props: OptionsProps) {
  const d = useSignDefaults();
  useEffect(() => { if (!props.value.signer_name && d.signer_name) props.onChange({ signer_name: d.signer_name }); if (!props.value.date) props.onChange({ date: d.date }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [d.signer_name]);
  return <ESignOptions {...props} />;
}
export const esignPdfUI: ToolUI = {
  actionLabel: 'Apply signature mark',
  processingLabel: 'Applying mark…',
  defaults: { placement: 'bottom-right', page: 1, signer_name: '', designation: '', date: '', reason: '', signature_png: '' },
  fileNote: pageNote,
  Options: ESignOptionsWithDefaults,
  validate: (v, files) => {
    const guard = encryptedGuard(v, files);
    if (guard) return guard;
    if (!String(v.signer_name ?? '').trim()) return 'Enter the signer name.';
    const max = typeof files[0]?.doc?.meta.page_count === 'number' ? files[0].doc.meta.page_count : 1;
    const p = Number(v.page ?? 1);
    if (!(p >= 1 && p <= max)) return `Page must be between 1 and ${max}.`;
    return null;
  },
  ResultNote: ({ output }) => {
    const s = (output.meta.signature as Record<string, unknown> | undefined) ?? {};
    return (
      <div className="text-13 text-neutral-500">
        Visible mark by <span className="text-neutral-900">{String(s.signer_name ?? '')}</span>{s.designation ? `, ${String(s.designation)}` : ''} on page {String(s.page ?? 1)} · {String(s.date ?? '')}. Not a DSC signature.
      </div>
    );
  },
};

/* ── OCR ───────────────────────────────────────────────────────────────── */
function OcrOptions({ value, onChange, disabled }: OptionsProps) {
  const outputs = (value.outputs as string[] | undefined) ?? ['pdf', 'txt'];
  const toggle = (k: string, on: boolean) => onChange({ outputs: on ? [...new Set([...outputs, k])] : outputs.filter((o) => o !== k) });
  return (
    <div className={'space-y-2 ' + (disabled ? 'opacity-60 pointer-events-none' : '')}>
      <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500">Outputs</span>
      <Checkbox checked={outputs.includes('pdf')} onChange={(v) => toggle('pdf', v)}>Searchable PDF <span className="text-neutral-500">— the original pages with an invisible text layer, so Find and copy work</span></Checkbox>
      <Checkbox checked={outputs.includes('txt')} onChange={(v) => toggle('txt', v)}>Text file (.txt) <span className="text-neutral-500">— plain text, one section per page</span></Checkbox>
      <p className="text-12 text-neutral-500">Language: English. Each page reports a confidence score; check low-confidence pages against the original.</p>
    </div>
  );
}
function OcrResult({ output, job }: { output: import('../types').ToolDocument; job: import('../types').ToolJob | null }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const meta = output.meta;
  const pages = (meta.pages as { page: number; confidence: number; chars: number }[] | undefined) ?? [];
  const text = String(meta.text ?? '');
  const extras = ((job?.meta.extra_outputs as { id: string; filename: string; size: number }[] | undefined) ?? []);
  const avg = Number(meta.average_confidence ?? 0);
  const tone = avg >= 85 ? 'text-neutral-900' : avg >= 60 ? 'text-amber' : 'text-red';
  return (
    <div className="space-y-3">
      <div className="text-13 text-neutral-500">
        Confidence <span className={`font-medium tabular-nums ${tone}`}>{avg}%</span> across {pages.length} page{pages.length === 1 ? '' : 's'}
        {pages.length > 1 ? <span> · {pages.map((p) => `p${p.page} ${p.confidence}%`).join(', ')}</span> : null}
      </div>
      {extras.length ? (
        <div className="text-13 text-neutral-500">
          Also saved: {extras.map((e) => (
            <button key={e.id} type="button" onClick={() => downloadDocument(e.id).catch((err: Error) => toast.push('error', err.message))} className="text-gold hover:text-gold-hover underline mr-2">{e.filename} ({formatBytes(e.size)})</button>
          ))}
        </div>
      ) : null}
      {text ? (
        <div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => setOpen((v) => !v)} className="text-13 text-neutral-700 underline hover:text-neutral-900">{open ? 'Hide text' : 'Show extracted text'}</button>
            <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(text); toast.push('success', 'Text copied.'); } catch { toast.push('error', 'Could not copy to the clipboard.'); } }}
              className="inline-flex items-center gap-1 text-13 text-neutral-700 hover:text-neutral-900"><Copy size={14} strokeWidth={1.75} />Copy text</button>
          </div>
          {open ? <pre className="mt-2 max-h-[320px] overflow-auto text-12 leading-5 whitespace-pre-wrap bg-neutral-50 border border-neutral-200 rounded p-3 text-neutral-900">{text}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}
export const ocrScanUI: ToolUI = {
  actionLabel: 'Run OCR',
  processingLabel: 'Recognising text…',
  defaults: { outputs: ['pdf', 'txt'] },
  fileNote: (f) => pageNote(f) ?? (typeof f.doc?.meta.width === 'number' ? `${f.doc.meta.width} × ${f.doc.meta.height} px` : null),
  Options: OcrOptions,
  validate: (v, files) => {
    const guard = encryptedGuard(v, files);
    if (guard) return guard;
    return ((v.outputs as string[] | undefined) ?? []).length ? null : 'Choose at least one output.';
  },
  ResultNote: OcrResult,
};
