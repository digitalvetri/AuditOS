import { Link } from 'react-router-dom';
import type { ToolDefinition } from '../registry';
import { ToolWorkspaceLayout } from './ToolWorkspaceLayout';

/**
 * The deliberate "not yet" screen every compliance converter routes to.
 * Same frame as a live tool, no dropzone, no half-built form. Follows the
 * reserved-screen discipline: plain surface, reduced emphasis, no CTA.
 */
export function ComingSoonState({ tool }: { tool: ToolDefinition }) {
  return (
    <ToolWorkspaceLayout tool={tool}>
      <div data-testid="coming-soon">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Coming soon</div>
        <p className="text-13 text-neutral-900 mt-2 max-w-[560px]">
          {tool.name} is on the Finance &amp; Compliance roadmap. The card is here so the page is complete; the
          converter itself, its parser and its data model have not been built yet.
        </p>
        <p className="text-13 text-neutral-400 mt-2 max-w-[560px]">
          When it ships it will accept {tool.extensions.map((e) => e.toUpperCase()).join(' / ')} and produce {tool.outputType.toUpperCase()},
          and every output will land in Documents like the tools that are live today.
        </p>
        <Link to="/tools" className="inline-block mt-6 text-13 text-neutral-700 underline hover:text-neutral-900">Back to Tools</Link>
      </div>
    </ToolWorkspaceLayout>
  );
}
