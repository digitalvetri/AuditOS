import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderOpen, Search } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { DOCUMENTS_ROUTE, searchTools, TOOL_GROUPS, TOOLS, type ToolDefinition } from '@/modules/tools/registry';
import { ToolBadge } from '@/modules/tools/ToolBadge';

/**
 * Tools & Converters — rendered entirely from the registry (§4).
 *
 *   header: title + subtitle, search on the same line (below the title on
 *           mobile), Documents entry point next to the search
 *   body:   one section per group, 3-column grid (2 on tablet, 1 on mobile)
 *   search: filters cards in place; empty groups disappear; no matches → a
 *           clear empty state rather than a blank grid
 */
export function ToolsPage() {
  const { session } = useAuth();
  const role = session?.role.code;
  const [query, setQuery] = useState('');

  const visible = useMemo(() => searchTools(query, TOOLS), [query]);
  const sections = useMemo(
    () => [...TOOL_GROUPS].sort((a, b) => a.order - b.order)
      .map((g) => ({ group: g, tools: visible.filter((t) => t.groupId === g.id) }))
      .filter((s) => s.tools.length > 0),
    [visible],
  );
  const canSeeDocuments = can(role, 'tools.documents.read', 'self');

  return (
    <div className="max-w-[1400px] mx-auto" data-testid="tools-page">
      <header className="flex flex-col md:flex-row md:items-start gap-3 md:gap-4 mb-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-20 font-semibold text-neutral-900">Tools &amp; Converters</h1>
          <p className="text-13 text-neutral-500 mt-1">Everyday file conversions &amp; compliance utilities — no need to leave the platform</p>
        </div>
        <div className="flex items-center gap-2 w-full md:w-auto">
          <label className="relative block flex-1 md:flex-none md:w-[260px]">
            <span className="absolute inset-y-0 left-2 flex items-center text-neutral-400"><Search size={14} strokeWidth={1.75} /></span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tools..."
              aria-label="Search tools"
              className="h-8 w-full pl-7 pr-3 text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold"
              data-testid="tools-search"
            />
          </label>
          {canSeeDocuments ? (
            <Link
              to={DOCUMENTS_ROUTE}
              className="inline-flex items-center gap-1 h-8 px-3 text-13 font-medium rounded bg-white text-neutral-900 border border-neutral-300 hover:bg-neutral-50 whitespace-nowrap"
              data-testid="tools-documents-link"
            >
              <FolderOpen size={14} strokeWidth={1.75} />
              Documents
            </Link>
          ) : null}
        </div>
      </header>

      {sections.length === 0 ? (
        <div className="bg-white border border-neutral-200 rounded p-6" data-testid="tools-empty">
          <div className="text-13 font-medium text-neutral-900">No tools match “{query.trim()}”</div>
          <p className="text-13 text-neutral-500 mt-1">Try a file type such as <button type="button" className="underline" onClick={() => setQuery('pdf')}>pdf</button> or <button type="button" className="underline" onClick={() => setQuery('excel')}>excel</button>, or a task like merge, split or tally.</p>
        </div>
      ) : null}

      <div className="space-y-6">
        {sections.map(({ group, tools }) => (
          <section key={group.id} data-testid={`tools-group-${group.id}`}>
            <h2 className="text-11 tracking-[0.06em] text-neutral-500 mb-3">{group.label}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {tools.map((t) => <ToolCard key={t.id} tool={t} permitted={can(role, t.permission, 'self')} />)}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function ToolCard({ tool, permitted }: { tool: ToolDefinition; permitted: boolean }) {
  return (
    <article className="bg-white border border-neutral-200 rounded p-4 flex gap-3 min-h-[112px]" data-testid={`tool-card-${tool.id}`}>
      <ToolBadge badge={tool.badge} />
      <div className="min-w-0 flex-1 flex flex-col">
        <h3 className="text-14 font-semibold text-neutral-900 leading-5">{tool.name}</h3>
        <p className="text-13 text-neutral-500 mt-0.5">{tool.description}</p>
        <div className="mt-auto pt-3">
          <Link
            to={tool.route}
            className={'text-12 font-medium ' + (permitted ? 'text-gold hover:text-gold-hover' : 'text-neutral-400')}
            aria-label={`Open ${tool.name}`}
            title={permitted ? undefined : 'You do not have access to this tool'}
          >
            Open →
          </Link>
        </div>
      </div>
    </article>
  );
}
