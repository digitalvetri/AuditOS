import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileSignature, FileText, Plus, ScrollText } from 'lucide-react';
import { CATEGORIES, DOC_TYPES } from '@/modules/workstation/docs/registry';
import { docsApi } from '@/modules/workstation/docs/api';

/**
 * /workstation/doc — the document workspace.
 *
 * Every document type is its own card: its own template, its own fields, its
 * own editor. Quotation and Engagement Letter appear here too, because this
 * is where someone looks for "the documents", but they open the builders
 * they have always had — this page links to them, it does not replace them.
 */
export function DocHomePage() {
  const countsQ = useQuery({ queryKey: ['docs.counts'], queryFn: () => docsApi.counts() });
  const counts = countsQ.data?.counts ?? {};

  return (
    <div>
      <header className="mb-5">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Workstation</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-0.5">Doc</h1>
        <p className="text-13 text-neutral-500 mt-1">
          Statutory and secretarial documents. Pick a type to create one, or open what has
          already been drafted. Every document is edited on the page itself.
        </p>
      </header>

      <section className="mb-6">
        <h2 className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">Commercial</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <LinkCard
            to="/workstation/quotations" icon={<FileSignature size={16} />}
            name="Quotation" description="Priced proposal with services, fees and terms."
          />
          <LinkCard
            to="/workstation/engagement" icon={<ScrollText size={16} />}
            name="Engagement Letter" description="Scope, responsibilities and the fee schedule."
          />
        </div>
      </section>

      {CATEGORIES.map((cat) => {
        const types = DOC_TYPES.filter((t) => t.category === cat);
        if (!types.length) return null;
        return (
          <section key={cat} className="mb-6">
            <h2 className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">{cat}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {types.map((t) => (
                <article key={t.id} className="border border-neutral-200 rounded bg-white p-3 flex flex-col">
                  <div className="flex items-start gap-2">
                    <span className="text-neutral-400 mt-0.5"><FileText size={16} /></span>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-14 font-medium text-neutral-900">{t.name}</h3>
                      <p className="text-12 text-neutral-500 mt-0.5">{t.description}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-3">
                    <Link
                      to={`/workstation/doc/t/${t.id}/new`}
                      className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50"
                    >
                      <Plus size={14} /> Create
                    </Link>
                    <Link
                      to={`/workstation/doc/t/${t.id}`}
                      className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50"
                    >
                      Saved{counts[t.id] ? ` · ${counts[t.id]}` : ''}
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function LinkCard({ to, icon, name, description }: { to: string; icon: React.ReactNode; name: string; description: string }) {
  return (
    <Link to={to} className="border border-neutral-200 rounded bg-white p-3 flex items-start gap-2 hover:bg-neutral-50">
      <span className="text-neutral-400 mt-0.5">{icon}</span>
      <div className="min-w-0">
        <h3 className="text-14 font-medium text-neutral-900">{name}</h3>
        <p className="text-12 text-neutral-500 mt-0.5">{description}</p>
      </div>
    </Link>
  );
}
