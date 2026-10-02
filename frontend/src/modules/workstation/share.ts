/**
 * Sending a Workstation document (quotation, invoice, engagement letter)
 * as a MESSAGE containing a download LINK. The link points at the public
 * signed PDF route; tapping it on any device downloads the PDF with no login.
 *
 * - WhatsApp (no Business API): open wa.me with the covering note + link.
 * - WhatsApp (Business API): the server sends a text / template message that
 *   embeds the link — see `/api/share/whatsapp`.
 * - Email: the server sends a plain-text email with the link in the body —
 *   see `/api/share/email`.
 *
 * The "Download PDF" action in the Actions menu still fetches the PDF locally
 * (through the in-app, short-lived signed URL) because the person doing the
 * download is already logged in.
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
 * Save the PDF locally, or open a WhatsApp chat prefilled with the note + link.
 *
 * The in-app download still uses the short-lived signed URL (the signer is
 * logged in); the WhatsApp handoff needs the long-lived public URL instead,
 * so the caller passes it in.
 */
export async function shareDocumentPdf(o: {
  /** Short-lived signed PDF URL, used only for the local download path. */
  issueUrl?: () => Promise<{ url: string }>;
  /** Long-lived public URL used in the WhatsApp message. Required for channel === 'whatsapp'. */
  publicUrl?: string;
  fileName: string;
  /** Covering note sent with the link. */
  note: string;
  channel: ShareChannel;
  phone?: string;
}): Promise<'downloaded' | 'opened'> {
  if (o.channel === 'download') {
    if (!o.issueUrl) throw new Error('A signed URL is required to download.');
    const { url } = await o.issueUrl();
    const res = await fetch(new URL(url, window.location.origin).href);
    if (!res.ok) throw new Error('The PDF could not be generated.');
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = o.fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
    return 'downloaded';
  }

  if (!o.publicUrl) throw new Error('A download link is required to send on WhatsApp.');
  const body = `${o.note.trimEnd()}\n\n${o.publicUrl}`;
  const target = `https://wa.me/${o.phone ?? ''}?text=${encodeURIComponent(body)}`;
  window.open(target, '_blank', 'noopener');
  return 'opened';
}
