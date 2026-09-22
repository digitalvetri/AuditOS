import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download, Printer } from 'lucide-react';
import { QueryState } from '@/modules/workstation/components';
import { useToast } from '@/components/Toast';
import { invoicesApi, type Invoice } from '@/modules/workstation/invoices/api';
import { downloadFile } from '@/modules/workstation/invoices/download';
import { InvoiceDocument } from './InvoiceDocument';
import { docFromInvoice } from './InvoiceDetail';

/**
 * /workstation/invoices/:id/preview — the invoice, and nothing else.
 *
 * Mounted OUTSIDE the AppShell route in App.tsx, so the sidebar, top bar and
 * mobile bottom nav are not merely hidden here: they are never rendered.
 * What is on screen is what comes out of the printer, minus the three
 * buttons, which are `print:hidden`. That is §35 — no CRM chrome can reach
 * the document, because none of it exists on this route.
 *
 * TWO WAYS TO GET A FILE, on purpose:
 *
 *   Download PDF  — the SERVER's vector PDF, the same bytes a client
 *                   receives on WhatsApp or by email. This is the real
 *                   deliverable: selectable text, small file, identical for
 *                   everyone who opens it.
 *   Print / Save  — the browser's own dialog, for someone who wants paper
 *                   now or a quick local copy. Rendering depends on the
 *                   browser, so it is offered second.
 *
 * Both draw the same document model, so neither can drift from the preview
 * above them.
 */
export function InvoicePreviewPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const q = useQuery({ queryKey: ['invoices.get', id], queryFn: () => invoicesApi.get(id!) });

  const pdf = useMutation({
    mutationFn: () => invoicesApi.pdfUrl(id!),
    onSuccess: (r) => downloadFile(r.url, `${q.data?.invoice_number ?? 'invoice'}.pdf`),
    onError: (e: Error) => toast.push('error', e.message),
  });

  return (
    /* NOT `qdoc-page`: that class means "a sheet of paper" and carries
       `break-after: page`. On a full-height wrapper it makes the printer eject
       a near-empty sheet before the document ever starts — the blank first
       page. The real sheets are the .qdoc-page divs InvoiceDocument renders
       inside. `print:*` also flattens the screen-only padding and min-height,
       so nothing reserves paper it does not use. */
    <div className="min-h-dvh print:min-h-0 bg-neutral-100 print:bg-white py-6 print:py-0 px-3 md:px-6 print:px-0">
      <div className="max-w-[820px] print:max-w-none mx-auto">
        <div className="flex items-center gap-2 mb-4 print:hidden">
          <Link
            to={`/workstation/invoices/${id}`}
            className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50"
          >
            <ArrowLeft size={14} /> Back
          </Link>
          <div className="flex-1" />
          <button
            type="button"
            disabled={pdf.isPending}
            onClick={() => pdf.mutate()}
            className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            <Download size={14} /> {pdf.isPending ? 'Preparing…' : 'Download PDF'}
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50"
          >
            <Printer size={14} /> Print
          </button>
        </div>

        <QueryState query={q}>
          {(inv: Invoice) => <InvoiceDocument doc={docFromInvoice(inv)} />}
        </QueryState>
      </div>
    </div>
  );
}
