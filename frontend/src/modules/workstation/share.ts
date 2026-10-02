/**
 * Sending a Workstation document (quotation, invoice, engagement letter) as a
 * PDF FILE — never as a link. WhatsApp goes through the device's share sheet
 * (or download + WhatsApp Web); email is sent by the server with the PDF
 * attached (SendEmailDialog).
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

/**
 * Why a number cannot be a WhatsApp number, or null when it looks valid.
 * Indian numbers (91…) must be 10-digit mobiles starting 6–9; other country
 * codes need 8–15 digits in all (E.164). This cannot tell whether the number
 * is REGISTERED on WhatsApp — only WhatsApp knows that.
 */
export function waNumberProblem(normalized: string): string | null {
  if (!normalized) return 'Enter a WhatsApp number.';
  if (normalized.startsWith('91')) {
    const local = normalized.slice(2);
    if (local.length !== 10) return 'An Indian mobile number has 10 digits.';
    if (!/^[6-9]/.test(local)) return 'An Indian mobile number starts with 6, 7, 8 or 9.';
    return null;
  }
  if (normalized.length < 10) return 'Enter the 10-digit mobile number (or + and the country code for other countries).';
  if (normalized.length > 15) return 'That number is too long for a phone number.';
  return null;
}

export type ShareChannel = 'download' | 'whatsapp';

/**
 * Download the PDF, or hand it to WhatsApp as a FILE.
 *
 * WhatsApp: the native share sheet gets the real PDF where the device offers
 * one (phones, Chrome/Edge on Windows and macOS) — pick WhatsApp there and the
 * document is attached. Elsewhere the PDF is downloaded and the client's chat
 * opens in WhatsApp with the covering note, ready for the file to be dropped
 * in. The note never carries a link: the client receives the document.
 *
 * Email does not come through here — the server sends it with the PDF
 * attached (SendEmailDialog → POST /api/share/email).
 *
 * Resolves to how it was delivered, so the caller can tell the user what to
 * do next.
 */
export async function shareDocumentPdf(o: {
  /** Returns a signed PDF path, relative to this origin. */
  issueUrl: () => Promise<{ url: string }>;
  fileName: string;
  /** Covering note sent with the file. */
  note: string;
  channel: ShareChannel;
  phone?: string;
}): Promise<'downloaded' | 'shared' | 'cancelled' | 'whatsapp-web'> {
  // A window.open() after the fetch below is no longer a user gesture, and
  // the popup blocker silently eats the WhatsApp tab. Where there is no file
  // share sheet, reserve the tab now while the click still counts. (Not with
  // the 'noopener' feature — that makes window.open return null.) Where the
  // share sheet exists, don't: opening a window would spend the gesture that
  // navigator.share needs.
  const canShareFiles = !!navigator.canShare?.({
    files: [new File([], 'x.pdf', { type: 'application/pdf' })],
  });
  const reserved = o.channel === 'whatsapp' && !canShareFiles ? window.open('', '_blank') : null;
  if (reserved) reserved.opener = null;

  let blob: Blob;
  try {
    const { url } = await o.issueUrl();
    const res = await fetch(new URL(url, window.location.origin).href);
    if (!res.ok) throw new Error('The PDF could not be generated.');
    blob = await res.blob();
  } catch (err) {
    reserved?.close();
    throw err;
  }
  const file = new File([blob], o.fileName, { type: 'application/pdf' });

  const save = () => {
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = o.fileName;
    a.rel = 'noopener';
    // In the DOM before .click() (Firefox/Safari ignore a detached anchor),
    // and the URL revoked later, not on the same tick (main eba42b9).
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  };

  if (o.channel === 'download') { save(); return 'downloaded'; }

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: o.fileName, text: o.note });
      return 'shared';
    } catch (err) {
      // Dismissing the share sheet is a choice, not a failure.
      if ((err as { name?: string })?.name === 'AbortError') return 'cancelled';
    }
  }

  save();
  const target = `https://wa.me/${o.phone ?? ''}?text=${encodeURIComponent(o.note)}`;
  if (reserved) reserved.location.href = target;
  else window.open(target, '_blank', 'noopener');
  return 'whatsapp-web';
}

/** What to tell the user after a WhatsApp share, or null when nothing needs saying. */
export function whatsappHint(result: Awaited<ReturnType<typeof shareDocumentPdf>>, fileName: string): string | null {
  return result === 'whatsapp-web'
    ? `${fileName} was downloaded. Attach it in the WhatsApp chat that just opened (drag it in, or use the paperclip).`
    : null;
}
