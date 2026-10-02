import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Copy, Link as LinkIcon } from 'lucide-react';
import { api } from '@/services/api';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { Field, Modal, inputClass, textareaClass } from './components';

/**
 * "Send by email" for a quotation, invoice or engagement letter. The server
 * sends a plain-text email through the firm's SMTP account with a public
 * download LINK in the body — nothing here builds a mailto: link.
 */
export type EmailKind = 'quotation' | 'invoice' | 'engagement';

const split = (v: string) => v.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

export function SendEmailDialog({ open, onClose, kind, id, to, subject, message }: {
  open: boolean;
  onClose: () => void;
  kind: EmailKind;
  id: string;
  to: string | null | undefined;
  subject: string;
  message: string;
}) {
  const toast = useToast();
  const status = useQuery({
    queryKey: ['share.email.status'],
    queryFn: () => api.get<{ configured: boolean; from: string | null }>('/api/share/email/status'),
    enabled: open,
    staleTime: 60_000,
  });
  const link = useQuery({
    queryKey: ['share.public-link', kind, id],
    queryFn: () => api.post<{ url: string; file: string }>('/api/share/public-link', { kind, id }),
    enabled: open,
    staleTime: 60_000,
  });
  const [v, setV] = useState({ to: to ?? '', cc: '', subject, message });
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const send = useMutation({
    mutationFn: () => api.post<{ sent: boolean; link: string; file: string }>('/api/share/email', {
      kind, id, to: split(v.to), cc: split(v.cc), subject: v.subject, message: v.message,
    }),
    onSuccess: () => { toast.push('success', 'Email sent with the download link.'); onClose(); },
    onError: (e: Error) => setError(e.message),
  });

  const submit = () => {
    const bad = [...split(v.to), ...split(v.cc)].find((x) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
    if (!split(v.to).length) return setError('Add at least one recipient.');
    if (bad) return setError(`"${bad}" is not a valid email address.`);
    if (!v.subject.trim()) return setError('Subject is required.');
    setError(null);
    send.mutate();
  };

  const copy = async () => {
    if (!link.data) return;
    try { await navigator.clipboard.writeText(link.data.url); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { toast.push('error', 'Could not copy. Select the link and copy it manually.'); }
  };

  const configured = status.data?.configured;
  return (
    <Modal open={open} title="Send by email" onClose={onClose} width="w-[600px]" footer={
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={!configured || send.isPending} onClick={submit}>
          {send.isPending ? 'Sending…' : 'Send email'}
        </Button>
      </div>
    }>
      <div className="p-4 space-y-3">
        {status.isLoading ? <p className="text-13 text-neutral-500">Checking email settings…</p> : null}
        {status.data && !configured ? (
          <div className="border-l-2 border-amber bg-white px-3 py-2 text-13 text-neutral-700">
            Email is not set up on the server yet. An administrator needs to add the firm&apos;s mailbox
            (SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM) to <code>backend/.env</code>.
          </div>
        ) : null}
        {status.data?.from ? <p className="text-12 text-neutral-500">From: {status.data.from}</p> : null}
        {error ? <div className="border-l-2 border-red pl-3 text-13 text-red">{error}</div> : null}
        <Field label="To" hint="Separate several addresses with commas.">
          <input className={inputClass} value={v.to} onChange={(e) => setV({ ...v, to: e.target.value })} autoFocus />
        </Field>
        <Field label="CC">
          <input className={inputClass} value={v.cc} onChange={(e) => setV({ ...v, cc: e.target.value })} />
        </Field>
        <Field label="Subject">
          <input className={inputClass} value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} />
        </Field>
        <Field label="Message">
          <textarea className={`${textareaClass} min-h-[160px]`} value={v.message} onChange={(e) => setV({ ...v, message: e.target.value })} />
        </Field>
        <div>
          <p className="text-12 text-neutral-500 mb-1">Download link (added to the email automatically — do not include it in the message):</p>
          <div className="flex items-center gap-2 border border-neutral-200 rounded px-2 py-1.5">
            <LinkIcon size={14} className="shrink-0 text-neutral-500" />
            <input readOnly value={link.data?.url ?? (link.isLoading ? 'Preparing…' : (link.error as Error | undefined)?.message ?? '')}
              className="min-w-0 flex-1 bg-transparent text-12 text-neutral-700 outline-none" onFocus={(e) => e.currentTarget.select()} />
            <button type="button" onClick={copy} disabled={!link.data}
              className="shrink-0 h-7 px-2 inline-flex items-center gap-1 text-12 text-neutral-700 rounded border border-neutral-200 hover:bg-neutral-50 disabled:opacity-50">
              {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
