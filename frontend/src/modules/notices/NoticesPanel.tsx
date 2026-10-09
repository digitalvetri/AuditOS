/**
 * GST notices on the client view (GstClientView.tsx).
 *
 * Flow: pick a notice kind → upload the PDF/image → backend OCRs it and asks
 * Groq to extract fields → user corrects the fields and types in grounds /
 * facts / prayer → "Generate draft" calls Groq a second time with those
 * inputs → draft shows inline as editable Markdown. Save pushes the edited
 * draft back; Regenerate re-runs with the latest inputs.
 *
 * Only four notice kinds are modelled, DRC-07 is the one we tuned the prompts
 * for — the other three share the same shape.
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Loader2, Sparkles, Trash2, Upload } from 'lucide-react';
import { Card, Field, Modal, inputClass, textareaClass } from '@/modules/workstation/components';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import {
  NOTICE_KINDS,
  NOTICE_KIND_LABEL,
  NOTICE_KIND_READY,
  noticesApi,
  noticesKeys,
  type Notice,
  type NoticeKind,
  type ReplyInputs,
} from './api';
import { useAiProcessingEnabled } from '@/modules/dataProtection/api';
import { confirmAction } from '@/components/ConfirmDialog';

const EMPTY_INPUTS: ReplyInputs = {
  grounds: '',
  facts: '',
  documents_in_support: '',
  prayer: '',
  taxpayer_name: '',
  taxpayer_gstin: '',
};

function fmtMoney(n: number | null): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);
}

function statusTint(s: Notice['status']): string {
  if (s === 'sent') return 'text-green';
  if (s === 'review') return 'text-amber';
  if (s === 'closed') return 'text-neutral-500';
  return 'text-neutral-600';
}

export function NoticesPanel({ clientId, taxpayerName, taxpayerGstin }: {
  clientId: string;
  taxpayerName: string;
  taxpayerGstin: string;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: noticesKeys.list(clientId),
    queryFn: () => noticesApi.listByClient(clientId),
    enabled: !!clientId,
  });

  const notices = list.data ?? [];
  const selected = selectedId ? notices.find((n) => n.id === selectedId) ?? null : null;

  return (
    <Card
      title="GST Notices & Replies"
      right={
        <button
          type="button"
          onClick={() => setUploadOpen(true)}
          className="inline-flex items-center gap-1 h-8 px-3 text-13 border border-neutral-300 rounded hover:border-neutral-400"
        >
          <Upload size={14} /> Upload notice
        </button>
      }
    >
      {list.isLoading ? (
        <div className="px-4 py-6 text-13 text-neutral-500">Loading notices…</div>
      ) : notices.length === 0 ? (
        <div className="px-4 py-6 text-13 text-neutral-500">
          No notices yet. Upload a departmental notice (DRC-07, DRC-01, ASMT-10, GSTR-3A) and
          we'll extract the facts and draft a reply.
        </div>
      ) : (
        <div>
          {notices.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => setSelectedId(n.id === selectedId ? null : n.id)}
              className={
                'w-full text-left px-4 py-2 flex items-center gap-3 text-13 border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50 ' +
                (selectedId === n.id ? 'bg-neutral-50' : '')
              }
            >
              <span className="font-medium text-neutral-900 min-w-[180px]">{NOTICE_KIND_LABEL[n.kind]}</span>
              <span className="text-neutral-600 flex-1 truncate">
                {n.reference_no ?? <span className="text-neutral-400">no reference captured</span>}
                {n.financial_year ? <span className="ml-2 text-neutral-500">· FY {n.financial_year}</span> : null}
              </span>
              <span className="text-neutral-600 tabular-nums">{fmtMoney(n.total_demand)}</span>
              <span className={`uppercase text-11 tracking-[0.06em] ${statusTint(n.status)}`}>{n.status}</span>
            </button>
          ))}
        </div>
      )}

      {selected ? (
        <NoticeDetail
          key={selected.id}
          notice={selected}
          taxpayerName={taxpayerName}
          taxpayerGstin={taxpayerGstin}
          onDeleted={() => {
            setSelectedId(null);
            qc.invalidateQueries({ queryKey: noticesKeys.list(clientId) });
          }}
        />
      ) : null}

      <UploadModal
        open={uploadOpen}
        clientId={clientId}
        onClose={() => setUploadOpen(false)}
        onUploaded={(n) => {
          setUploadOpen(false);
          setSelectedId(n.id);
          qc.invalidateQueries({ queryKey: noticesKeys.list(clientId) });
          toast.push('success', 'Notice uploaded. Review the extracted fields and generate a draft.');
        }}
      />
    </Card>
  );
}

function UploadModal({ open, clientId, onClose, onUploaded }: {
  open: boolean;
  clientId: string;
  onClose: () => void;
  onUploaded: (n: Notice) => void;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<NoticeKind>('DRC07');
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('Choose a file first.');
      return noticesApi.upload({ clientId, kind, file });
    },
    onSuccess: (n) => {
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      onUploaded(n);
    },
    onError: (e) => toast.push('error', e instanceof Error ? e.message : 'Upload failed.'),
  });

  return (
    <Modal
      open={open}
      title="Upload GST notice"
      onClose={() => { if (!upload.isPending) { setFile(null); onClose(); } }}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={upload.isPending}
                  className="h-9 px-4 text-13 border border-neutral-300 rounded hover:border-neutral-400 disabled:opacity-60">
            Cancel
          </button>
          <Button onClick={() => upload.mutate()} disabled={!file || upload.isPending}>
            {upload.isPending ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" /> Extracting…
              </span>
            ) : 'Upload & extract'}
          </Button>
        </>
      }
    >
      <Field label="Notice type">
        <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as NoticeKind)}>
          {NOTICE_KINDS.map((k) => (
            <option key={k} value={k} disabled={!NOTICE_KIND_READY[k]}>
              {NOTICE_KIND_LABEL[k]}{NOTICE_KIND_READY[k] ? '' : ' (coming soon)'}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="PDF or image"
        hint="PDF (text or scanned) or PNG/JPG. Up to 15 MB. Scanned pages are OCR'd automatically."
      >
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/webp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-13 file:mr-3 file:py-1.5 file:px-3 file:text-13 file:border file:border-neutral-300 file:rounded file:bg-white"
        />
      </Field>
      {upload.isPending ? (
        <div className="text-12 text-neutral-500 mt-2">
          OCR + LLM extraction can take 10–30 seconds on a scanned PDF.
        </div>
      ) : null}
    </Modal>
  );
}

function NoticeDetail({ notice, taxpayerName, taxpayerGstin, onDeleted }: {
  notice: Notice;
  taxpayerName: string;
  taxpayerGstin: string;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [fields, setFields] = useState({
    reference_no: notice.reference_no ?? '',
    notice_date: notice.notice_date ?? '',
    section: notice.section ?? '',
    financial_year: notice.financial_year ?? '',
    period_from: notice.period_from ?? '',
    period_to: notice.period_to ?? '',
    officer_name: notice.officer_name ?? '',
    officer_designation: notice.officer_designation ?? '',
    jurisdiction: notice.jurisdiction ?? '',
    total_demand: notice.total_demand != null ? String(notice.total_demand) : '',
  });
  const [inputs, setInputs] = useState<ReplyInputs>({
    ...EMPTY_INPUTS,
    ...(notice.reply_inputs ?? {}),
    taxpayer_name: notice.reply_inputs?.taxpayer_name || taxpayerName,
    taxpayer_gstin: notice.reply_inputs?.taxpayer_gstin || taxpayerGstin,
  });
  const [draft, setDraft] = useState(notice.draft_content ?? '');
  // Once the reply has gone out its text is the record — the server refuses edits.
  const replySent = notice.status === 'sent' || notice.status === 'closed';
  const [clientLetter, setClientLetter] = useState(notice.client_letter ?? '');
  // The firm's switch for sending notice text to the outside AI service.
  const aiOn = useAiProcessingEnabled();

  const saveFields = useMutation({
    mutationFn: () =>
      noticesApi.update(notice.id, {
        reference_no: fields.reference_no || null,
        notice_date: fields.notice_date || null,
        section: fields.section || null,
        financial_year: fields.financial_year || null,
        period_from: fields.period_from || null,
        period_to: fields.period_to || null,
        officer_name: fields.officer_name || null,
        officer_designation: fields.officer_designation || null,
        jurisdiction: fields.jurisdiction || null,
        total_demand: fields.total_demand ? Number(fields.total_demand.replace(/[, ]/g, '')) : null,
        reply_inputs: inputs,
      } as Partial<Notice>),
    onSuccess: () => {
      toast.push('success', 'Saved.');
      qc.invalidateQueries({ queryKey: noticesKeys.list(notice.client_id) });
    },
    onError: (e) => toast.push('error', e instanceof Error ? e.message : 'Save failed.'),
  });

  const generate = useMutation({
    mutationFn: () => noticesApi.generate(notice.id, inputs),
    onSuccess: (n) => {
      setDraft(n.draft_content ?? '');
      qc.invalidateQueries({ queryKey: noticesKeys.list(notice.client_id) });
      toast.push('success', 'Draft generated. Review before sending.');
    },
    onError: (e) => toast.push('error', e instanceof Error ? e.message : 'Draft generation failed.'),
  });

  const saveDraft = useMutation({
    mutationFn: () => noticesApi.update(notice.id, { draft_content: draft } as Partial<Notice>),
    onSuccess: () => toast.push('success', 'Draft saved.'),
    onError: (e) => toast.push('error', e instanceof Error ? e.message : 'Save failed.'),
  });

  const regenerateClientLetter = useMutation({
    mutationFn: () => noticesApi.regenerateClientLetter(notice.id),
    onSuccess: (n) => {
      setClientLetter(n.client_letter ?? '');
      qc.invalidateQueries({ queryKey: noticesKeys.list(notice.client_id) });
      toast.push('success', 'Client letter regenerated.');
    },
    onError: (e) => toast.push('error', e instanceof Error ? e.message : 'Regenerate failed.'),
  });

  const saveClientLetter = useMutation({
    mutationFn: () => noticesApi.update(notice.id, { client_letter: clientLetter } as Partial<Notice>),
    onSuccess: () => toast.push('success', 'Client letter saved.'),
    onError: (e) => toast.push('error', e instanceof Error ? e.message : 'Save failed.'),
  });

  const remove = useMutation({
    mutationFn: () => noticesApi.remove(notice.id),
    onSuccess: () => {
      toast.push('success', 'Notice removed.');
      onDeleted();
    },
    onError: (e) => toast.push('error', e instanceof Error ? e.message : 'Delete failed.'),
  });

  return (
    <div className="border-t border-neutral-200 px-4 py-4 space-y-4 bg-neutral-50/50">
      <div className="flex items-center justify-between">
        <div className="text-12 text-neutral-500">
          Uploaded {new Date(notice.created_at).toLocaleString('en-IN')} ·{' '}
          {notice.uploaded_file_name ?? 'file'} ·{' '}
          {notice.extraction_source === 'tesseract'
            ? 'OCR used'
            : notice.extraction_source === 'pdf-parse'
              ? 'Text layer used'
              : 'No text extracted'}
          {notice.llm_model ? ` · model ${notice.llm_model}` : ''}
        </div>
        <button
          type="button"
          onClick={async () => { if (await confirmAction('Remove this notice?')) remove.mutate(); }}
          className="inline-flex items-center gap-1 h-8 px-2 text-12 text-neutral-500 hover:text-red"
        >
          <Trash2 size={13} /> Remove
        </button>
      </div>

      {/* Extracted / editable fields */}
      <div>
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">Extracted details — correct any OCR mistakes</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Field label="Reference no">
            <input className={inputClass} value={fields.reference_no}
                   onChange={(e) => setFields({ ...fields, reference_no: e.target.value })} />
          </Field>
          <Field label="Notice date">
            <input type="date" className={inputClass} value={fields.notice_date}
                   onChange={(e) => setFields({ ...fields, notice_date: e.target.value })} />
          </Field>
          <Field label="Section">
            <input className={inputClass} value={fields.section} placeholder="74"
                   onChange={(e) => setFields({ ...fields, section: e.target.value })} />
          </Field>
          <Field label="Financial year">
            <input className={inputClass} value={fields.financial_year} placeholder="2023-2024"
                   onChange={(e) => setFields({ ...fields, financial_year: e.target.value })} />
          </Field>
          <Field label="Period from">
            <input type="date" className={inputClass} value={fields.period_from}
                   onChange={(e) => setFields({ ...fields, period_from: e.target.value })} />
          </Field>
          <Field label="Period to">
            <input type="date" className={inputClass} value={fields.period_to}
                   onChange={(e) => setFields({ ...fields, period_to: e.target.value })} />
          </Field>
          <Field label="Officer name">
            <input className={inputClass} value={fields.officer_name}
                   onChange={(e) => setFields({ ...fields, officer_name: e.target.value })} />
          </Field>
          <Field label="Officer designation">
            <input className={inputClass} value={fields.officer_designation}
                   onChange={(e) => setFields({ ...fields, officer_designation: e.target.value })} />
          </Field>
          <Field label="Jurisdiction">
            <input className={inputClass} value={fields.jurisdiction}
                   onChange={(e) => setFields({ ...fields, jurisdiction: e.target.value })} />
          </Field>
          <Field label="Total demand (₹)">
            <input className={inputClass} value={fields.total_demand} placeholder="103580"
                   onChange={(e) => setFields({ ...fields, total_demand: e.target.value })} />
          </Field>
        </div>
      </div>

      {/* Practitioner inputs */}
      <div>
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">Reply inputs — your client's side</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Facts of the case" hint="What actually happened — supply the chronology in your own words.">
            <textarea rows={5} className={textareaClass} value={inputs.facts}
                      onChange={(e) => setInputs({ ...inputs, facts: e.target.value })} />
          </Field>
          <Field label="Grounds / submissions" hint="Each ground as its own paragraph. Cite the specific section/rule where you want it named.">
            <textarea rows={5} className={textareaClass} value={inputs.grounds}
                      onChange={(e) => setInputs({ ...inputs, grounds: e.target.value })} />
          </Field>
          <Field label="Documents in support (optional)">
            <textarea rows={2} className={textareaClass} value={inputs.documents_in_support ?? ''}
                      onChange={(e) => setInputs({ ...inputs, documents_in_support: e.target.value })} />
          </Field>
          <Field label="Prayer (optional)" hint='e.g. "drop the demand entirely", "grant a personal hearing"'>
            <textarea rows={2} className={textareaClass} value={inputs.prayer ?? ''}
                      onChange={(e) => setInputs({ ...inputs, prayer: e.target.value })} />
          </Field>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {aiOn ? (
          <Button onClick={() => generate.mutate()}
                  disabled={replySent || generate.isPending || (!inputs.facts.trim() && !inputs.grounds.trim())}>
            {generate.isPending ? (
              <span className="inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Generating…</span>
            ) : (
              <span className="inline-flex items-center gap-2"><Sparkles size={14} /> {draft ? 'Regenerate draft' : 'Generate draft'}</span>
            )}
          </Button>
        ) : (
          <span className="text-12 text-neutral-500" data-testid="notice-ai-off">
            AI drafting is switched off for this firm. Write the reply below by hand.
          </span>
        )}
        <button type="button" onClick={() => saveFields.mutate()} disabled={saveFields.isPending}
                className="h-9 px-3 text-13 border border-neutral-300 rounded hover:border-neutral-400 disabled:opacity-60">
          {saveFields.isPending ? 'Saving…' : 'Save details & inputs'}
        </button>
      </div>

      {clientLetter ? (
        <div>
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Letter to the client</div>
              <div className="text-12 text-neutral-500">Send this to {taxpayerName} to brief them on the notice.</div>
            </div>
            <div className="flex items-center gap-2">
              {aiOn ? <button
                type="button"
                onClick={() => regenerateClientLetter.mutate()}
                disabled={regenerateClientLetter.isPending}
                className="inline-flex items-center gap-1 h-8 px-2 text-12 border border-neutral-300 rounded hover:border-neutral-400 disabled:opacity-60"
              >
                {regenerateClientLetter.isPending ? (
                  <><Loader2 size={13} className="animate-spin" /> Regenerating…</>
                ) : (
                  <><Sparkles size={13} /> Regenerate</>
                )}
              </button> : null}
              <button
                type="button"
                onClick={async () => {
                  try { await navigator.clipboard.writeText(clientLetter); toast.push('success', 'Copied.'); }
                  catch { toast.push('error', 'Could not copy.'); }
                }}
                className="inline-flex items-center gap-1 h-8 px-2 text-12 border border-neutral-300 rounded hover:border-neutral-400"
              >
                <Copy size={13} /> Copy
              </button>
              <button
                type="button"
                onClick={() => saveClientLetter.mutate()}
                disabled={saveClientLetter.isPending}
                className="h-8 px-2 text-12 border border-neutral-300 rounded hover:border-neutral-400 disabled:opacity-60"
              >
                {saveClientLetter.isPending ? 'Saving…' : 'Save edits'}
              </button>
            </div>
          </div>
          <textarea
            rows={12}
            className={`${textareaClass} font-mono text-12`}
            value={clientLetter}
            onChange={(e) => setClientLetter(e.target.value)}
          />
        </div>
      ) : null}

      {draft ? (
        <div>
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Reply to the department</div>
              <div className="text-12 text-neutral-500">
                File this with the officer named on the notice. Fill in the Reply inputs above and click Regenerate for a tailored version.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(draft);
                    toast.push('success', 'Copied to clipboard.');
                  } catch {
                    toast.push('error', 'Could not copy.');
                  }
                }}
                className="inline-flex items-center gap-1 h-8 px-2 text-12 border border-neutral-300 rounded hover:border-neutral-400"
              >
                <Copy size={13} /> Copy
              </button>
              <button
                type="button"
                onClick={() => saveDraft.mutate()}
                disabled={saveDraft.isPending || replySent}
                title={replySent ? 'The reply is marked sent; its text can no longer be edited.' : undefined}
                className="h-8 px-2 text-12 border border-neutral-300 rounded hover:border-neutral-400 disabled:opacity-60"
              >
                {saveDraft.isPending ? 'Saving…' : 'Save edits'}
              </button>
            </div>
          </div>
          <textarea
            rows={16}
            className={`${textareaClass} font-mono text-12`}
            value={draft}
            readOnly={replySent}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
      ) : null}
    </div>
  );
}
