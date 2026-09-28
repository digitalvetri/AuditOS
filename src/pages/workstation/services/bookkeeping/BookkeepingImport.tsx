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
        header_row: 1,
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
                <div className="text-13 font-medium text-neutral-900 mb-1">3. Map the columns</div>
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
                {saved && <span className="text-12 text-green-700">{saved}</span>}
              </div>
            </>
          )}
        </div>
      )}

      {error && (
        <div className="border-l-2 border-red-500 bg-red-50 p-3 text-13 text-red-800">
          {error}
        </div>
      )}
    </div>
  );
}
