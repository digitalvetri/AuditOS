import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import { QueryState } from '@/modules/workstation/components';
import { docsApi, type WorkstationDoc } from '@/modules/workstation/docs/api';
import { docType } from '@/modules/workstation/docs/registry';
import { fmtLong, layoutOf, normalizeDocBlocks, type DBlock } from '@/modules/workstation/docs/model';
import { DocDocument, type DocModel } from './DocDocument';

/**
 * /workstation/doc/:id/preview — the document alone, at true size.
 *
 * Declared outside the app shell, so printing from here puts the document on
 * the paper and nothing else: no sidebar, no top bar, no editor controls.
 */
export function DocPreviewPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['docs.get', id], queryFn: () => docsApi.get(id!) });

  return (
    <div className="min-h-dvh bg-neutral-100 print:bg-white py-6 px-3 md:px-6">
      <div className="max-w-[820px] mx-auto">
        <div className="flex items-center gap-2 mb-4 print:hidden">
          <Link to={`/workstation/doc/${id}/edit`}
            className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50">
            <ArrowLeft size={14} /> Back
          </Link>
          <div className="flex-1" />
          <button type="button" onClick={() => window.print()}
            className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded bg-neutral-900 text-white hover:bg-neutral-800">
            <Printer size={14} /> Print / Save as PDF
          </button>
        </div>
        <QueryState query={q}>
          {(d) => <DocDocument doc={docFromApi(d)} />}
        </QueryState>
      </div>
    </div>
  );
}

/** A saved document, as the renderer wants it. */
export function docFromApi(d: WorkstationDoc): DocModel {
  const t = docType(d.doc_type);
  const saved = (d.block_config as unknown as DBlock[] | null) ?? [];
  const vars: Record<string, string> = { doc_date: fmtLong(d.doc_date) };
  for (const [k, v] of Object.entries(d.field_values ?? {})) {
    vars[k] = /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtLong(v) : v;
  }
  if (!vars.company_name && d.party_name) vars.company_name = d.party_name;
  return {
    docDate: d.doc_date,
    vars,
    blocks: normalizeDocBlocks(saved.length ? saved : (t?.blocks() ?? [])),
    layout: layoutOf(d.layout_config),
  };
}
