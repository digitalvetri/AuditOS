import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Modal } from '@/modules/workstation/components';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { toolsApi, downloadDocument } from '../api';
import type { ToolDocument } from '../types';
import { formatBytes } from '../format';

/**
 * Preview for PDF (inline signed URL in an iframe), images, spreadsheets
 * (first rows per sheet) and text. Word and ZIP have no in-browser preview
 * and say so, with Download as the way forward.
 */
export function PreviewModal({ doc, onClose }: { doc: ToolDocument; onClose: () => void }) {
  const toast = useToast();
  const [sheet, setSheet] = useState(0);
  const q = useQuery({
    queryKey: ['tools', 'preview', doc.id],
    queryFn: () => toolsApi.documents.preview(doc.id),
    enabled: doc.status === 'completed',
    staleTime: 60_000,
  });

  return (
    <Modal open title={`${doc.filename} · ${formatBytes(doc.file_size)}`} onClose={onClose} width="w-[960px]"
      footer={<>
        <Button variant="secondary" size="sm" onClick={() => downloadDocument(doc.id).catch((e: Error) => toast.push('error', e.message))}>Download</Button>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </>}>
      {doc.status !== 'completed' ? (
        <div className="text-13 text-neutral-500">This document has no file to preview{doc.error_message ? ` — ${doc.error_message}` : '.'}</div>
      ) : q.isLoading ? (
        <div className="h-40 bg-neutral-100 rounded" aria-label="Loading preview" />
      ) : q.isError ? (
        <div className="text-13 text-red">Could not load the preview. {(q.error as Error).message}</div>
      ) : !q.data || q.data.kind === 'none' ? (
        <div className="text-13 text-neutral-500">Preview isn't available for this file type. Download it to open in the right application.</div>
      ) : q.data.kind === 'sheets' ? (
        <SheetsPreview sheets={q.data.sheets} sheet={sheet} setSheet={setSheet} />
      ) : q.data.kind === 'text' ? (
        <pre className="max-h-[70vh] overflow-auto text-12 leading-5 whitespace-pre-wrap bg-neutral-50 border border-neutral-200 rounded p-3 text-neutral-900">{q.data.text}{q.data.truncated ? '\n…' : ''}</pre>
      ) : q.data.kind === 'pdf' ? (
        <iframe title={doc.filename} src={q.data.url} className="w-full h-[70vh] border border-neutral-200 rounded bg-neutral-50" />
      ) : (
        <div className="max-h-[70vh] overflow-auto text-center"><img src={q.data.url} alt={doc.filename} className="inline-block max-w-full" /></div>
      )}
    </Modal>
  );
}

function SheetsPreview({ sheets, sheet, setSheet }: {
  sheets: { name: string; rows: string[][]; truncated: boolean }[]; sheet: number; setSheet: (i: number) => void;
}) {
  const s = sheets[Math.min(sheet, sheets.length - 1)];
  return (
    <div>
      {sheets.length > 1 ? (
        <div className="flex flex-wrap gap-1 mb-3">
          {sheets.map((x, i) => (
            <button key={x.name} type="button" onClick={() => setSheet(i)}
              className={'h-7 px-3 text-12 rounded border ' + (i === sheet ? 'bg-neutral-900 text-white border-neutral-900' : 'bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-50')}>
              {x.name}
            </button>
          ))}
        </div>
      ) : null}
      {!s ? <div className="text-13 text-neutral-500">Empty workbook.</div> : (
        <div className="max-h-[65vh] overflow-auto border border-neutral-200 rounded">
          <table className="min-w-full border-collapse text-12 tabular-nums">
            <tbody>
              {s.rows.map((r, ri) => (
                <tr key={ri} className={'border-b border-neutral-200 last:border-0 ' + (ri === 0 ? 'bg-neutral-50 font-medium' : '')}>
                  <td className="px-2 h-8 text-neutral-400 text-11 text-right w-8 sticky left-0 bg-white">{ri + 1}</td>
                  {r.map((c, ci) => <td key={ci} className="px-2 h-8 whitespace-pre-wrap text-neutral-900 align-top max-w-[320px]">{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {s.truncated ? <div className="px-2 py-1 text-12 text-neutral-500 border-t border-neutral-200">Showing the first {s.rows.length} rows.</div> : null}
        </div>
      )}
    </div>
  );
}
