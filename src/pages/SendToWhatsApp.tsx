import { useEffect, useMemo, useState } from 'react';

/**
 * /send — opened on a PHONE by scanning the QR code in "Send on WhatsApp".
 *
 * A desktop browser cannot attach a file to WhatsApp; a phone can, through
 * its share sheet. This page fetches the document's PDF (signed link, no
 * login) and hands WhatsApp the FILE:
 *
 *   • https (or any secure context): one tap — the share sheet opens with
 *     the PDF attached; pick WhatsApp, then the client.
 *   • plain http on the office network, where phones hide the share API:
 *     open the PDF, then Share → WhatsApp from the phone's PDF viewer.
 */
const ALLOWED = /^\/api\/(quotations|invoices|engagement-letters)\/[^/?#]+\/pdf\?t=[^&#]+$/;

type State =
  | { s: 'loading' }
  | { s: 'ready'; file: File; url: string }
  | { s: 'error'; message: string };

export function SendToWhatsAppPage() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const pdf = params.get('pdf') ?? '';
  const name = (params.get('name') ?? 'document.pdf').replace(/[^\w.-]/g, '_');
  const note = params.get('note') ?? '';
  const [state, setState] = useState<State>({ s: 'loading' });
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Fetched up front: the share call must run straight from the tap, and
  // awaiting a download first would lose the tap's permission.
  useEffect(() => {
    if (!ALLOWED.test(pdf)) { setState({ s: 'error', message: 'This link is not valid. Create a new QR code from Audit OS.' }); return; }
    let url = '';
    fetch(pdf)
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) throw new Error('This link has expired. Create a new QR code from Audit OS.');
        if (!r.ok) throw new Error('The PDF could not be loaded.');
        const blob = await r.blob();
        url = URL.createObjectURL(blob);
        setState({ s: 'ready', file: new File([blob], name, { type: 'application/pdf' }), url });
      })
      .catch((e: Error) => setState({ s: 'error', message: e.message || 'The PDF could not be loaded.' }));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [pdf, name]);

  const canShareFile = state.s === 'ready' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [state.file] });

  const share = async () => {
    if (state.s !== 'ready') return;
    try {
      await navigator.share({ files: [state.file], text: note || undefined });
      setStatus('Sent to the app you chose. You can close this page.');
    } catch (e) {
      if ((e as { name?: string }).name !== 'AbortError') setStatus('Sharing did not work on this phone — use “Open PDF” below instead.');
    }
  };

  const copyNote = async () => {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(note);
      else {
        const ta = document.createElement('textarea');
        ta.value = note; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      }
      setCopied(true);
    } catch { /* the message is visible to copy by hand */ }
  };

  return (
    <div className="min-h-dvh bg-canvas text-ink px-4 py-6 flex justify-center">
      <div className="w-full max-w-[440px] space-y-4">
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-inkMuted">Audit OS</div>
          <h1 className="text-20 font-semibold mt-1">Send on WhatsApp</h1>
        </div>

        <div className="bg-surface border border-border rounded p-4 flex items-center gap-3">
          <div className="h-12 w-10 shrink-0 rounded border border-border flex items-center justify-center text-11 font-semibold text-danger">PDF</div>
          <div className="min-w-0">
            <div className="text-15 font-medium truncate">{name}</div>
            <div className="text-12 text-inkMuted">
              {state.s === 'loading' ? 'Loading…' : state.s === 'ready' ? `${Math.max(1, Math.round(state.file.size / 1024))} KB · ready` : 'Not available'}
            </div>
          </div>
        </div>

        {state.s === 'error' ? <div className="border-l-2 border-danger bg-surface px-3 py-2 text-14">{state.message}</div> : null}

        {state.s === 'ready' && canShareFile ? (
          <>
            <button type="button" onClick={share} className="w-full h-14 rounded-md bg-[#25D366] text-white text-16 font-semibold">
              Send PDF on WhatsApp
            </button>
            <p className="text-13 text-inkMuted">Choose <b>WhatsApp</b> in the list that opens, then the client. The PDF is attached{note ? ' with the message below' : ''}.</p>
          </>
        ) : null}

        {state.s === 'ready' && !canShareFile ? (
          <div className="bg-surface border border-border rounded p-4 space-y-3">
            <a href={state.url} download={name} className="w-full h-14 rounded-md bg-[#25D366] text-white text-16 font-semibold flex items-center justify-center">
              Open PDF
            </a>
            <ol className="list-decimal pl-5 text-14 space-y-1">
              <li>Tap <b>Open PDF</b> (on Android, tap <b>Open</b> when it finishes downloading).</li>
              <li>In the PDF viewer tap <b>Share</b>.</li>
              <li>Choose <b>WhatsApp</b>, then the client. The PDF is attached.</li>
            </ol>
            <p className="text-12 text-inkMuted">This page opens over the office network without https, so the phone offers the two-step route. On an https address it is one tap.</p>
          </div>
        ) : null}

        {status ? <div className="border-l-2 border-success bg-surface px-3 py-2 text-14">{status}</div> : null}

        {note ? (
          <div className="bg-surface border border-border rounded p-4">
            <div className="flex items-center">
              <span className="text-11 uppercase tracking-[0.06em] text-inkMuted">Message</span>
              <div className="flex-1" />
              <button type="button" onClick={copyNote} className="text-13 text-inkMuted underline">{copied ? 'Copied' : 'Copy'}</button>
            </div>
            <p className="text-14 whitespace-pre-line mt-2">{note}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
