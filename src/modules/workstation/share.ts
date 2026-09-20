/**
 * Sending a Workstation document (quotation, engagement letter) as a PDF.
 *
 * wa.me and mailto: can only ever carry text, so the file reaches WhatsApp
 * through the Web Share API — the native share sheet is handed a real File,
 * and picking WhatsApp there attaches the document itself. Where that API is
 * absent (most desktop browsers) the PDF is saved and the channel opens with
 * a covering note and a link, so the action never silently does nothing.
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
  /** The covering note, given the absolute PDF link. */
  message: (link: string) => string;
  channel: ShareChannel;
  phone?: string;
  email?: string | null;
}): Promise<void> {
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
      await navigator.share({ files: [file], title: o.fileName, text: o.message(absolute) });
      return;
    } catch (err) {
      // Dismissing the share sheet is a choice, not a failure.
      if ((err as { name?: string })?.name === 'AbortError') return;
    }
  }

  save();
  if (o.channel === 'whatsapp') {
    window.open(`https://wa.me/${o.phone ?? ''}?text=${encodeURIComponent(o.message(absolute))}`, '_blank', 'noopener');
  } else {
    window.location.href = `mailto:${o.email ?? ''}`
      + `?subject=${encodeURIComponent(o.subject)}&body=${encodeURIComponent(o.message(absolute))}`;
  }
}
