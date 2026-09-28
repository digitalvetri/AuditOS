import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Paperclip, Smartphone } from 'lucide-react';
import { api } from '@/services/api';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { Field, Modal, inputClass, textareaClass } from './components';
import { shareDocumentPdf, waNumber, waNumberProblem, whatsappHint } from './share';
import type { EmailKind } from './SendEmailDialog';

/**
 * "Send on WhatsApp" for a quotation, invoice or engagement letter.
 *
 * With the WhatsApp Business API configured on the server, the server sends
 * the PDF itself as a WhatsApp DOCUMENT from the firm's number — the only way
 * a file reaches WhatsApp from any computer.
 *
 * Without it, a browser can only open a chat with text: phones and
 * Windows/macOS get the native share sheet (real file); elsewhere the PDF is
 * downloaded and must be dragged into the chat — the form says so plainly
 * instead of implying it was attached.
 *
 * The saved client number is only a starting point: it is shown, editable and
 * checked, because a wrong or non-WhatsApp number is the usual failure.
 */
export function SendWhatsAppDialog({ open, onClose, kind, id, phone, fileName, note, issueUrl }: {
  open: boolean;
  onClose: () => void;
  kind: EmailKind;
  id: string;
  /** The client's saved number, as stored. */
  phone: string | null | undefined;
  fileName: string;
  note: string;
  issueUrl: () => Promise<{ url: string }>;
}) {
  const toast = useToast();
  const status = useQuery({
    queryKey: ['share.whatsapp.status'],
    queryFn: () => api.get<{ configured: boolean; mode: 'template' | 'document' | null }>('/api/share/whatsapp/status'),
    enabled: open,
    staleTime: 60_000,
  });
  const [num, setNum] = useState(phone ?? '');
  const [text, setText] = useState(note);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Each time the form opens it starts from the client's saved number.
  useEffect(() => {
    if (open) { setNum(phone ?? ''); setText(note); setError(null); }
  }, [open, phone, note]);

  const api_ = status.data?.configured === true;

  // Without the Business API the phone is the way to attach the file: a QR
  // code opens /send on the phone, whose share sheet hands WhatsApp the PDF.
  const [qrNote, setQrNote] = useState(note);
  useEffect(() => { const t = setTimeout(() => setQrNote(text), 600); return () => clearTimeout(t); }, [text]);
  const phoneLink = useQuery({
    queryKey: ['share.phone-link', kind, id, qrNote],
    queryFn: () => api.post<{ url: string; qr: string; expires_at: string }>('/api/share/phone-link', { kind, id, note: qrNote }),
    enabled: open && status.data?.configured === false,
    staleTime: 20 * 60_000,
  });

  const checkedNumber = (): string | null => {
    const n = waNumber(num);
    const problem = waNumberProblem(n);
    if (problem) { setError(problem); return null; }
    return n;
  };

  /** Server sends the PDF as a WhatsApp document (Business API). */
  const sendViaApi = async () => {
    const n = checkedNumber();
    if (!n) return;
    setError(null);
    setBusy(true);
    try {
      const r = await api.post<{ attachment: string; to: string }>('/api/share/whatsapp', { kind, id, to: `+${n}`, message: text });
      toast.push('success', `${r.attachment} sent on WhatsApp to +${r.to}.`);
      onClose();
    } catch (e) {
      setError((e as Error).message || 'WhatsApp did not accept the message.');
    } finally {
      setBusy(false);
    }
  };

  /** No Business API: share sheet where the device has one, else download + open the chat. */
  const sendManually = async (withNumber: boolean) => {
    const n = withNumber ? checkedNumber() : '';
    if (n === null) return;
    setError(null);
    setBusy(true);
    try {
      const r = await shareDocumentPdf({ issueUrl, fileName, note: text, channel: 'whatsapp', phone: n });
      const hint = whatsappHint(r, fileName);
      if (hint) toast.push('info', hint);
      if (r !== 'cancelled') onClose();
    } catch (e) {
      setError((e as Error).message || 'The PDF could not be prepared.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title="Send on WhatsApp" onClose={onClose} width="w-[560px]" footer={
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" onClick={onClose}>Cancel</Button>
        {api_ ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={sendViaApi}>
            {busy ? 'Sending…' : 'Send PDF on WhatsApp'}
          </Button>
        ) : status.data ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => sendManually(false)} title="Open WhatsApp and pick the contact there">
              Choose chat in WhatsApp
            </Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => sendManually(true)}>
              {busy ? 'Preparing PDF…' : 'Download PDF & open chat'}
            </Button>
          </>
        ) : null}
      </div>
    }>
      <div className="p-4 space-y-3">
        {status.isLoading ? <p className="text-13 text-neutral-500">Checking WhatsApp settings…</p> : null}
        {status.data && !api_ ? (
          <div className="border border-neutral-200 rounded p-3 flex gap-3 items-start">
            <div className="shrink-0 w-[150px] h-[150px] flex items-center justify-center bg-white">
              {phoneLink.data ? <img src={phoneLink.data.qr} alt="QR code to send this PDF from your phone" width={150} height={150} />
                : phoneLink.isError ? <span className="text-12 text-red text-center">{(phoneLink.error as Error).message}</span>
                : <span className="text-12 text-neutral-500">Making QR code…</span>}
            </div>
            <div className="text-13 text-neutral-700 space-y-1 min-w-0">
              <p className="font-medium flex items-center gap-1.5"><Smartphone size={15} /> Send the PDF from your phone</p>
              <ol className="list-decimal pl-4 space-y-0.5">
                <li>Scan this code with your phone&apos;s camera (phone on the same Wi-Fi).</li>
                <li>Tap <b>Send PDF on WhatsApp</b>, pick the client.</li>
              </ol>
              <p className="text-12 text-neutral-500">The PDF arrives <b>attached</b>. A computer&apos;s browser cannot attach files to WhatsApp; a phone can. Code valid 30 minutes.</p>
            </div>
          </div>
        ) : null}
        {status.data && !api_ ? (
          <p className="text-12 text-neutral-500">
            Or from this computer: <b>Download PDF &amp; open chat</b> downloads {fileName} and opens WhatsApp — then drag the file into the chat before sending.
          </p>
        ) : null}
        {api_ && status.data?.mode === 'template' ? (
          <p className="text-12 text-neutral-500">Sent from your WhatsApp Business number using your approved message template, with the PDF attached.</p>
        ) : null}
        {api_ && status.data?.mode === 'document' ? (
          <p className="text-12 text-neutral-500">Sent from your WhatsApp Business number as a document with the message below as its caption. WhatsApp allows this only within 24 hours of the client&apos;s last message; set up a template to start new conversations.</p>
        ) : null}
        {error ? <div className="border-l-2 border-red pl-3 text-13 text-red">{error}</div> : null}
        <Field label="WhatsApp number" hint="From the client's record; change it if their WhatsApp number is different. Other countries: start with + and the country code.">
          <input className={inputClass} value={num} inputMode="tel" onChange={(e) => setNum(e.target.value)} placeholder="98765 43210" autoFocus />
        </Field>
        {status.data?.mode !== 'template' ? (
          <Field label={api_ ? 'Caption' : 'Message'}>
            <textarea className={`${textareaClass} min-h-[120px]`} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        ) : null}
        <div className="inline-flex items-center gap-1.5 text-13 text-neutral-700 border border-neutral-200 rounded px-2 py-1">
          <Paperclip size={14} /> {fileName}
        </div>
      </div>
    </Modal>
  );
}
