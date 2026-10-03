/**
 * Bookkeeping · Import — column-mapping wizard (BOOKKEEPING-REBUILD §3.1).
 *
 * Step 1 of the rebuild: upload a client's Excel, pick the sheet, map the
 * columns, save the mapping. Preview / commit / voucher derivation live
 * in later steps and this page hands them nothing yet — it only writes
 * a mapping row so the second-month import is one click.
 *
 * The screen intentionally mirrors the doc's wireframe (§3.1). Sheet
 * dropdown at the top, column-mapping table below with sample values
 * inline. No fancy affordances until we have a real import committing.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import {
  bookkeepingAccountingApi,
  IMPORT_TARGETS,
  MAPPABLE_FIELDS,
  MAPPABLE_FIELD_LABEL,
  type ClassifiedBatch,
  type CommitImportResult,
  type ImportTarget,
  type MappableField,
  type SheetPreview,
  type WorkbookPreview,
} from '@/modules/tools/audit-automation/bookkeeping';

const TARGET_LABEL: Record<ImportTarget, string> = {
  sales_register: 'Sales register',
  purchase_register: 'Purchase register',
  receipt_register: 'Receipt register',
  payment_register: 'Payment register',
};

export function BookkeepingImportPage() {
  const { companyId = '' } = useParams();
  const qc = useQueryClient();

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<WorkbookPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<ImportTarget>('sales_register');
  const [sheetName, setSheetName] = useState<string>('');
  const [columnMap, setColumnMap] = useState<Record<string, MappableField>>({});
  const [dateFormat, setDateFormat] = useState<string>('DD/MM/YYYY');
  const [saved, setSaved] = useState<string | null>(null);
  const [derived, setDerived] = useState<ClassifiedBatch | null>(null);
  const [commitResult, setCommitResult] = useState<CommitImportResult | null>(null);

  const mappingsQ = useQuery({
    queryKey: ['bk.import.mappings', companyId],
    queryFn: () => bookkeepingAccountingApi.listImportMappings(companyId),
    enabled: Boolean(companyId),
  });

  const previewMut = useMutation({
    mutationFn: (f: File) => bookkeepingAccountingApi.previewWorkbook(companyId, f),
    onSuccess: (data) => {
      setPreview(data);
      setError(null);
      const first = data.sheets[0];
      if (first) {
        setSheetName(first.name);
        setColumnMap({}); // clean slate; the operator maps per sheet
      }
    },
    onError: (e: Error) => setError(e.message),
  });

  const saveMut = useMutation({
    mutationFn: () =>
      bookkeepingAccountingApi.saveImportMapping(companyId, {
        sheet_name: sheetName,
        target,
        // Use the header row the backend detected. Files with an FY
        // marker (like "25-26") in A1 have the real header on row 2 —
        // hard-coding 1 here made the derive path start at row 2, so
        // the headers themselves got treated as data.
        header_row: activeSheet?.headerRowIndex ?? 1,
        column_map: columnMap,
        date_format: dateFormat,
        currency_aliases: {}, // populated by Step 2's alias flow
      }),
    onSuccess: (m) => {
      setSaved(`Saved ${TARGET_LABEL[m.target]} mapping (version ${m.version}).`);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['bk.import.mappings', companyId] });
    },
    onError: (e: Error) => {
      setSaved(null);
      setError(e.message);
    },
  });

  const deriveMut = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('Upload the file first.');
      return bookkeepingAccountingApi.deriveImportVouchers(companyId, target, file);
    },
    onSuccess: (b) => {
      setDerived(b);
      setCommitResult(null);
      setError(null);
    },
    onError: (e: Error) => {
      setDerived(null);
      setError(e.message);
    },
  });

  const commitMut = useMutation({
    mutationFn: () => {
      if (!derived) throw new Error('Preview the file before committing.');
      return bookkeepingAccountingApi.commitImportBatch(companyId, {
        target,
        file_name: derived._import.fileName,
        file_sha256: derived._import.fileSha256,
        mapping_id: derived._import.mappingId,
        mapping_version: derived._import.mappingVersion,
        // MVP: every proposal defaults to "create" and every CHANGED
        // row to "skip". Explicit operator overrides land with §3.5.
        party_decisions: [],
        changed_row_decisions: [],
        batch: derived,
      });
    },
    onSuccess: (r) => {
      setCommitResult(r);
      setError(null);
    },
    onError: (e: Error) => {
      setCommitResult(null);
      setError(e.message);
    },
  });

  const activeSheet: SheetPreview | undefined = useMemo(
    () => preview?.sheets.find((s) => s.name === sheetName),
    [preview, sheetName],
  );

  const mappedFieldCount = useMemo(
    () => Object.values(columnMap).filter((f) => f !== 'ignore').length,
    [columnMap],
  );

  function updateColumn(letter: string, field: MappableField) {
    setColumnMap((prev) => {
      const next = { ...prev };
      if (field === 'ignore') delete next[letter];
      else next[letter] = field;
      return next;
    });
  }

  return (
    <div className="max-w-[1000px] space-y-4">
      <div>
        <h2 className="text-16 font-semibold text-neutral-900">Excel import</h2>
        <p className="text-13 text-neutral-500 mt-1">
          Upload the client's flat register — Sales or Purchase — and tell the app which columns
          hold what. The mapping is saved per company + target, so next month you drop the file in
          and skip this screen.
        </p>
      </div>

      {/* Existing mappings, so the operator sees what is already remembered */}
      {mappingsQ.data && mappingsQ.data.items.length > 0 && (
        <div className="border border-neutral-200 rounded p-3 bg-white">
          <div className="text-11 uppercase tracking-[0.08em] text-neutral-500 mb-2">Saved mappings</div>
          <ul className="space-y-1">
            {mappingsQ.data.items.map((m) => (
              <li key={m.id} className="text-13 text-neutral-700 flex items-center gap-2">
                <span className="font-medium">{TARGET_LABEL[m.target]}</span>
                <span className="text-neutral-500">·</span>
                <span className="text-neutral-500">
                  Sheet <span className="font-mono">{m.sheetName}</span>
                </span>
                <span className="text-neutral-500">·</span>
                <span className="text-neutral-500">
                  {Object.keys(m.columnMapJson).length} columns mapped
                </span>
                <span className="text-neutral-400 ml-auto">v{m.version}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="border border-neutral-200 rounded p-3 bg-white">
        <label className="block text-13 font-medium text-neutral-900 mb-2">1. Upload the .xlsx file</label>
        <input
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            setPreview(null);
            setColumnMap({});
            setSaved(null);
            setError(null);
          }}
          className="block text-13"
        />
        {file && (
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={previewMut.isPending}
              onClick={() => previewMut.mutate(file)}
              className="text-13 px-3 py-1 border border-neutral-300 rounded bg-white hover:bg-neutral-50 disabled:opacity-50"
            >
              {previewMut.isPending ? 'Reading…' : 'Read sheets'}
            </button>
            <span className="text-12 text-neutral-500">{file.name}</span>
          </div>
        )}
      </div>

      {preview && (
        <div className="border border-neutral-200 rounded p-3 bg-white space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-13 font-medium text-neutral-900">2. Pick the sheet:</label>
            <select
              value={sheetName}
              onChange={(e) => {
                setSheetName(e.target.value);
                setColumnMap({});
              }}
              className="text-13 border border-neutral-300 rounded px-2 py-1"
            >
              {preview.sheets.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name} — {s.rowCount} rows
                </option>
              ))}
            </select>
            <label className="text-13 font-medium text-neutral-900 ml-4">Target:</label>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value as ImportTarget)}
              className="text-13 border border-neutral-300 rounded px-2 py-1"
            >
              {IMPORT_TARGETS.map((t) => (
                <option key={t} value={t}>{TARGET_LABEL[t]}</option>
              ))}
            </select>
          </div>

          {activeSheet && (
            <>
              <div>
                <div className="text-13 font-medium text-neutral-900 mb-1">
                  3. Map the columns
                  <span className="ml-2 text-11 font-normal text-neutral-500">
                    · {activeSheet.columns.length} column{activeSheet.columns.length === 1 ? '' : 's'} · header on row {activeSheet.headerRowIndex}
                  </span>
                </div>
                <div className="text-12 text-neutral-500">
                  Every column needs a target field, or leave it as <span className="italic">Ignore</span>.
                  Exactly one column must be mapped to Date. Amount (INR) or Total is required.
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="text-13 min-w-full border-collapse">
                  <thead>
                    <tr className="border-b border-neutral-200">
                      <th className="text-left font-medium text-neutral-500 py-1.5 pr-3">Col</th>
                      <th className="text-left font-medium text-neutral-500 py-1.5 pr-3">Header</th>
                      <th className="text-left font-medium text-neutral-500 py-1.5 pr-3">Sample</th>
                      <th className="text-left font-medium text-neutral-500 py-1.5">Map to</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeSheet.columns.map((col, idx) => {
                      const header = activeSheet.headerRow[idx] ?? '';
                      const sample = activeSheet.sampleRows[0]?.[idx] ?? '';
                      const val = columnMap[col] ?? 'ignore';
                      return (
                        <tr key={col} className="border-b border-neutral-100">
                          <td className="py-1 pr-3 font-mono text-neutral-700">{col}</td>
                          <td className="py-1 pr-3 text-neutral-700 max-w-[200px] truncate" title={header}>{header || '—'}</td>
                          <td className="py-1 pr-3 text-neutral-500 max-w-[200px] truncate font-mono" title={sample}>
                            {sample || '—'}
                          </td>
                          <td className="py-1">
                            <select
                              value={val}
                              onChange={(e) => updateColumn(col, e.target.value as MappableField)}
                              className="text-12 border border-neutral-300 rounded px-1.5 py-0.5"
                            >
                              {MAPPABLE_FIELDS.map((f) => (
                                <option key={f} value={f}>{MAPPABLE_FIELD_LABEL[f]}</option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                <label className="text-13">
                  <span className="font-medium text-neutral-900 mr-2">Date format:</span>
                  <input
                    value={dateFormat}
                    onChange={(e) => setDateFormat(e.target.value)}
                    className="text-13 border border-neutral-300 rounded px-2 py-0.5 font-mono w-[120px]"
                  />
                </label>
                <span className="text-12 text-neutral-500">{mappedFieldCount} columns mapped</span>
              </div>

              <div className="flex items-center gap-2 pt-2 border-t border-neutral-100">
                <button
                  type="button"
                  disabled={saveMut.isPending || mappedFieldCount === 0}
                  onClick={() => saveMut.mutate()}
                  className="text-13 px-3 py-1 border border-neutral-900 bg-neutral-900 text-white rounded disabled:opacity-50"
                >
                  {saveMut.isPending ? 'Saving…' : 'Save mapping'}
                </button>
                <button
                  type="button"
                  disabled={deriveMut.isPending || !file}
                  onClick={() => deriveMut.mutate()}
                  className="text-13 px-3 py-1 border border-neutral-300 rounded bg-white hover:bg-neutral-50 disabled:opacity-50"
                  title="Runs the saved mapping over this file and shows what would post — nothing is written yet."
                >
                  {deriveMut.isPending ? 'Deriving…' : 'Preview vouchers'}
                </button>
                {saved && <span className="text-12 text-green-700">{saved}</span>}
              </div>
            </>
          )}
        </div>
      )}

      {derived && (
        <DerivedBatchPanel
          batch={derived}
          commitPending={commitMut.isPending}
          commitResult={commitResult}
          onCommit={() => commitMut.mutate()}
        />
      )}

      {error && (
        <div className="border-l-2 border-red-500 bg-red-50 p-3 text-13 text-red-800">
          {error}
        </div>
      )}
    </div>
  );
}

function inr(paise: number): string {
  return (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function DerivedBatchPanel({
  batch,
  commitPending,
  commitResult,
  onCommit,
}: {
  batch: ClassifiedBatch;
  commitPending: boolean;
  commitResult: CommitImportResult | null;
  onCommit: () => void;
}) {
  const { totals, vouchers, proposals, flags, counts, classification } = batch;
  const allBalanced = vouchers.every((v) => v.balanced);
  const alreadyCommitted = commitResult !== null;
  return (
    <div className="border border-neutral-200 rounded p-3 bg-white space-y-3">
      <div className="text-11 uppercase tracking-[0.08em] text-neutral-500">
        {alreadyCommitted ? 'Import committed' : 'Derived preview — nothing posted yet'}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-13">
        <Stat label="Rows scanned" value={String(totals.rowsScanned)} />
        <Stat label="Vouchers derived" value={String(totals.rowsDerived)} />
        <Stat label="Total (INR)" value={`₹ ${inr(totals.totalPaise)}`} />
        <Stat label="Currencies" value={totals.currencies.join(', ') || '—'} />
      </div>

      {/* Idempotency counts — the four numbers that matter (§3.4).
          `skipped` rows whose only blocker is an unresolved party are
          counted as "Will auto-create" instead of warn: the backend
          creates the proposed ledgers and re-classifies them on commit. */}
      {(() => {
        const willAutoResolve = Math.min(counts.skipped, proposals.length);
        const trulyBlocked = Math.max(0, counts.skipped - proposals.length);
        return (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-13 border-t border-neutral-100 pt-3">
            <Stat label="New" value={String(counts.new)} tone="new" />
            <Stat label="Unchanged (skip)" value={String(counts.unchanged)} tone="muted" />
            <Stat label="Changed (skip)" value={String(counts.changed)} tone={counts.changed > 0 ? 'warn' : 'muted'} />
            <Stat
              label={trulyBlocked > 0 ? 'Unresolved party' : willAutoResolve > 0 ? 'Will auto-create' : 'Unresolved party'}
              value={String(counts.skipped)}
              tone={trulyBlocked > 0 ? 'warn' : willAutoResolve > 0 ? 'new' : 'muted'}
            />
          </div>
        );
      })()}

      <div className="text-12 text-neutral-500 flex gap-3">
        <span className={allBalanced ? 'text-green-700' : 'text-red-700'}>
          {allBalanced ? '✓ every voucher balances' : '⚠ one or more vouchers do not balance'}
        </span>
        <span>·</span>
        <span>{proposals.length} new party proposals</span>
        <span>·</span>
        <span className={flags.length ? 'text-amber-700' : 'text-neutral-500'}>{flags.length} row flags</span>
      </div>

      {/* Commit button + result. Nothing else on the page can post.
          `postable` includes `skipped` rows whose only blocker is an
          unresolved party (= one of the proposals) — the backend creates
          those ledgers and reclassifies them to `new` before posting. */}
      {(() => {
        const willAutoResolve = Math.min(counts.skipped, proposals.length);
        const postable = counts.new + willAutoResolve;
        const label =
          commitPending ? 'Committing…' :
          alreadyCommitted ? 'Committed' :
          `Commit ${postable} voucher${postable === 1 ? '' : 's'}`;
        const title =
          postable === 0
            ? 'No vouchers to commit.'
            : willAutoResolve > 0
              ? `Create ${proposals.length} party ledger${proposals.length === 1 ? '' : 's'} and post ${postable} voucher${postable === 1 ? '' : 's'}.`
              : `Post ${postable} new voucher${postable === 1 ? '' : 's'} to the ledger.`;
        return (
      <div className="flex items-center gap-3 flex-wrap pt-2 border-t border-neutral-100">
        <button
          type="button"
          disabled={commitPending || postable === 0 || alreadyCommitted}
          onClick={onCommit}
          className="text-13 px-3 py-1 border border-neutral-900 bg-neutral-900 text-white rounded disabled:opacity-40"
          title={title}
        >
          {label}
        </button>
        {!alreadyCommitted && willAutoResolve > 0 && (
          <span className="text-12 text-neutral-500">
            also creates {proposals.length} party ledger{proposals.length === 1 ? '' : 's'} under Sundry Debtors / Creditors
          </span>
        )}
        {commitResult && (
          <span className="text-13 text-green-700">
            ✓ {commitResult.vouchersCreated} posted · {commitResult.ledgersCreated} party ledger{commitResult.ledgersCreated === 1 ? '' : 's'} created · {commitResult.vouchersSkipped} skipped
          </span>
        )}
      </div>
        );
      })()}
      {commitResult && commitResult.errors.length > 0 && (
        <details open className="border-l-2 border-red-500 bg-red-50 p-2">
          <summary className="cursor-pointer text-12 text-red-800 font-medium">
            {commitResult.errors.length} row{commitResult.errors.length === 1 ? '' : 's'} could not be posted
          </summary>
          <ul className="mt-1 space-y-0.5">
            {commitResult.errors.map((e, i) => (
              <li key={i} className="text-12 text-red-800">
                <span className="font-mono">R{e.rowNumber}</span> — {e.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      {proposals.length > 0 && (
        <details open className="border-t border-neutral-100 pt-2">
          <summary className="cursor-pointer text-13 font-medium text-neutral-900">
            New party ledgers ({proposals.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {proposals.map((p) => (
              <li key={p.normalizedName} className="text-13 text-neutral-700">
                <span className="font-medium">{p.name}</span>
                <span className="text-neutral-500"> · {p.group === 'sundry_debtors' ? 'Sundry Debtors' : 'Sundry Creditors'}</span>
                <span className="text-neutral-500"> · {p.occurrenceCount} row{p.occurrenceCount === 1 ? '' : 's'}</span>
                {p.fuzzyMatches.length > 0 && (
                  <span className="ml-2 text-amber-700 text-12">
                    ⚠ similar to {p.fuzzyMatches.map((m) => `"${m.name}"`).join(', ')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {flags.length > 0 && (
        <details className="border-t border-neutral-100 pt-2">
          <summary className="cursor-pointer text-13 font-medium text-amber-800">
            Row flags ({flags.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {flags.map((f, i) => (
              <li key={i} className="text-12 text-amber-800">
                <span className="font-mono">R{f.rowNumber}</span> · <span className="font-medium">{f.kind}</span> — {f.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      <details className="border-t border-neutral-100 pt-2">
        <summary className="cursor-pointer text-13 font-medium text-neutral-900">
          Derived vouchers ({vouchers.length})
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="text-13 min-w-full border-collapse">
            <thead>
              <tr className="border-b border-neutral-200">
                <th className="text-left font-medium text-neutral-500 py-1.5 pr-3">Row</th>
                <th className="text-left font-medium text-neutral-500 py-1.5 pr-3">Status</th>
                <th className="text-left font-medium text-neutral-500 py-1.5 pr-3">Date</th>
                <th className="text-left font-medium text-neutral-500 py-1.5 pr-3">Inv/Bill</th>
                <th className="text-left font-medium text-neutral-500 py-1.5 pr-3">Party</th>
                <th className="text-left font-medium text-neutral-500 py-1.5 pr-3">Cur</th>
                <th className="text-right font-medium text-neutral-500 py-1.5 pr-3">Total (INR)</th>
                <th className="text-left font-medium text-neutral-500 py-1.5">Bal</th>
              </tr>
            </thead>
            <tbody>
              {vouchers.map((v) => {
                const cls = classification[v.rowNumber];
                const status = cls?.existence ?? 'new';
                const statusTone =
                  status === 'new' ? 'text-green-700' :
                  status === 'changed' ? 'text-amber-700' :
                  'text-neutral-500';
                return (
                  <tr key={v.rowNumber} className="border-b border-neutral-100">
                    <td className="py-1 pr-3 font-mono text-neutral-500">{v.rowNumber}</td>
                    <td className={`py-1 pr-3 text-12 uppercase tracking-wide ${statusTone}`}>
                      {status}
                      {status === 'changed' && cls?.changedFields && (
                        <span className="ml-1 text-11 text-neutral-500 normal-case">
                          ({cls.changedFields.join(', ')})
                        </span>
                      )}
                    </td>
                    <td className="py-1 pr-3 text-neutral-700">{v.date}</td>
                    <td className="py-1 pr-3 text-neutral-700">{v.invoiceOrBillNo ?? '—'}</td>
                    <td className="py-1 pr-3 text-neutral-700">
                      {v.partyName}
                      {v.partyLedgerId === null && (
                        <span className="ml-1 text-11 text-amber-700">new</span>
                      )}
                    </td>
                    <td className="py-1 pr-3 text-neutral-500">{v.currency}</td>
                    <td className="py-1 pr-3 text-right font-mono">{inr(v.totalPaise)}</td>
                    <td className="py-1">
                      {v.balanced ? <span className="text-green-700">✓</span> : <span className="text-red-700">✗</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'new' | 'warn' | 'muted' }) {
  const valueClass =
    tone === 'new' ? 'text-green-700' :
    tone === 'warn' ? 'text-amber-700' :
    tone === 'muted' ? 'text-neutral-500' :
    'text-neutral-900';
  return (
    <div>
      <div className="text-11 uppercase tracking-[0.08em] text-neutral-400">{label}</div>
      <div className={`text-15 font-medium tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}
