import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { CATEGORIES, DOC_TYPES } from '@/modules/workstation/docs/registry';
import { docsApi } from '@/modules/workstation/docs/api';
import { ToolBadge } from '@/modules/tools/ToolBadge';
import type { ToolDefinition } from '@/modules/tools/registry';

/**
 * /workstation/doc — the document workspace, laid out like Tools & Converters:
 * a search beside the title, one section per category, and a card per
 * document type with a tinted badge.
 *
 * Every document type is its own card: its own template, its own fields, its
 * own editor. Quotation and Engagement Letter appear here too, because this
 * is where someone looks for "the documents", but they open the builders
 * they have always had — this page links to them, it does not replace them.
 */

type Tint = ToolDefinition['badge']['tint'];

/** A colour per section, so a category reads at a glance. */
const TINT: Record<string, Tint> = {
  Commercial: 'blue',
  Director: 'indigo',
  'Company law': 'green',
  'GST & registration': 'amber',
  Agreement: 'rose',
};

/** The short form on each badge — the form number where there is one. */
const CODE: Record<string, string> = {
  'appointment-letter': 'APPT',
  'consent-letter': 'DIR-2',
  'non-disqualification': 'DIR-8',
  'director-resignation': 'DIR-11',
  'board-resolution-appointment': 'BR',
  'board-resolution-resignation': 'BR',
  'board-resolution-authorised-signatory': 'BR·AS',
  'shareholders-resolution': 'SR',
  'authorised-signatory-declaration': 'ASD',
  'noc-gst': 'NOC',
  'noc-incorporation': 'NOC',
  'llp-agreement': 'LLP',
  'partnership-agreement': 'DEED',
  'authorised-signatory-pvt-ltd': 'AS',
  'lease-deed': 'LEASE',
  'epf-letter': 'EPF',
};

const initials = (name: string) => name.split(/[\s—-]+/).filter(Boolean).slice(0, 3).map((w) => w[0]).join('').toUpperCase();

interface Card {
  id: string;
  name: string;
  description: string;
  category: string;
  /** The builder for Quotation / Engagement; else the doc type's create + saved pages. */
  openTo?: string;
}

const COMMERCIAL: Card[] = [
  { id: 'quotation', name: 'Quotation', description: 'Priced proposal with services, fees and terms.', category: 'Commercial', openTo: '/workstation/quotations' },
  { id: 'engagement', name: 'Engagement Letter', description: 'Scope, responsibilities and the fee schedule.', category: 'Commercial', openTo: '/workstation/engagement' },
];
const COMMERCIAL_CODE: Record<string, string> = { quotation: 'QT', engagement: 'EL' };

export function DocHomePage() {
  const countsQ = useQuery({ queryKey: ['docs.counts'], queryFn: () => docsApi.counts() });
  const counts = countsQ.data?.counts ?? {};
  const [query, setQuery] = useState('');

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (c: Card) => !q || `${c.name} ${c.description} ${c.category} ${CODE[c.id] ?? ''}`.toLowerCase().includes(q);
    const all: { label: string; cards: Card[] }[] = [
      { label: 'Commercial', cards: COMMERCIAL },
      ...CATEGORIES.map((cat) => ({
        label: cat,
        cards: DOC_TYPES.filter((t) => t.category === cat)
          .map((t) => ({ id: t.id, name: t.name, description: t.description, category: cat })),
      })),
    ];
    return all.map((s) => ({ ...s, cards: s.cards.filter(match) })).filter((s) => s.cards.length > 0);
  }, [query]);

  return (
    <div className="max-w-[1400px] mx-auto">
      <header className="flex flex-col md:flex-row md:items-start gap-3 md:gap-4 mb-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] text-neutral-900">Document formats</h1>
          <p className="text-13 text-neutral-500 mt-1">
            Statutory and secretarial documents — pick a type to create one, or open what has already been drafted.
          </p>
        </div>
        <label className="relative block w-full md:w-[260px]">
          <span className="absolute inset-y-0 left-3 flex items-center text-neutral-400"><Search size={14} strokeWidth={1.75} /></span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search documents..."
            aria-label="Search documents"
            className="h-9 w-full pl-8 pr-3 text-13 bg-white text-neutral-900 border border-neutral-200 rounded-lg placeholder:text-neutral-400 focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/10"
          />
        </label>
      </header>

      {sections.length === 0 ? (
        <div className="bg-white border border-neutral-200 rounded-lg p-6">
          <div className="text-13 font-medium text-neutral-900">No documents match “{query.trim()}”</div>
          <p className="text-13 text-neutral-500 mt-1">
            Try a form such as <button type="button" className="underline" onClick={() => setQuery('DIR')}>DIR</button>, or a word
            like <button type="button" className="underline" onClick={() => setQuery('resolution')}>resolution</button> or{' '}
            <button type="button" className="underline" onClick={() => setQuery('NOC')}>NOC</button>.
          </p>
        </div>
      ) : null}

      <div className="space-y-6">
        {sections.map((s) => (
          <section key={s.label}>
            <h2 className="text-11 tracking-[0.06em] text-neutral-500 mb-3">{s.label}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {s.cards.map((c) => <DocCard key={c.id} card={c} saved={counts[c.id]} />)}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

const linkCls = 'text-12 font-medium text-gold hover:text-gold-hover';

function DocCard({ card, saved }: { card: Card; saved?: number }) {
  const badge = {
    tint: TINT[card.category] ?? 'blue',
    text: COMMERCIAL_CODE[card.id] ?? CODE[card.id] ?? initials(card.name),
  } as ToolDefinition['badge'];
  return (
    // Frosted glass card — see `.doc-glass` (shared with Tools).
    <article className="doc-glass rounded-md p-4 flex gap-3 min-h-[112px]">
      <ToolBadge badge={badge} />
      <div className="min-w-0 flex-1 flex flex-col">
        <h3 className="text-14 font-semibold text-neutral-900 leading-5">{card.name}</h3>
        <p className="text-13 text-neutral-500 mt-0.5">{card.description}</p>
        <div className="mt-auto pt-3 flex items-center gap-4">
          {card.openTo ? (
            <Link to={card.openTo} className={linkCls} aria-label={`Open ${card.name}`}>Open →</Link>
          ) : (
            <>
              <Link to={`/workstation/doc/t/${card.id}/new`} className={linkCls} aria-label={`Create ${card.name}`}>Create →</Link>
              <Link to={`/workstation/doc/t/${card.id}`} className="text-12 font-medium text-neutral-500 hover:text-neutral-900" aria-label={`Saved ${card.name}`}>
                Saved{saved ? ` · ${saved}` : ''}
              </Link>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
