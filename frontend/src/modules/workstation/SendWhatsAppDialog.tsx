import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, Link as LinkIcon } from 'lucide-react';
import { api } from '@/services/api';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { RevokeLinksButton } from './RevokeLinksButton';
import { Field, Modal, inputClass, textareaClass } from './components';
import { waNumber, waNumberProblem } from './share';
import type { EmailKind } from './SendEmailDialog';

/**
 * "Send on WhatsApp" for a quotation, invoice or engagement letter.
 *
 * The message carries a public download link, not the file. On a device with
 * the WhatsApp Business API configured the server sends the message from the
 * firm's number; otherwise wa.me opens WhatsApp with the note + link already
 * typed.
 */
export function SendWhatsAppDialog({ open, onClose, kind, id, phone, note }: {
  open: boolean;
  onClose: () => void;
  kind: EmailKind;
  id: string;
  /** The client's saved number, as stored. */
  phone: string | null | undefined;
  /** Covering note, no link — the link is shown separately and appended on send. */
  note: string;
}) {
  const toast = useToast();
  const status = useQuery({
    queryKey: ['share.whatsapp.status'],
    queryFn: () => api.get<{ configured: boolean; mode: 'template' | 'text' | null }>('/api/share/whatsapp/status'),
    enabled: open,
    staleTime: 60_000,
  });
  const link = useQuery({
    queryKey: ['share.public-link', kind, id],
    queryFn: () => api.post<{ url: string; file: string }>('/api/share/public-link', { kind, id }),
    enabled: open,
    staleTime: 60_000,
  });

  const [num, setNum] = useState(phone ?? '');
  const [text, setText] = useState(note);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) { setNum(phone ?? ''); setText(note); setError(null); setCopied(false); }
  }, [open, phone, note]);

  const api_ = status.data?.configured === true;

  const checkedNumber = (): string | null => {
    const n = waNumber(num);
    const problem = waNumberProblem(n);
    if (problem) { setError(problem); return null; }
    return n;
  };

  /** Server sends the message from the firm's business number. */
  const sendViaApi = async () => {
    const n = checkedNumber();
    if (!n) return;
    setError(null);
    setBusy(true);
    try {
      await api.post<{ sent: boolean; file: string; to: string }>('/api/share/whatsapp', { kind, id, to: `+${n}`, message: text });
      toast.push('success', `WhatsApp message sent to +${n}.`);
      onClose();
    } catch (e) {
      setError((e as Error).message || 'WhatsApp did not accept the message.');
    } finally {
      setBusy(false);
    }
  };

  /** No Business API: open wa.me with the note + link already typed. */
  const openWhatsApp = () => {
    const n = checkedNumber();
    if (!n) return;
    if (!link.data) { setError('The download link is still being prepared.'); return; }
    setError(null);
    const body = `${text.trimEnd()}\n\n${link.data.url}`;
    window.open(`https://wa.me/${n}?text=${encodeURIComponent(body)}`, '_blank', 'noopener');
    onClose();
  };

  const copy = async () => {
    if (!link.data) return;
    try { await navigator.clipboard.writeText(link.data.url); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { toast.push('error', 'Could not copy. Select the link and copy it manually.'); }
  };

  return (
    <Modal open={open} title="Send on WhatsApp" onClose={onClose} width="w-[560px]" footer={
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" onClick={onClose}>Cancel</Button>
        {api_ ? (
          <Button size="sm" variant="primary" disabled={busy || !link.data} onClick={sendViaApi}>
            {busy ? 'Sending…' : 'Send on WhatsApp'}
          </Button>
        ) : status.data ? (
          <Button size="sm" variant="primary" disabled={!link.data} onClick={openWhatsApp}>
            Open WhatsApp
          </Button>
        ) : null}
      </div>
    }>
      <div className="p-4 space-y-3">
        {status.isLoading ? <p className="text-13 text-neutral-500">Checking WhatsApp settings…</p> : null}
        {api_ && status.data?.mode === 'template' ? (
          <p className="text-12 text-neutral-500">Sent as a WhatsApp Business template message with the client&apos;s name and the download link. Your message below is <b>not</b> sent — WhatsApp only accepts an approved template when starting a new conversation (24-hour rule).</p>
        ) : null}
        {api_ && status.data?.mode === 'text' ? (
          <p className="text-12 text-neutral-500">Sent as a WhatsApp message from your business number with the message below and the link appended.</p>
        ) : null}
        {!api_ && status.data ? (
          <p className="text-12 text-neutral-500">WhatsApp opens with the message below and the link appended. Press the send arrow to deliver it.</p>
        ) : null}
        {error ? <div className="border-l-2 border-red pl-3 text-13 text-red">{error}</div> : null}
        <Field label="WhatsApp number" hint="From the client's record; change it if their WhatsApp number is different. Other countries: start with + and the country code.">
          <input className={inputClass} value={num} inputMode="tel" onChange={(e) => setNum(e.target.value)} placeholder="98765 43210" autoFocus />
        </Field>
        <Field label="Message">
          <textarea className={`${textareaClass} min-h-[120px]`} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <div>
          <p className="text-12 text-neutral-500 mb-1">Download link (added automatically — do not include it in the message):</p>
          <div className="flex items-center gap-2 border border-neutral-200 rounded px-2 py-1.5">
            <LinkIcon size={14} className="shrink-0 text-neutral-500" />
            <input readOnly value={link.data?.url ?? (link.isLoading ? 'Preparing…' : (link.error as Error | undefined)?.message ?? '')}
              className="min-w-0 flex-1 bg-transparent text-12 text-neutral-700 outline-none" onFocus={(e) => e.currentTarget.select()} />
            <button type="button" onClick={copy} disabled={!link.data}
              className="shrink-0 h-7 px-2 inline-flex items-center gap-1 text-12 text-neutral-700 rounded border border-neutral-200 hover:bg-neutral-50 disabled:opacity-50">
              {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
            </button>
          </div>
          <RevokeLinksButton kind={kind} id={id} />
        </div>
      </div>
    </Modal>
  );
}
