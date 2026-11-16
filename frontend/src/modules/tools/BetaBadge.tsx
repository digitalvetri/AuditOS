/**
 * Shown on tools whose output has not been validated against the system
 * that consumes it (GST offline tool, IRP, Tally, FVU, real bank / TRACES
 * files). The tool works; the firm should check the file before using it.
 */
export function BetaBadge({ className = '' }: { className?: string }) {
  return (
    <span
      className={'inline-block text-11 px-1.5 py-0.5 rounded border border-amber/50 text-amber bg-amber/15 whitespace-nowrap ' + className}
      data-testid="tool-beta-badge"
      title="Not yet validated against the portal or software that reads this file"
    >
      Beta — verify output before filing/importing
    </span>
  );
}
