import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { Card, FilterBar, QueryState, Select } from '@/modules/workstation/components';
import { toolsApi, downloadDocument } from '@/modules/tools/api';
import { TOOLS } from '@/modules/tools/registry';
import type { DocumentFilters, DocumentsList, ToolDocument } from '@/modules/tools/types';
import { DocumentsTable } from '@/modules/tools/documents/DocumentsTable';
import { DocumentDetailDrawer } from '@/modules/tools/documents/DocumentDetailDrawer';
import { PreviewModal } from '@/modules/tools/documents/PreviewModal';

/**
 * /tools/documents — every generated file (§9). Filters live in the URL so
 * a view can be shared; the table is the CRM table; on mobile it becomes a
 * card list. Row click opens the detail drawer.
 */
export function ToolDocumentsPage() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const [selected, setSelected] = useState<ToolDocument | null>(null);
  const [preview, setPreview] = useState<ToolDocument | null>(null);

  const q = params.get('q') ?? '';
  const [search, setSearch] = useState(q);
  useEffect(() => {
    const t = window.setTimeout(() => { if (search !== q) setParam('q', search); }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const filters: DocumentFilters = useMemo(() => ({
    q,
    file_type: (params.get('type') ?? '') as DocumentFilters['file_type'],
    tool: params.get('tool') ?? '',
    status: (params.get('status') ?? '') as DocumentFilters['status'],
    user_id: params.get('by') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    kind: (params.get('kind') ?? 'output') as DocumentFilters['kind'],
  }), [params, q]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  const docs = useQuery({ queryKey: ['tools', 'documents', filters], queryFn: () => toolsApi.documents.list(filters), refetchInterval: (query) => (query.state.data?.items.some((d) => d.status === 'processing') ? 2000 : false) });

  const download = (d: ToolDocument) => downloadDocument(d.id).catch((e: Error) => toast.push('error', e.message));

  return (
    <div className="max-w-[1400px] mx-auto" data-testid="tool-documents-page">
      <Link to="/tools" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900 mb-3">
        <ArrowLeft size={14} strokeWidth={1.75} />
        Back to Tools
      </Link>
      <header className="flex items-start gap-4 mb-4">
        <div className="min-w-0">
          <h1 className="text-20 font-semibold text-neutral-900">Documents</h1>
          <p className="text-13 text-neutral-500 mt-1">Every file the tools produce — search, preview, download or delete.</p>
        </div>
      </header>

      <FilterBar>
        <label className="block">
          <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Search</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filename, tool or type"
            className="h-8 px-3 w-[220px] max-w-full text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold"
            data-testid="documents-search"
          />
        </label>
        <Select label="Type" value={filters.file_type ?? ''} onChange={(v) => setParam('type', v)}
          options={[{ value: 'pdf', label: 'PDF' }, { value: 'excel', label: 'Excel' }, { value: 'word', label: 'Word' }, { value: 'csv', label: 'CSV' }, { value: 'image', label: 'Image' }, { value: 'text', label: 'Text' }, { value: 'other', label: 'Other' }]} />
        <Select label="Tool" value={filters.tool ?? ''} onChange={(v) => setParam('tool', v)}
          options={TOOLS.filter((t) => t.status === 'active').map((t) => ({ value: t.id, label: t.name }))} />
        <Select label="Status" value={filters.status ?? ''} onChange={(v) => setParam('status', v)}
          options={[{ value: 'completed', label: 'Completed' }, { value: 'failed', label: 'Failed' }, { value: 'processing', label: 'Processing' }]} />
        {docs.data && docs.data.scope === 'organisation' ? (
          <Select label="Created by" value={filters.user_id ?? ''} onChange={(v) => setParam('by', v)} options={docs.data.creators.map((c) => ({ value: c.id, label: c.label }))} />
        ) : null}
        <DateInput label="From" value={filters.from ?? ''} onChange={(v) => setParam('from', v)} />
        <DateInput label="To" value={filters.to ?? ''} onChange={(v) => setParam('to', v)} />
        <Select label="Show" value={filters.kind === 'output' ? '' : filters.kind ?? ''} onChange={(v) => setParam('kind', v)} allLabel="Generated files"
          options={[{ value: 'input', label: 'Uploaded sources' }, { value: 'all', label: 'Everything' }]} />
      </FilterBar>

      <Card>
        <QueryState query={docs} empty="No documents match these filters. Run a tool and its output will appear here.">
          {(data: DocumentsList) => (
            <DocumentsTable items={data.items} selectedId={selected?.id ?? null} onSelect={setSelected} onPreview={setPreview} onDownload={download} />
          )}
        </QueryState>
      </Card>

      {docs.data ? (
        <p className="text-12 text-neutral-500 mt-3">
          {docs.data.count} document{docs.data.count === 1 ? '' : 's'} · {docs.data.scope === 'organisation' ? 'all firm documents' : 'your documents'}
        </p>
      ) : null}

      {selected ? (
        <>
          <div className="fixed inset-0 z-30 bg-black/[0.16] sm:bg-transparent" onClick={() => setSelected(null)} aria-hidden />
          <DocumentDetailDrawer doc={selected} onClose={() => setSelected(null)} onPreview={setPreview} onDeleted={() => setSelected(null)} />
        </>
      ) : null}
      {preview ? <PreviewModal doc={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

function DateInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">{label}</span>
      <input type="date" value={value} onChange={(e) => onChange(e.target.value)}
        className="h-8 px-2 text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold" />
    </label>
  );
}
