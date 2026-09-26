import { useState, type FormEvent } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { tallyAccountingApi, type StockSummary } from '@/modules/tools/audit-automation/tally';
import { DataTable, Money, Panel, Loading, ErrorNote, usePeriod, ReportHeader, ExportButtons, qty, type Column } from '@/modules/tools/tally/ui';
import type { ApiError } from '@/services/api';

/**
 * /inventory — stock summary and item masters.
 *
 * Closing quantity is opening + inward − outward, computed from the
 * vouchers. Negative stock is shown as negative, flagged, and never
 * clamped to zero: a warehouse that owes stock it never received is
 * exactly what an auditor needs to see.
 */
export function BookkeepingInventory() {
  const { companyId = '' } = useParams();
  const { from, to } = usePeriod();
  const navigate = useNavigate();
  const [showNew, setShowNew] = useState(false);
  const base = `/tally/companies/${companyId}`;

  const summaryQ = useQuery({
    queryKey: ['tally.stockSummary', companyId, from, to],
    queryFn: () => tallyAccountingApi.stockSummary(companyId, { from, to }),
  });
  const godownQ = useQuery({
    queryKey: ['tally.godownSummary', companyId, to],
    queryFn: () => tallyAccountingApi.godownSummary(companyId, { to }),
  });

  if (summaryQ.isLoading) return <Loading />;
  if (summaryQ.isError) return <ErrorNote message={(summaryQ.error as Error).message} />;
  const d = summaryQ.data!;
  const columns = stockColumns(base);

  return (
    <div data-testid="tally-inventory">
      <ReportHeader
        title="Stock Summary"
        subtitle={`${from} to ${to} · valued at the weighted-average cost of opening plus purchases`}
        actions={
          <>
            <ExportButtons filename="stock-summary.csv" rows={d.items} columns={columns} />
            <Button variant="primary" size="sm" onClick={() => setShowNew(true)}><Plus size={14} className="mr-1" /> New item</Button>
          </>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
        <div className="bg-white border border-neutral-200 rounded p-3">
          <div className="text-11 text-neutral-500">Closing stock value</div>
          <div className="text-16 font-semibold text-neutral-900 mt-0.5"><Money paise={d.totals.closing_value_paise} /></div>
        </div>
        <Flag label="Negative stock" count={d.totals.negative_count} tone="danger" />
        <Flag label="Below reorder level" count={d.totals.below_reorder_count} tone="warn" />
      </div>

      <Panel className="mb-4">
        <DataTable
          minWidth="1000px"
          rows={d.items}
          rowKey={(r) => r.stock_item_id}
          columns={columns}
          onRowClick={(r) => navigate(`${base}/inventory/items/${r.stock_item_id}`)}
          empty="No stock items yet. Create one to start tracking inventory."
        />
      </Panel>

      <Panel title="Godown-wise closing quantity">
        <DataTable
          minWidth="520px"
          rows={godownQ.data?.rows ?? []}
          rowKey={(r, i) => `${r.godown_id ?? 'none'}-${r.stock_item_id}-${i}`}
          columns={[
            { key: 'godown', label: 'Godown', value: (r) => r.godown_name },
            { key: 'item', label: 'Item', value: (r) => r.stock_item_name },
            { key: 'qty', label: 'Closing qty', align: 'right', value: (r) => r.closing_qty_milli / 1000, render: (r) => <span className="tabular-nums">{qty(r.closing_qty_milli)}</span> },
          ]}
          empty="No godown-wise stock yet."
        />
      </Panel>

      {showNew ? <NewItemModal companyId={companyId} onClose={() => setShowNew(false)} /> : null}
    </div>
  );
}

function Flag({ label, count, tone }: { label: string; count: number; tone: 'danger' | 'warn' }) {
  const on = count > 0;
  return (
    <div className={`bg-white border rounded p-3 ${on ? (tone === 'danger' ? 'border-danger/40' : 'border-amber-300') : 'border-neutral-200'}`}>
      <div className="text-11 text-neutral-500 flex items-center gap-1">
        {on ? <AlertTriangle size={12} className={tone === 'danger' ? 'text-danger' : 'text-amber-600'} /> : null}
        {label}
      </div>
      <div className="text-16 font-semibold text-neutral-900 mt-0.5">{count}</div>
    </div>
  );
}

function stockColumns(base: string): Column<StockSummary['items'][number]>[] {
  return [
    {
      key: 'item', label: 'Item', value: (r) => r.stock_item_name,
      render: (r) => (
        <Link to={`${base}/inventory/items/${r.stock_item_id}`} className="text-neutral-900 hover:text-gold">
          {r.stock_item_name}
          {r.negative ? <span className="ml-1 text-10 text-danger uppercase">negative</span> : null}
          {r.below_reorder ? <span className="ml-1 text-10 text-amber-600 uppercase">reorder</span> : null}
        </Link>
      ),
    },
    { key: 'hsn', label: 'HSN', value: (r) => r.hsn_code ?? '', render: (r) => <span className="font-mono text-12 text-neutral-500">{r.hsn_code ?? '—'}</span> },
    { key: 'unit', label: 'Unit', value: (r) => r.unit_name ?? '' },
    { key: 'opening', label: 'Opening', align: 'right', value: (r) => r.opening_qty_milli / 1000, render: (r) => <span className="tabular-nums">{qty(r.opening_qty_milli)}</span> },
    { key: 'in', label: 'Inward', align: 'right', value: (r) => r.inward_qty_milli / 1000, render: (r) => <span className="tabular-nums">{qty(r.inward_qty_milli)}</span> },
    { key: 'out', label: 'Outward', align: 'right', value: (r) => r.outward_qty_milli / 1000, render: (r) => <span className="tabular-nums">{qty(r.outward_qty_milli)}</span> },
    { key: 'closing', label: 'Closing', align: 'right', value: (r) => r.closing_qty_milli / 1000, render: (r) => <span className={`tabular-nums font-medium ${r.negative ? 'text-danger' : ''}`}>{qty(r.closing_qty_milli)}</span> },
    { key: 'rate', label: 'Avg rate', align: 'right', value: (r) => r.avg_rate_paise / 100, render: (r) => <Money paise={r.avg_rate_paise} /> },
    { key: 'value', label: 'Closing value', align: 'right', value: (r) => r.closing_value_paise / 100, render: (r) => <Money paise={r.closing_value_paise} /> },
  ];
}

function NewItemModal({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ name: '', unit_id: '', hsn_code: '', gst_rate_pct: '18', reorder: '', price: '', cost: '', openingQty: '', openingRate: '' });
  const [err, setErr] = useState<string | null>(null);
  const unitsQ = useQuery({ queryKey: ['tally.units', companyId], queryFn: () => tallyAccountingApi.listUnits(companyId) });
  const godownsQ = useQuery({ queryKey: ['tally.godowns', companyId], queryFn: () => tallyAccountingApi.listGodowns(companyId) });

  const create = useMutation({
    mutationFn: () => tallyAccountingApi.createStockItem(companyId, {
      name: form.name.trim(),
      unit_id: form.unit_id || null,
      hsn_code: form.hsn_code.trim() || null,
      gst_rate_bp: Math.round((Number(form.gst_rate_pct) || 0) * 100),
      reorder_level_milli: Math.round((Number(form.reorder) || 0) * 1000),
      standard_price_paise: Math.round((Number(form.price) || 0) * 100),
      standard_cost_paise: Math.round((Number(form.cost) || 0) * 100),
      opening_qty_milli: Math.round((Number(form.openingQty) || 0) * 1000),
      opening_rate_paise: Math.round((Number(form.openingRate) || 0) * 100),
      opening_godown_id: godownsQ.data?.items[0]?.id ?? null,
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tally.stockSummary', companyId] });
      await qc.invalidateQueries({ queryKey: ['tally.stockItems', companyId] });
      toast.push('success', `Stock item "${form.name}" created.`);
      onClose();
    },
    onError: (e: ApiError) => setErr(e.message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) { setErr('Item name is required.'); return; }
    setErr(null);
    create.mutate();
  }

  const cls = 'h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={submit} className="bg-white rounded shadow-lg w-full max-w-[560px] max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-3 border-b border-neutral-200 flex items-center justify-between sticky top-0 bg-white">
          <h2 className="text-14 font-semibold text-neutral-900">New stock item</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-neutral-400 hover:text-neutral-700"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <L label="Item name" required><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={cls} autoFocus /></L>
          <div className="grid grid-cols-2 gap-3">
            <L label="Unit">
              <select value={form.unit_id} onChange={(e) => setForm({ ...form, unit_id: e.target.value })} className={cls}>
                <option value="">—</option>
                {(unitsQ.data?.items ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </L>
            <L label="HSN / SAC"><input value={form.hsn_code} onChange={(e) => setForm({ ...form, hsn_code: e.target.value })} className={`${cls} font-mono`} /></L>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <L label="GST rate %"><input value={form.gst_rate_pct} onChange={(e) => setForm({ ...form, gst_rate_pct: e.target.value })} className={`${cls} text-right font-mono`} /></L>
            <L label="Sale price ₹"><input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} className={`${cls} text-right font-mono`} /></L>
            <L label="Cost ₹"><input value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} className={`${cls} text-right font-mono`} /></L>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <L label="Reorder level"><input value={form.reorder} onChange={(e) => setForm({ ...form, reorder: e.target.value })} className={`${cls} text-right font-mono`} /></L>
            <L label="Opening qty"><input value={form.openingQty} onChange={(e) => setForm({ ...form, openingQty: e.target.value })} className={`${cls} text-right font-mono`} /></L>
            <L label="Opening rate ₹"><input value={form.openingRate} onChange={(e) => setForm({ ...form, openingRate: e.target.value })} className={`${cls} text-right font-mono`} /></L>
          </div>
          {err ? <div className="text-13 text-danger">{err}</div> : null}
        </div>
        <div className="px-5 py-3 border-t border-neutral-200 flex justify-end gap-2 sticky bottom-0 bg-white">
          <Button type="button" size="sm" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" variant="primary" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create item'}</Button>
        </div>
      </form>
    </div>
  );
}

function L({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-12 font-medium text-neutral-700 mb-1">{label}{required ? <span className="text-danger"> *</span> : null}</span>
      {children}
    </label>
  );
}

/** /inventory/items/:itemId — stock movement for one item. */
export function BookkeepingStockItemPage() {
  const { companyId = '', itemId = '' } = useParams();
  const { from, to } = usePeriod();
  const base = `/tally/companies/${companyId}`;
  const moveQ = useQuery({
    queryKey: ['tally.stockMovement', companyId, itemId, from, to],
    queryFn: () => tallyAccountingApi.stockMovement(companyId, itemId, { from, to }),
  });
  const summaryQ = useQuery({
    queryKey: ['tally.stockSummary', companyId, from, to],
    queryFn: () => tallyAccountingApi.stockSummary(companyId, { from, to }),
  });
  if (moveQ.isLoading || summaryQ.isLoading) return <Loading />;
  if (moveQ.isError) return <ErrorNote message={(moveQ.error as Error).message} />;
  const item = summaryQ.data?.items.find((i) => i.stock_item_id === itemId);
  const rows = moveQ.data!.rows;
  return (
    <div data-testid="tally-stock-item">
      <Link to={`${base}/inventory`} className="text-12 text-neutral-500 hover:text-neutral-900">← Stock summary</Link>
      <ReportHeader title={item?.stock_item_name ?? 'Stock item'} subtitle={`${from} to ${to}${item?.hsn_code ? ` · HSN ${item.hsn_code}` : ''}`} />
      {item ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
          <Cell label="Opening" text={qty(item.opening_qty_milli)} />
          <Cell label="Inward" text={qty(item.inward_qty_milli)} />
          <Cell label="Outward" text={qty(item.outward_qty_milli)} />
          <Cell label="Closing" text={qty(item.closing_qty_milli)} danger={item.negative} />
        </div>
      ) : null}
      <Panel title="Movement">
        <DataTable
          minWidth="760px"
          rows={rows}
          rowKey={(r, i) => `${r.voucher_id}-${i}`}
          columns={[
            { key: 'date', label: 'Date', value: (r) => r.date },
            { key: 'voucher', label: 'Voucher', value: (r) => r.voucher_number, render: (r) => <Link to={`${base}/vouchers/${r.voucher_id}`} className="text-neutral-900 hover:text-gold">{r.voucher_type_code.replace(/_/g, ' ')} {r.voucher_number}</Link> },
            { key: 'party', label: 'Party', value: (r) => r.party_name ?? '' },
            { key: 'godown', label: 'Godown', value: (r) => r.godown_name ?? '' },
            { key: 'in', label: 'In', align: 'right', value: (r) => (r.direction === 'in' ? r.qty_milli / 1000 : ''), render: (r) => (r.direction === 'in' ? <span className="tabular-nums">{qty(r.qty_milli)}</span> : <span className="text-neutral-300">—</span>) },
            { key: 'out', label: 'Out', align: 'right', value: (r) => (r.direction === 'out' ? r.qty_milli / 1000 : ''), render: (r) => (r.direction === 'out' ? <span className="tabular-nums">{qty(r.qty_milli)}</span> : <span className="text-neutral-300">—</span>) },
            { key: 'rate', label: 'Rate', align: 'right', value: (r) => r.rate_paise / 100, render: (r) => <Money paise={r.rate_paise} /> },
            { key: 'value', label: 'Value', align: 'right', value: (r) => r.amount_paise / 100, render: (r) => <Money paise={r.amount_paise} /> },
          ]}
          empty="No movement for this item in the selected period."
        />
      </Panel>
    </div>
  );
}

function Cell({ label, text, danger }: { label: string; text: string; danger?: boolean }) {
  return (
    <div className="bg-white border border-neutral-200 rounded p-3">
      <div className="text-11 text-neutral-500">{label}</div>
      <div className={`text-16 font-semibold mt-0.5 tabular-nums ${danger ? 'text-danger' : 'text-neutral-900'}`}>{text}</div>
    </div>
  );
}
