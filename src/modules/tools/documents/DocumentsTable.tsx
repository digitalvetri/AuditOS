import { StatusLabel, type StatusVariant } from '@/components/StatusRow';
import { Cell, Row, Table } from '@/modules/workstation/components';
import { fmtDate, fmtTime } from '@/lib/format';
import type { ToolDocument } from '../types';
import { FILE_TYPE_LABEL, formatBytes } from '../format';

export function documentStatus(d: ToolDocument): { variant: StatusVariant; label: string } {
  if (d.status === 'failed') return { variant: 'problem', label: 'Failed' };
  if (d.status === 'processing') return { variant: 'awaiting', label: 'Processing' };
  return { variant: 'ok', label: 'Completed' };
}

/** '08 Sep, 10:35 AM' */
export function fmtShort(iso: string): string {
  return `${fmtDate(iso).slice(0, 6)}, ${fmtTime(iso)}`;
}

/**
 * Desktop: the CRM table (40px rows, hairline separators). Mobile: a card
 * list with the same facts. Row click opens the detail drawer.
 */
export function DocumentsTable({ items, selectedId, onSelect, onPreview, onDownload }: {
  items: ToolDocument[];
  selectedId: string | null;
  onSelect: (d: ToolDocument) => void;
  onPreview: (d: ToolDocument) => void;
  onDownload: (d: ToolDocument) => void;
}) {
  const statusKey = (d: ToolDocument) => (d.status === 'failed' ? 'failed' : d.status === 'processing' ? 'pending' : 'completed');
  return (
    <>
      <div className="hidden md:block">
        <Table head={['Filename', 'Tool', 'Type', 'Size', 'Created', 'By', 'Status', '']}>
          {items.map((d) => (
            <Row key={d.id} status={statusKey(d)} onClick={() => onSelect(d)}>
              <Cell className={'font-medium max-w-[320px] ' + (selectedId === d.id ? 'text-gold' : '')}>
                <span className="block truncate" title={d.filename}>{d.filename}</span>
              </Cell>
              <Cell muted>{d.tool_name ?? '—'}</Cell>
              <Cell muted>{FILE_TYPE_LABEL[d.file_type]}</Cell>
              <Cell muted className="tabular-nums whitespace-nowrap">{d.status === 'completed' ? formatBytes(d.file_size) : '—'}</Cell>
              <Cell muted className="whitespace-nowrap tabular-nums">{fmtShort(d.created_at)}</Cell>
              <Cell muted className="whitespace-nowrap">{d.created_by.label}</Cell>
              <Cell><StatusLabel {...documentStatus(d)} /></Cell>
              <Cell className="whitespace-nowrap text-right">
                {d.status === 'completed' ? (
                  <span className="inline-flex gap-3" onClick={(e) => e.stopPropagation()}>
                    {['pdf', 'image', 'excel', 'text', 'csv'].includes(d.file_type) ? (
                      <button type="button" onClick={() => onPreview(d)} className="text-12 text-neutral-700 hover:text-neutral-900 underline">Preview</button>
                    ) : null}
                    <button type="button" onClick={() => onDownload(d)} className="text-12 text-neutral-700 hover:text-neutral-900 underline">Download</button>
                  </span>
                ) : null}
              </Cell>
            </Row>
          ))}
        </Table>
      </div>

      <ul className="md:hidden divide-y divide-neutral-200">
        {items.map((d) => {
          const s = documentStatus(d);
          const border = s.variant === 'problem' ? 'border-red' : s.variant === 'awaiting' ? 'border-neutral-400' : 'border-transparent';
          return (
            <li key={d.id} className={`border-l-2 ${border} px-3 py-3`} onClick={() => onSelect(d)}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-13 font-medium text-neutral-900 truncate">{d.filename}</div>
                  <div className="text-12 text-neutral-500 mt-0.5">{d.tool_name ?? '—'} · {FILE_TYPE_LABEL[d.file_type]}{d.status === 'completed' ? ` · ${formatBytes(d.file_size)}` : ''}</div>
                  <div className="text-12 text-neutral-500">{fmtShort(d.created_at)} · {d.created_by.label}</div>
                </div>
                <StatusLabel {...s} className="shrink-0" />
              </div>
              {d.status === 'completed' ? (
                <div className="flex gap-3 mt-2" onClick={(e) => e.stopPropagation()}>
                  {['pdf', 'image', 'excel', 'text', 'csv'].includes(d.file_type) ? (
                    <button type="button" onClick={() => onPreview(d)} className="text-12 text-neutral-700 underline">Preview</button>
                  ) : null}
                  <button type="button" onClick={() => onDownload(d)} className="text-12 text-neutral-700 underline">Download</button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
