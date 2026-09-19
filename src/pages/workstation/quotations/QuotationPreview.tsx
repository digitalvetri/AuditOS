import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import { QueryState } from '@/modules/workstation/components';
import { quotationsApi } from '@/modules/workstation/quotations/api';
import { QuotationDocument, documentFromApi } from './QuotationDocument';

/**
 * /workstation/quotations/:id/preview — the quotation, and nothing else.
 *
 * Mounted OUTSIDE the AppShell route in App.tsx, so the sidebar, top bar and
 * mobile bottom nav are not merely hidden here: they are never rendered. What
 * is on screen is what comes out of the printer, minus the two buttons, which
 * are `print:hidden`.
 *
 * Every quotation gets this same treatment — it is one route driven by :id,
 * so nothing has to be done for a quotation created tomorrow.
 */
export function QuotationPreviewPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['quotations.get', id], queryFn: () => quotationsApi.get(id!) });

  return (
    <div className="qdoc-page min-h-dvh bg-neutral-100 print:bg-white py-6 px-3 md:px-6">
      <div className="max-w-[820px] mx-auto">
        <div className="flex items-center gap-2 mb-4 print:hidden">
          <Link
            to={`/workstation/quotations/${id}`}
            className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50"
          >
            <ArrowLeft size={14} /> Back
          </Link>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => window.print()}
            className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded bg-neutral-900 text-white hover:bg-neutral-800"
          >
            <Printer size={14} /> Print / Save as PDF
          </button>
        </div>

        <QueryState query={q}>
          {(doc) => <QuotationDocument doc={documentFromApi(doc)} />}
        </QueryState>
      </div>
    </div>
  );
}
