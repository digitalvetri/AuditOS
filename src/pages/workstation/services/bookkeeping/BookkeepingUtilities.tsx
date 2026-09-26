import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Upload, Database, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { tallyAccountingApi, type ImportPreview } from '@/modules/tools/audit-automation/tally';
import { DataTable, Panel, Loading, ReportHeader, parseCsv, usePeriod } from '@/modules/tools/tally/ui';
import type { ApiError } from '@/services/api';

/**
 * /utilities — import, export, backup and restore.
 *
 * Import is two-phase on purpose: validate first, see exactly what would
 * happen, then commit. A file with a bad row imports nothing unless you
 * explicitly choose to skip the bad rows.
 *
 * Restore always creates a NEW company. There is no in-place overwrite in
 * this UI, so a restore can never silently destroy live books.
 */
const ENTITIES = [
  { key: 'ledgers', label: 'Ledgers', columns: 'name, under, opening_balance, dr_cr, gstin, pan, state' },
  { key: 'groups', label: 'Groups', columns: 'name, under, nature' },
  { key: 'stock_items', label: 'Stock items', columns: 'name, unit, hsn_code, gst_rate_pct, opening_qty, opening_rate' },
  { key: 'opening_balances', label: 'Opening balances', columns: 'ledger, amount, dr_cr' },
  { key: 'vouchers', label: 'Vouchers (one row per line)', columns: 'voucher_key, voucher_type, date, voucher_number, ledger, dr_cr, amount, narration' },
];

export function BookkeepingUtilities() {
  const { companyId = '' } = useParams();
  const { from, to } = usePeriod();
  const qc = useQueryClient();
  const toast = useToast();
  const [entity, setEntity] = useState('ledgers');
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [restoreName, setRestoreName] = useState('');

  const backupsQ = useQuery({ queryKey: ['tally.backups', companyId], queryFn: () => tallyAccountingApi.listBackups(companyId) });

  const rowsOf = () => parseCsv(csv).rows as unknown as Record<string, unknown>[];

  const validate = useMutation({
    mutationFn: () => tallyAccountingApi.validateImport(companyId, entity, rowsOf()),
    onSuccess: (p) => { setPreview(p); setErr(null); },
    onError: (e: ApiError) => setErr(e.message),
  });
  const commit = useMutation({
    mutationFn: (skipInvalid: boolean) => tallyAccountingApi.commitImport(companyId, entity, rowsOf(), skipInvalid),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['tally.ledgers', companyId] });
      await qc.invalidateQueries({ queryKey: ['tally.vouchers', companyId] });
      toast.push('success', `Import finished: ${JSON.stringify(r)}`);
      setCsv(''); setPreview(null);
    },
    onError: (e: ApiError) => setErr(e.message),
  });
  const backup = useMutation({
    mutationFn: () => tallyAccountingApi.createBackup(companyId),
    onSuccess: async (b) => { await qc.invalidateQueries({ queryKey: ['tally.backups', companyId] }); toast.push('success', `Backup created — ${b.voucher_count} vouchers, ${(b.size_bytes / 1024).toFixed(0)} KB.`); },
    onError: (e: ApiError) => toast.push('error', e.message),
  });
  const restore = useMutation({
    mutationFn: (backupId: string) => tallyAccountingApi.restoreBackup(companyId, backupId, restoreName.trim()),
    onSuccess: (r) => toast.push('success', `Restored into "${r.restored_company_name}" — ${r.vouchers_restored} vouchers.`),
    onError: (e: ApiError) => toast.push('error', e.message),
  });

  const active = ENTITIES.find((e) => e.key === entity)!;

  return (
    <div data-testid="tally-utilities">
      <ReportHeader title="Import, export &amp; backup" subtitle="Nothing here writes until you have seen what it would do." />

      <Panel title="Import" className="mb-4">
        <div className="p-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            {ENTITIES.map((e) => (
              <button key={e.key} type="button" onClick={() => { setEntity(e.key); setPreview(null); }}
                className={`h-8 px-3 text-12 rounded border ${entity === e.key ? 'bg-neutral-100 border-neutral-300 font-medium' : 'bg-white border-neutral-200 hover:bg-neutral-50'}`}>
                {e.label}
              </button>
            ))}
          </div>
          <p className="text-12 text-neutral-500">Expected columns: <code className="text-11">{active.columns}</code></p>
          <textarea
            value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null); }} rows={6}
            placeholder="Paste CSV including the header row"
            className="w-full px-2 py-1 text-12 font-mono border border-neutral-300 rounded focus:outline-none focus:border-gold"
          />
          {err ? <div className="text-12 text-danger">{err}</div> : null}
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => validate.mutate()} disabled={!csv.trim() || validate.isPending}>
              {validate.isPending ? 'Checking…' : 'Validate'}
            </Button>
            <Button size="sm" variant="primary" onClick={() => commit.mutate(false)} disabled={!preview || preview.invalid_rows > 0 || commit.isPending}>
              <Upload size={13} className="mr-1" /> Import {preview ? `${preview.valid_rows} row(s)` : ''}
            </Button>
            {preview && preview.invalid_rows > 0 ? (
              <Button size="sm" variant="secondary" onClick={() => commit.mutate(true)} disabled={commit.isPending}>
                Import the {preview.valid_rows} valid rows only
              </Button>
            ) : null}
          </div>

          {preview ? (
            <div className="border border-neutral-200 rounded">
              <div className="px-3 py-2 border-b border-neutral-100 text-12 flex flex-wrap gap-4">
                <span>{preview.total_rows} rows</span>
                <span className="text-emerald-700">{preview.valid_rows} valid</span>
                <span className={preview.invalid_rows ? 'text-danger' : 'text-neutral-500'}>{preview.invalid_rows} invalid</span>
                <span className="text-amber-700">{preview.duplicate_rows} duplicate</span>
              </div>
              {preview.issues.length ? (
                <ul className="max-h-[220px] overflow-y-auto divide-y divide-neutral-100">
                  {preview.issues.map((i, n) => (
                    <li key={n} className="px-3 py-1.5 text-12 flex gap-2">
                      <span className={i.severity === 'error' ? 'text-danger' : 'text-amber-700'}>row {i.row + 2}</span>
                      <span className="text-neutral-700">{i.message}</span>
                    </li>
                  ))}
                </ul>
              ) : <div className="px-3 py-2 text-12 text-emerald-700">No issues found.</div>}
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel title="Export" className="mb-4">
        <div className="p-3 flex flex-wrap gap-2">
          <a href={tallyAccountingApi.exportJsonUrl(companyId)} target="_blank" rel="noreferrer"
            className="h-8 px-3 inline-flex items-center gap-1 text-12 border border-neutral-300 rounded bg-white hover:bg-neutral-50">
            <Download size={13} /> Company JSON (masters + vouchers)
          </a>
          <a href={tallyAccountingApi.exportXmlUrl(companyId, { from, to })} target="_blank" rel="noreferrer"
            className="h-8 px-3 inline-flex items-center gap-1 text-12 border border-neutral-300 rounded bg-white hover:bg-neutral-50">
            <Download size={13} /> Voucher XML ({from} to {to})
          </a>
          <span className="text-11 text-neutral-500 self-center">Every report screen also exports CSV and prints.</span>
        </div>
      </Panel>

      <Panel
        title="Backup &amp; restore"
        actions={<Button size="sm" variant="secondary" onClick={() => backup.mutate()} disabled={backup.isPending}><Database size={13} className="mr-1" /> Back up now</Button>}
      >
        <div className="p-3">
          <label className="block mb-3">
            <span className="block text-12 font-medium text-neutral-700 mb-1">Name for a restored company</span>
            <input value={restoreName} onChange={(e) => setRestoreName(e.target.value)} placeholder="e.g. Kovai Tech Traders (restored)"
              className="h-9 w-full max-w-[420px] px-2 text-13 border border-neutral-300 rounded focus:outline-none focus:border-gold" />
            <span className="block text-11 text-neutral-500 mt-1">
              <ShieldCheck size={11} className="inline mr-1" />
              Restoring always creates a new company. The books you are looking at are never overwritten.
            </span>
          </label>
        </div>
        {backupsQ.isLoading ? <Loading /> : (
          <DataTable
            minWidth="620px" rows={backupsQ.data?.items ?? []} rowKey={(b) => b.id}
            columns={[
              { key: 'label', label: 'Backup', value: (b) => b.label },
              { key: 'vouchers', label: 'Vouchers', align: 'right', value: (b) => b.voucher_count },
              { key: 'ledgers', label: 'Ledgers', align: 'right', value: (b) => b.ledger_count },
              { key: 'size', label: 'Size', align: 'right', value: (b) => `${(b.size_bytes / 1024).toFixed(0)} KB` },
              { key: 'at', label: 'Created', value: (b) => new Date(b.created_at).toLocaleString('en-IN') },
              {
                key: 'actions', label: '', value: () => '',
                render: (b) => (
                  <span className="flex gap-2 justify-end">
                    <a href={tallyAccountingApi.backupDownloadUrl(companyId, b.id)} target="_blank" rel="noreferrer" className="text-12 text-gold hover:underline">Download</a>
                    <button type="button" disabled={!restoreName.trim() || restore.isPending} onClick={() => restore.mutate(b.id)}
                      className="text-12 text-gold hover:underline disabled:text-neutral-300 disabled:no-underline">Restore</button>
                  </span>
                ),
              },
            ]}
            empty="No backups yet."
          />
        )}
      </Panel>
    </div>
  );
}
