import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type { LocalFile } from './useToolWorkspace';
import { formatBytes, extensionOf } from '../format';

/**
 * Name, size, type, remove — and, for tools that care about order (Merge,
 * Image to PDF), up/down controls. Upload progress rides on the row.
 */
export function FileList({ files, onRemove, onMove, reorderable = false, disabled = false, extra }: {
  files: LocalFile[];
  onRemove: (key: string) => void;
  onMove?: (from: number, to: number) => void;
  reorderable?: boolean;
  disabled?: boolean;
  /** Extra per-file facts (page count, dimensions). */
  extra?: (f: LocalFile) => string | null;
}) {
  if (!files.length) return null;
  return (
    <ul className="divide-y divide-neutral-200 border border-neutral-200 rounded" data-testid="file-list">
      {files.map((f, i) => {
        const note = f.status === 'ready' ? extra?.(f) : null;
        return (
          <li key={f.key} className={'flex items-center gap-3 px-3 min-h-[44px] py-1 ' + (f.status === 'invalid' ? 'border-l-2 border-red' : 'border-l-2 border-transparent')}>
            {reorderable ? <span className="w-5 text-12 text-neutral-500 tabular-nums shrink-0">{i + 1}.</span> : null}
            <span className="inline-flex items-center justify-center w-9 h-7 rounded bg-neutral-100 text-neutral-600 text-11 font-mono uppercase shrink-0">
              {extensionOf(f.file.name) || 'file'}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-13 text-neutral-900 truncate" title={f.file.name}>{f.file.name}</div>
              <div className="text-12 text-neutral-500 truncate">
                {formatBytes(f.file.size)}
                {f.status === 'uploading' ? ` · Uploading… ${f.progress}%` : null}
                {f.status === 'validating' ? ' · Checking…' : null}
                {f.status === 'invalid' ? <span className="text-red"> · {f.error}</span> : null}
                {note ? ` · ${note}` : null}
              </div>
              {f.status === 'uploading' ? (
                <div className="h-1 mt-1 bg-neutral-100 rounded overflow-hidden">
                  <div className="h-full bg-gold transition-[width]" style={{ width: `${f.progress}%` }} />
                </div>
              ) : null}
            </div>
            {reorderable && onMove ? (
              <span className="flex items-center gap-0.5 shrink-0">
                <IconBtn label="Move up" disabled={disabled || i === 0} onClick={() => onMove(i, i - 1)}><ChevronUp size={16} strokeWidth={1.75} /></IconBtn>
                <IconBtn label="Move down" disabled={disabled || i === files.length - 1} onClick={() => onMove(i, i + 1)}><ChevronDown size={16} strokeWidth={1.75} /></IconBtn>
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => onRemove(f.key)}
              disabled={disabled}
              className="inline-flex items-center gap-1 h-7 px-2 text-12 text-neutral-500 hover:text-neutral-900 disabled:opacity-50 shrink-0"
              aria-label={`Remove ${f.file.name}`}
              data-testid="file-remove"
            >
              <X size={14} strokeWidth={1.75} />
              <span className="hidden sm:inline">Remove</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function IconBtn({ children, label, onClick, disabled }: { children: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex items-center justify-center w-7 h-7 rounded text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
