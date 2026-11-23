/**
 * /tools/pdf-editor — the PDF editor inside the Tools workspace.
 *
 * The chosen PDF is uploaded like any tool input (so the output lands in
 * Tool documents with an audit trail) and, at the same time, opened in the
 * browser for editing. Save sends the edit list; the server applies it to the
 * original and returns the new PDF. The editor stays open behind the result,
 * so "Keep editing" carries on with every edit intact.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Button } from '@/components/Button';
import type { ToolDefinition } from '../registry';
import { useToolWorkspace } from '../workspace/useToolWorkspace';
import { FileDropzone } from '../workspace/FileDropzone';
import { ResultPanel } from '../workspace/ResultPanel';
import { ToolErrorState } from '../workspace/ToolErrorState';
import { openPdf } from './pdfjs';
import { PdfEditor } from './PdfEditor';
import type { PageInfo } from './model';

type Opened =
  | { state: 'loading' }
  | { state: 'ready'; doc: PDFDocumentProxy; originals: PageInfo[] }
  | { state: 'error'; reason: 'password' | 'invalid'; message: string };

export default function PdfEditorWorkspace({ tool }: { tool: ToolDefinition }) {
  const ws = useToolWorkspace(tool);
  const file = ws.files[0] ?? null;
  const [opened, setOpened] = useState<Opened | null>(null);
  const [showResult, setShowResult] = useState(false);

  useEffect(() => {
    if (!file) { setOpened(null); return; }
    let live = true;
    let doc: PDFDocumentProxy | null = null;
    setOpened({ state: 'loading' });
    void (async () => {
      const r = await openPdf(file.file);
      if (!live) { if (r.ok) void r.doc.destroy(); return; }
      if (!r.ok) { setOpened({ state: 'error', reason: r.reason, message: r.message }); return; }
      doc = r.doc;
      const originals: PageInfo[] = [];
      for (let i = 1; i <= r.doc.numPages; i++) {
        const pg = await r.doc.getPage(i);
        originals.push({ view: pg.view, rotate: pg.rotate, userUnit: (pg as unknown as { userUnit?: number }).userUnit ?? 1 });
      }
      if (live) setOpened({ state: 'ready', doc: r.doc, originals });
    })();
    return () => { live = false; void doc?.destroy(); };
  // The File object identifies the upload; a new file reopens.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.file]);

  useEffect(() => { if (ws.phase === 'success') setShowResult(true); }, [ws.phase]);

  if (!file) {
    return (
      <div className="max-w-[760px] mx-auto space-y-3">
        <FileDropzone tool={tool} onFiles={ws.addFiles} />
        <ul className="text-13 text-neutral-600 list-disc pl-5 space-y-1">
          <li><strong>Edit text</strong>: click any line in the PDF and retype it.</li>
          <li>Add text, white-out, highlights, boxes, freehand drawing, images and your signature.</li>
          <li>Rotate, reorder and delete pages, or add blank ones.</li>
          <li>The original is never changed: you download an edited copy.</li>
        </ul>
      </div>
    );
  }

  const uploadState = file.status === 'invalid'
    ? <span className="text-[#b91c1c]">{file.error}</span>
    : file.status === 'ready' ? null : <span>Preparing the file… {file.progress ? `${file.progress}%` : ''}</span>;

  return (
    <div className="space-y-3" data-testid="pdf-editor">
      <div className="flex items-center gap-3 text-13 text-neutral-600 flex-wrap">
        {uploadState}
        <span className="flex-1" />
        <button type="button" className="text-13 text-primary hover:underline" onClick={() => { setShowResult(false); ws.reset(); }}>
          Open a different PDF
        </button>
      </div>

      {opened?.state === 'error' ? (
        <div className="border-l-2 border-amber pl-3 py-1">
          <p className="text-13 text-neutral-800">{opened.message}</p>
          {opened.reason === 'password' ? <Link to="/tools/unlock-pdf" className="text-13 text-primary hover:underline">Open Unlock PDF</Link> : null}
        </div>
      ) : null}
      {opened?.state === 'loading' ? <p className="text-13 text-neutral-500">Opening the PDF…</p> : null}

      {ws.phase === 'failed' && ws.run.error ? (
        <ToolErrorState code={ws.run.error.code} message={ws.run.error.message} problems={ws.run.error.problems}
          onRetry={ws.retry} onReset={() => { setShowResult(false); ws.reset(); }} />
      ) : null}

      {showResult && ws.run.output ? (
        <div className="space-y-2">
          <ResultPanel output={ws.run.output} warning={ws.run.warning} onReset={() => { setShowResult(false); ws.reset(); }} />
          <Button onClick={() => { setShowResult(false); ws.retry(); }}>Keep editing</Button>
        </div>
      ) : null}

      {opened?.state === 'ready' ? (
        <div className={showResult ? 'hidden' : ''}>
          <PdfEditor
            doc={opened.doc} originals={opened.originals} fileName={file.file.name}
            canSave={file.status === 'ready'} saving={ws.phase === 'processing'}
            onSave={(spec) => void ws.start({ edits: spec })}
          />
        </div>
      ) : null}
    </div>
  );
}
