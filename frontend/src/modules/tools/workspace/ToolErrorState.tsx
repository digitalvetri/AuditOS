import { Link } from 'react-router-dom';
import { Button } from '@/components/Button';

/** Human-readable message + retry. A hint link appears for known next steps. */
export function ToolErrorState({ code, message, onRetry, onReset }: { code: string; message: string; onRetry: () => void; onReset: () => void }) {
  const hint = code === 'no_text_layer' ? { to: '/tools/ocr-scan', label: 'Open OCR Scan' }
    : code === 'encrypted' ? { to: '/tools/unlock-pdf', label: 'Open Unlock PDF' }
    : null;
  return (
    <div className="border-l-2 border-red pl-3" role="alert" data-testid="tool-error">
      <div className="text-13 font-medium text-neutral-900">Something went wrong</div>
      <p className="text-13 text-neutral-500 mt-1">{message}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>
        <button type="button" onClick={onReset} className="text-13 text-neutral-500 hover:text-neutral-900">Start over</button>
        {hint ? <Link to={hint.to} className="text-13 text-gold hover:text-gold-hover ml-auto">{hint.label} →</Link> : null}
      </div>
    </div>
  );
}
