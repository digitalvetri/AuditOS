import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import type { ToolDefinition } from '../registry';
import { ToolBadge } from '../ToolBadge';

/**
 * Every tool opens inside this frame (§6): back link, name + description
 * (typography matches the Tools page header), then the body card.
 */
export function ToolWorkspaceLayout({ tool, children, aside }: { tool: ToolDefinition; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="max-w-[1100px] mx-auto" data-testid={`tool-workspace-${tool.id}`}>
      <Link to="/tools" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900 mb-3">
        <ArrowLeft size={14} strokeWidth={1.75} />
        Back to Tools
      </Link>
      <header className="flex items-start gap-3 mb-4">
        <ToolBadge badge={tool.badge} />
        <div className="min-w-0">
          <h1 className="text-20 font-semibold text-neutral-900">{tool.name}</h1>
          <p className="text-13 text-neutral-500 mt-1">{tool.description}</p>
        </div>
      </header>
      <div className={aside ? 'grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-4 items-start' : ''}>
        <section className="bg-white border border-neutral-200 rounded p-4 md:p-6">{children}</section>
        {aside}
      </div>
    </div>
  );
}
