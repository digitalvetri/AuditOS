import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Plus } from 'lucide-react';
import { QueryState } from '@/modules/workstation/components';
import { docType } from '@/modules/workstation/docs/registry';
import { docsApi } from '@/modules/workstation/docs/api';
import { fmtLong } from '@/modules/workstation/docs/model';

/** /workstation/doc/t/:typeId — what has been drafted of one document type. */
export function DocListPage() {
  const { typeId } = useParams<{ typeId: string }>();
  const t = docType(typeId);
  const q = useQuery({
    queryKey: ['docs.list', typeId],
    queryFn: () => docsApi.list({ doc_type: typeId, limit: 200 }),
    enabled: Boolean(t),
  });

  if (!t) {
    return <div className="text-13 text-neutral-600">That document type does not exist. <Link className="underline" to="/workstation/doc">Back to Doc</Link>.</div>;
  }

  return (
    <div>
      <header className="flex items-start gap-3 flex-wrap mb-4">
        <div className="min-w-0">
          <Link to="/workstation/doc" className="text-12 text-neutral-500 inline-flex items-center gap-1 hover:text-neutral-900">
            <ArrowLeft size={12} /> Doc
          </Link>
          <h1 className="text-20 font-semibold text-neutral-900 mt-0.5">{t.name}</h1>
          <p className="text-13 text-neutral-500 mt-1">{t.description}</p>
        </div>
        <div className="flex-1" />
        <Link to={`/workstation/doc/t/${t.id}/new`}
          className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50">
          <Plus size={14} /> Create
        </Link>
      </header>

      <QueryState query={q}>
        {(data) => (data.items.length === 0 ? (
          <p className="text-13 text-neutral-500">Nothing drafted yet.</p>
        ) : (
          <ul className="border border-neutral-200 rounded divide-y divide-neutral-200 bg-white">
            {data.items.map((d) => (
              <li key={d.id}>
                <Link to={`/workstation/doc/${d.id}/edit`} className="flex items-center gap-3 px-3 py-2 hover:bg-neutral-50">
                  <span className="text-12 text-neutral-500 tabular-nums w-28 shrink-0">{d.doc_code}</span>
                  <span className="flex-1 min-w-0 text-13 text-neutral-900 truncate">{d.title}</span>
                  <span className="text-12 text-neutral-500 truncate hidden sm:block">{d.party_name ?? ''}</span>
                  <span className="text-12 text-neutral-500 w-28 shrink-0 text-right">{fmtLong(d.doc_date)}</span>
                  <span className="text-11 uppercase tracking-[0.06em] text-neutral-500 w-16 shrink-0 text-right">{d.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        ))}
      </QueryState>
    </div>
  );
}
