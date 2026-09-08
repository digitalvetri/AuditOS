import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { downloadDocument } from '../api';
import { DOCUMENTS_ROUTE } from '../registry';
import { formatBytes } from '../format';
import type { ToolDocument } from '../types';
import { Notice } from './fields';
import { PreviewModal } from '../documents/PreviewModal';

/**
 * Output file + Preview / Download / Open in Documents. A partial result
 * (some pages skipped, low OCR confidence, negligible compression) is shown
 * as a warning line — never dressed up as a clean success (§13).
 */
export function ResultPanel({ output, warning, onReset, children }: {
  output: ToolDocument; warning: string | null; onReset: () => void; children?: ReactNode;
}) {
  const toast = useToast();
  const [preview, setPreview] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const canPreview = ['pdf', 'image', 'excel', 'text', 'csv'].includes(output.file_type);

  const download = async () => {
    setDownloading(true);
    try { await downloadDocument(output.id); } catch (e) { toast.push('error', (e as Error).message); } finally { setDownloading(false); }
  };

  return (
    <div data-testid="result-panel">
      <div className="flex items-center gap-2 text-14 font-medium text-neutral-900">
        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-success text-white"><Check size={14} strokeWidth={2.5} /></span>
        {warning ? 'Completed with notes' : 'Conversion completed'}
      </div>
      <div className="mt-2 text-13 text-neutral-900">
        <span className="font-medium">{output.filename}</span>
        <span className="text-neutral-500"> · {formatBytes(output.file_size)}</span>
      </div>
      {warning ? <div className="mt-3"><Notice tone="warn">{warning}</Notice></div> : null}
      {children ? <div className="mt-3">{children}</div> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {canPreview ? <Button variant="secondary" onClick={() => setPreview(true)} data-testid="result-preview">Preview</Button> : null}
        <Button variant="primary" onClick={download} disabled={downloading} data-testid="result-download">{downloading ? 'Preparing…' : 'Download'}</Button>
        <Link to={DOCUMENTS_ROUTE} className="inline-flex items-center h-10 px-5 text-14 rounded-md font-medium bg-surface text-ink border border-border hover:bg-canvas">
          Open in Documents
        </Link>
        <button type="button" onClick={onReset} className="text-13 text-neutral-500 hover:text-neutral-900 ml-auto" data-testid="result-reset">
          Convert another file
        </button>
      </div>
      {preview ? <PreviewModal doc={output} onClose={() => setPreview(false)} /> : null}
    </div>
  );
}
