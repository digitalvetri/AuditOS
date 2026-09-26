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
  // The popup-blocker trap: `window.open(...)` invoked AFTER an async gap
  // (fetch + File assembly) is treated as "not a user gesture" by Chrome
  // and modern Firefox — the wa.me / mailto tab is silently blocked and
  // the WhatsApp/Email button appears to do nothing. Reserve the target
  // tab synchronously while we still have the click-derived user gesture,
  // then navigate it once the PDF has been assembled and saved.
  //
  // The download-only path doesn't need a reserved window because
  // `a.click()` on an anchor with `download` is always a user-gesture
  // action, even inside a promise resolution.
  const openedWindow: Window | null =
    o.channel === 'whatsapp' || o.channel === 'email'
      ? window.open('about:blank', '_blank', 'noopener')
      : null;

  try {
    const { url } = await o.issueUrl();
    const absolute = new URL(url, window.location.origin).href;
    const res = await fetch(absolute);
    if (!res.ok) throw new Error('The PDF could not be generated.');
    const blob = await res.blob();
    const file = new File([blob], o.fileName, { type: 'application/pdf' });

    const save = () => {
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = o.fileName;
      a.click();
      URL.revokeObjectURL(href);
    };

    if (o.channel === 'download') { save(); return; }

    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: o.fileName, text: o.message });
        openedWindow?.close();
        return;
      } catch (err) {
        // Dismissing the share sheet is a choice, not a failure.
        if ((err as { name?: string })?.name === 'AbortError') {
          openedWindow?.close();
          return;
        }
      }
    }

    // Desktop path: save the file so the sender can attach it themselves,
    // then navigate the reserved tab to the channel URL. No PDF link.
    save();
    const target = o.channel === 'whatsapp'
      ? `https://wa.me/${o.phone ?? ''}?text=${encodeURIComponent(o.message)}`
      : `mailto:${o.email ?? ''}?subject=${encodeURIComponent(o.subject)}`
        + `&body=${encodeURIComponent(o.message)}`;

    if (openedWindow) {
      openedWindow.location.href = target;
    } else {
      // Popup was blocked entirely — fall back to same-tab navigation for
      // mailto (browsers handle it as a protocol handler either way) or a
      // best-effort window.open for wa.me.
      if (o.channel === 'email') window.location.href = target;
      else window.open(target, '_blank', 'noopener');
    }
  } catch (err) {
    openedWindow?.close();
    throw err;
  }
}
