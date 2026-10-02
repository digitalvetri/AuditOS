import { Checkbox, Notice, SelectField } from '../workspace/fields';
import type { OptionsProps, ToolUI } from './types';

/* ── PDF to Excel ──────────────────────────────────────────────────────── */
export const pdfToExcelUI: ToolUI = {
  actionLabel: 'Convert to Excel',
  processingLabel: 'Extracting tables…',
  fileNote: (f) => (typeof f.doc?.meta.page_count === 'number' ? `${f.doc.meta.page_count} page${f.doc.meta.page_count === 1 ? '' : 's'}` : null),
  validate: (_v, files) => (files[0]?.doc?.meta.encrypted === true ? 'This PDF is password-protected. Use Unlock PDF first.' : null),
  Options: ({ files }) => (files[0]?.doc?.meta.encrypted === true ? <Notice tone="warn">This PDF is password-protected. Unlock it first, then extract its tables.</Notice> : null),
  ResultNote: ({ output }) => {
    const tables = output.meta.tables as number | undefined;
    const without = (output.meta.pages_without_tables as number[] | undefined) ?? [];
    return (
      <div className="text-13 text-neutral-500">
        {tables ?? 0} table{tables === 1 ? '' : 's'} extracted, one sheet each. A Summary sheet lists every page
        {without.length ? ` — including ${without.length} with no table` : ''}.
      </div>
    );
  },
};

/* ── Excel to PDF ──────────────────────────────────────────────────────── */
function ExcelToPdfOptions({ value, onChange, disabled }: OptionsProps) {
  return (
    <Checkbox checked={value.fit_to_width !== false} onChange={(v) => onChange({ fit_to_width: v })} className={disabled ? 'opacity-60' : ''}>
      Fit each sheet to the page width
      <span className="block text-12 text-neutral-500">Wide sheets shrink to one page across instead of spilling columns onto extra pages. Sheet order, widths and formats are kept.</span>
    </Checkbox>
  );
}
export const excelToPdfUI: ToolUI = {
  actionLabel: 'Convert to PDF',
  processingLabel: 'Rendering spreadsheet…',
  defaults: { fit_to_width: true },
  Options: ExcelToPdfOptions,
  ResultNote: ({ output }) => (typeof output.meta.page_count === 'number' ? <div className="text-13 text-neutral-500">{output.meta.page_count} page{output.meta.page_count === 1 ? '' : 's'}.</div> : null),
};

/* ── PDF to Word ───────────────────────────────────────────────────────── */
export const pdfToWordUI: ToolUI = {
  actionLabel: 'Convert to Word',
  processingLabel: 'Rebuilding paragraphs…',
  fileNote: pdfToExcelUI.fileNote,
  validate: pdfToExcelUI.validate,
  Options: ({ files }) => (
    files[0]?.doc?.meta.encrypted === true
      ? <Notice tone="warn">This PDF is password-protected. Unlock it first.</Notice>
      : <Notice>Works on PDFs with a text layer. A scanned PDF will be refused with a pointer to OCR Scan.</Notice>
  ),
  ResultNote: ({ output }) => (
    <div className="text-13 text-neutral-500">
      {String(output.meta.paragraphs ?? 0)} paragraphs and {String(output.meta.tables ?? 0)} table{output.meta.tables === 1 ? '' : 's'} across {String(output.meta.page_count ?? 0)} page{output.meta.page_count === 1 ? '' : 's'}.
    </div>
  ),
};

/* ── Word to PDF ───────────────────────────────────────────────────────── */
export const wordToPdfUI: ToolUI = {
  actionLabel: 'Convert to PDF',
  processingLabel: 'Rendering document…',
  ResultNote: excelToPdfUI.ResultNote,
};

/* ── Image to PDF ──────────────────────────────────────────────────────── */
function ImageToPdfOptions({ value, onChange, disabled }: OptionsProps) {
  return (
    <div className={'grid grid-cols-1 sm:grid-cols-3 gap-3 ' + (disabled ? 'opacity-60 pointer-events-none' : '')}>
      <SelectField label="Page size" value={String(value.page_size ?? 'A4')} onChange={(v) => onChange({ page_size: v })}
        options={[{ value: 'A4', label: 'A4' }, { value: 'Letter', label: 'Letter' }, { value: 'Fit', label: 'Fit to image' }]} />
      <SelectField label="Orientation" value={String(value.orientation ?? 'auto')} onChange={(v) => onChange({ orientation: v })}
        options={[{ value: 'auto', label: 'Auto (per image)' }, { value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }]} />
      <SelectField label="Margin" value={String(value.margin_mm ?? 10)} onChange={(v) => onChange({ margin_mm: Number(v) })}
        options={[{ value: '0', label: 'None' }, { value: '5', label: '5 mm' }, { value: '10', label: '10 mm' }, { value: '20', label: '20 mm' }]} />
    </div>
  );
}
export const imageToPdfUI: ToolUI = {
  actionLabel: 'Create PDF',
  processingLabel: 'Placing images…',
  defaults: { page_size: 'A4', orientation: 'auto', margin_mm: 10 },
  reorderable: true,
  minFiles: 1,
  Options: ImageToPdfOptions,
  fileNote: (f) => (typeof f.doc?.meta.width === 'number' ? `${f.doc.meta.width} × ${f.doc.meta.height} px` : null),
  ResultNote: excelToPdfUI.ResultNote,
};

/* ── CSV to Excel ──────────────────────────────────────────────────────── */
function CsvToExcelOptions({ files, value, onChange, disabled }: OptionsProps) {
  const meta = files[0]?.doc?.meta ?? {};
  const names = (meta.column_names as string[] | undefined) ?? [];
  const types = (meta.column_types as string[] | undefined) ?? [];
  const sample = (meta.sample as string[][] | undefined) ?? [];
  const keep = value.keep_as_text === 'all' ? 'all' : ((value.keep_as_text as number[] | undefined) ?? []);
  const detectedHeader = meta.has_header === true ? 'yes' : meta.has_header === false ? 'no' : '';
  const toggleColumn = (i: number, on: boolean) => {
    if (keep === 'all') return;
    const next = on ? [...new Set([...keep, i])] : keep.filter((k) => k !== i);
    onChange({ keep_as_text: next });
  };
  return (
    <div className={disabled ? 'opacity-60 pointer-events-none' : ''}>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <SelectField label="Delimiter" value={String(value.delimiter ?? 'auto')} onChange={(v) => onChange({ delimiter: v })}
          hint={meta.delimiter ? `Detected: ${meta.delimiter === 'tab' ? 'tab' : `"${meta.delimiter}"`}` : undefined}
          options={[{ value: 'auto', label: 'Auto-detect' }, { value: ',', label: 'Comma ( , )' }, { value: ';', label: 'Semicolon ( ; )' }, { value: 'tab', label: 'Tab' }, { value: '|', label: 'Pipe ( | )' }]} />
        <SelectField label="Encoding" value={String(value.encoding ?? 'auto')} onChange={(v) => onChange({ encoding: v })}
          hint={meta.encoding ? `Detected: ${String(meta.encoding)}` : undefined}
          options={[{ value: 'auto', label: 'Auto-detect' }, { value: 'utf-8', label: 'UTF-8' }, { value: 'windows-1252', label: 'Windows-1252 (Excel export)' }, { value: 'utf-16le', label: 'UTF-16' }]} />
        <SelectField label="First row is a header" value={String(value.has_header ?? 'auto')} onChange={(v) => onChange({ has_header: v === 'auto' ? 'auto' : v === 'true' })}
          hint={detectedHeader ? `Detected: ${detectedHeader}` : undefined}
          options={[{ value: 'auto', label: 'Auto-detect' }, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} />
      </div>

      {names.length ? (
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">Columns · {names.length}</span>
            <Checkbox checked={keep === 'all'} onChange={(v) => onChange({ keep_as_text: v ? 'all' : [] })}>Keep every column as text</Checkbox>
          </div>
          <ul className="mt-2 border border-neutral-200 rounded divide-y divide-neutral-200 max-h-[240px] overflow-y-auto">
            {names.map((n, i) => {
              const t = types[i] ?? 'text';
              const forced = keep === 'all' || keep.includes(i);
              return (
                <li key={i} className="flex items-center gap-3 h-9 px-3 text-13">
                  <span className="flex-1 truncate text-neutral-900">{n}</span>
                  <span className={'w-14 text-12 ' + (t === 'number' ? 'text-neutral-700' : 'text-neutral-500')}>{forced ? 'text' : t}</span>
                  <label className="flex items-center gap-1 text-12 text-neutral-500 cursor-pointer">
                    <input type="checkbox" checked={forced} disabled={keep === 'all'} onChange={(e) => toggleColumn(i, e.target.checked)} className="accent-[#C8952E]" />
                    as text
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="text-12 text-neutral-500 mt-2">
            Leading zeros (GSTIN, invoice numbers, TAN, PIN codes) and dates are always kept as text. Only clean numbers become numeric cells.
          </p>
        </div>
      ) : null}

      {sample.length ? (
        <div className="mt-4">
          <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">Preview · first {sample.length} rows</span>
          <div className="mt-2 overflow-x-auto border border-neutral-200 rounded">
            <table className="min-w-full border-collapse text-12">
              <tbody>
                {sample.map((r, ri) => (
                  <tr key={ri} className={'border-b border-neutral-200 last:border-0 ' + (ri === 0 && meta.has_header ? 'bg-neutral-50 font-medium' : '')}>
                    {r.map((c, ci) => <td key={ci} className="px-2 h-8 whitespace-nowrap text-neutral-900 max-w-[220px] truncate">{c}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
export const csvToExcelUI: ToolUI = {
  actionLabel: 'Convert to Excel',
  processingLabel: 'Typing columns…',
  defaults: { delimiter: 'auto', encoding: 'auto', has_header: 'auto', keep_as_text: [] },
  Options: CsvToExcelOptions,
  fileNote: (f) => (typeof f.doc?.meta.rows === 'number' ? `${f.doc.meta.rows} rows · ${String(f.doc.meta.columns)} columns` : null),
  ResultNote: ({ output }) => (
    <div className="text-13 text-neutral-500">
      {String(output.meta.rows ?? 0)} rows × {String(output.meta.columns ?? 0)} columns · {String(output.meta.encoding ?? '')}, {output.meta.delimiter === 'tab' ? 'tab' : `"${String(output.meta.delimiter ?? ',')}"`}-separated
      {output.meta.has_header ? ', header row kept' : ''}.
    </div>
  ),
};
