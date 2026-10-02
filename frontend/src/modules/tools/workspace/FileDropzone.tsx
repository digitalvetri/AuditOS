import { useRef, useState, type DragEvent } from 'react';
import { Upload } from 'lucide-react';
import { supportedLine, type ToolDefinition } from '../registry';

/**
 * Click or drag-and-drop. Accepted types and single/multi come from the
 * registry; the hook does the real validation, this only opens the picker.
 */
export function FileDropzone({ tool, onFiles, disabled = false, compact = false }: {
  tool: ToolDefinition; onFiles: (files: File[]) => void; disabled?: boolean; compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);
  const accept = [...tool.accepts, ...tool.extensions.map((e) => `.${e}`)].join(',');
  const noun = tool.multiple ? `${tool.extensions[0] === 'pdf' ? 'PDFs' : 'images'}` : tool.extensions[0] === 'pdf' ? 'a PDF' : tool.id === 'csv-to-excel' ? 'a CSV' : tool.id === 'excel-to-pdf' ? 'a spreadsheet' : tool.id === 'word-to-pdf' ? 'a Word file' : 'a file';

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    onFiles(Array.from(e.dataTransfer.files));
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); inputRef.current?.click(); } }}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={
        'w-full rounded border border-dashed text-center transition-colors ' +
        (compact ? 'px-4 py-3 ' : 'px-4 py-8 md:py-10 ') +
        (disabled ? 'border-neutral-200 bg-neutral-50 cursor-not-allowed opacity-60 ' : 'cursor-pointer ') +
        (over ? 'border-gold bg-neutral-50' : 'border-neutral-300 bg-white hover:bg-neutral-50')
      }
      data-testid="file-dropzone"
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={tool.multiple}
        className="hidden"
        onChange={(e) => { onFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }}
      />
      <div className={compact ? 'flex items-center justify-center gap-2' : ''}>
        <Upload size={compact ? 16 : 22} strokeWidth={1.5} className={'text-neutral-400 ' + (compact ? '' : 'mx-auto mb-2')} />
        <div className="text-13 text-neutral-900">
          {compact ? `Add more ${noun}` : <>Drag &amp; drop {noun} here, or <span className="text-gold font-medium">browse</span></>}
        </div>
      </div>
      {!compact ? <div className="text-12 text-neutral-500 mt-1">{supportedLine(tool)}</div> : null}
    </div>
  );
}
