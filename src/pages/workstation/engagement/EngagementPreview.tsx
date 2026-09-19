import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import { QueryState } from '@/modules/workstation/components';
import { engagementApi } from '@/modules/workstation/engagement/api';
import { EngagementDocument, docFromApi } from './EngagementDocument';

/**
 * /workstation/engagement/:id/preview — the letter alone, at true size.
 *
 * Declared outside the app shell (as the quotation preview is), so printing
 * from here puts the letter on the paper and nothing else.
 */
export function EngagementPreviewPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['engagement.get', id], queryFn: () => engagementApi.get(id!) });

  return (
    <div className="min-h-dvh bg-neutral-100 print:bg-white py-6 px-3 md:px-6">
      <div className="max-w-[820px] mx-auto">
        <div className="flex items-center gap-2 mb-4 print:hidden">
          <Link
            to={`/workstation/engagement/${id}/edit`}
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
          {(l) => <EngagementDocument doc={docFromApi(l)} />}
        </QueryState>
      </div>
    </div>
  );
}
