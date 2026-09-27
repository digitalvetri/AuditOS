/**
 * Sending a Workstation document (invoice, quotation, engagement letter)
 * as a PDF.
 *
 * The PDF reaches the recipient as a real file, not as a link:
 *   • On mobile, the Web Share API is available and the native share sheet
 *     is handed the File — picking WhatsApp attaches the document itself.
 *   • On desktop, the file is auto-saved to Downloads and the channel opens
 *     with a covering note only; the sender attaches the saved file in the
 *     WhatsApp / email client. This mirrors how people actually forward
 *     documents — with the file, not a signed URL that expires.
 *
 * The covering message is plain text — no PDF link. Earlier versions
 * appended the signed URL as a fallback, but that leaked short-lived tokens
 * into user-controlled channels and, in practice, recipients ignored the
 * link and asked for the file anyway.
 */

/**
 * A number in the form wa.me needs. Clients are stored as bare ten-digit
 * local numbers and wa.me/9876543210 resolves to nobody — WhatsApp reads the
 * leading digits as a country code — so India's 91 is added explicitly.
 */
export function waNumber(raw: string | null | undefined): string {
  const digits = (raw ?? '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  if ((raw ?? '').trim().startsWith('+')) return digits;
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  return digits;
}

export type ShareChannel = 'download' | 'whatsapp' | 'email';

export async function shareDocumentPdf(o: {
  /** Returns a signed PDF path, relative to this origin. */
  issueUrl: () => Promise<{ url: string }>;
  fileName: string;
  subject: string;
  /** The covering note. Plain text — no PDF link is appended. */
  message: string;
  channel: ShareChannel;
  phone?: string;
  email?: string | null;
}): Promise<void> {
  // The destination URL is built from data we already have — it does NOT
  // depend on the PDF fetch. So open it SYNCHRONOUSLY, right now, while
  // we still hold the click's user activation. See below for why this
  // matters.
  const target =
    o.channel === 'whatsapp'
      ? `https://wa.me/${o.phone ?? ''}?text=${encodeURIComponent(o.message)}`
      : o.channel === 'email'
      ? `mailto:${o.email ?? ''}?subject=${encodeURIComponent(o.subject)}`
        + `&body=${encodeURIComponent(o.message)}`
      : '';

  // Sync-click a hidden <a> instead of calling window.open(). Rationale:
  //   • window.open() called AFTER an async gap (fetch + File assembly)
  //     is treated as "no longer a user gesture" and popup-blocked by
  //     Brave Shields, Firefox Enhanced Tracking Protection, and Safari.
  //   • Reserving the tab up front with window.open('about:blank', ...)
  //     also fails on Brave — the browser opens a shell tab and returns
  //     a handle, but Brave then refuses to let us navigate it away from
  //     about:blank as a tracker-defence heuristic.
  //   • A programmatic <a target="_blank"> click, in contrast, is
  //     treated as a normal link click by every browser we care about.
  //     Popup blockers uniformly let it pass because it's the same
  //     mechanism as a user clicking a link. The anchor must be attached
  //     to the DOM before click() so Firefox and Safari accept it.
  // mailto: navigates the current tab (same as clicking a mailto: link)
  // — browsers hand the URL to the OS mail client and don't lose the
  // page, so no _blank is needed.
  if (target && o.channel !== 'download') {
    const link = document.createElement('a');
    link.href = target;
    if (o.channel === 'whatsapp') {
      link.target = '_blank';
      link.rel = 'noopener';
    }
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  const { url } = await o.issueUrl();
  const absolute = new URL(url, window.location.origin).href;
  const res = await fetch(absolute);
  if (!res.ok) throw new Error('The PDF could not be generated.');
  const blob = await res.blob();
  const file = new File([blob], o.fileName, { type: 'application/pdf' });

  // The anchor MUST be in the DOM before .click() — Firefox and Safari
  // treat a detached anchor click as a no-op, so the file appears to
  // download on Chromium but silently fails elsewhere. And the object
  // URL must NOT be revoked on the same tick as .click() — some browsers
  // haven't opened the download stream yet and abort it when the URL is
  // freed. Same shape as the Tally-export fix (a4fa04d).
  const save = () => {
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = o.fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(href), 5000);
  };

  if (o.channel === 'download') { save(); return; }

  // Mobile: if the Web Share API is available for files, use it — the
  // native share sheet attaches the PDF directly, no manual step needed.
  // The extra wa.me tab we sync-opened above stays behind the sheet;
  // trivially closable and worth the trade for the file attach.
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: o.fileName, text: o.message });
      return;
    } catch (err) {
      // Dismissing the share sheet is a choice, not a failure.
      if ((err as { name?: string })?.name === 'AbortError') return;
    }
  }

  // Desktop path: the wa.me / mailto tab is already open. Save the file
  // so the sender can attach it themselves in WhatsApp Web / mail client.
  save();
}
