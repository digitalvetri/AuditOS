/**
 * Determinate progress where the service reports it, otherwise an
 * indeterminate bar. No spinner, no shimmer — a static bar that fills.
 */
export function ProcessingState({ label, progress }: { label: string; progress: number }) {
  const determinate = progress > 0 && progress < 100;
  return (
    <div className="py-2" role="status" aria-live="polite" data-testid="processing-state">
      <div className="flex items-baseline justify-between text-13 text-neutral-900">
        <span>{label}</span>
        {determinate ? <span className="tabular-nums text-neutral-500">{Math.round(progress)}%</span> : null}
      </div>
      <div className="h-2 mt-2 bg-neutral-100 rounded overflow-hidden relative">
        {determinate ? (
          <div className="h-full bg-gold transition-[width] duration-300" style={{ width: `${progress}%` }} />
        ) : (
          <div className="absolute inset-y-0 w-1/3 bg-gold rounded" style={{ animation: 'tools-indeterminate 1.4s ease-in-out infinite' }} />
        )}
      </div>
      <style>{`@keyframes tools-indeterminate { 0% { left: -33%; } 100% { left: 100%; } }`}</style>
    </div>
  );
}
