import type { ToolUI, OptionsProps } from './types';
import { SelectField, TextField, Notice } from '../workspace/fields';

/**
 * COMPLIANCE CONVERTERS — the Finance & Compliance group.
 *
 * These six read files the firm already has and emit what a portal or Tally
 * will accept. Two shared UI decisions:
 *
 *  - Tools that read a sheet state the columns they need BEFORE the upload,
 *    because the failure mode is a missing column and the fix is editing the
 *    sheet — telling someone after the run wastes a round trip.
 *  - Every result note reports what was skipped, not just what succeeded.
 *    A converted count on its own reads as "all of it" and these files go
 *    to a government portal.
 */

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
const money = (v: unknown) =>
  n(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "3 rows were skipped" / null when none. */
function skippedLine(v: unknown): string | null {
  const c = n(v);
  if (!c) return null;
  return `${c} ${c === 1 ? 'row was' : 'rows were'} skipped — see the Skipped sheet.`;
}

function Columns({ required, optional }: { required: string[]; optional?: string[] }) {
  return (
    <Notice tone="info">
      <div className="text-13">
        <strong className="font-medium">Required columns:</strong> {required.join(', ')}.
        {optional?.length ? <> <strong className="font-medium">Optional:</strong> {optional.join(', ')}.</> : null}
        <div className="text-12 text-neutral-500 mt-1">
          Header names are matched loosely — case, spaces and punctuation are ignored.
        </div>
      </div>
    </Notice>
  );
}

// ── 1. GST JSON ⇄ Excel ──────────────────────────────────────────────────

export const gstJsonExcelUI: ToolUI = {
  actionLabel: 'Convert',
  processingLabel: 'Reading GSTR sections…',
  Options: () => (
    <Notice tone="info">
      <div className="text-13">
        The direction follows the file you upload: a <strong className="font-medium">.json</strong> from
        the offline utility becomes a workbook with one sheet per section, and a workbook in that same
        shape becomes JSON again.
        <div className="text-12 text-neutral-500 mt-1">
          Sections handled: B2B, B2CL, B2CS, CDNR, CDNUR, EXP. Each invoice repeats down its line-item rows.
        </div>
      </div>
    </Notice>
  ),
  ResultNote: ({ output }) => {
    const secs = (output.meta.sections as string[] | undefined) ?? [];
    return (
      <div className="text-13 text-neutral-500">
        {output.meta.direction === 'excel_to_json' ? 'Rebuilt' : 'Read'} {n(output.meta.invoices)} invoices
        across {n(output.meta.rows)} line rows{secs.length ? ` · ${secs.join(', ')}` : ''}.
      </div>
    );
  },
};

// ── 2. Bank Statement to Excel ───────────────────────────────────────────

export const bankStatementToExcelUI: ToolUI = {
  actionLabel: 'Convert to Excel',
  processingLabel: 'Reading transactions…',
  Options: () => (
    <Notice tone="info">
      <div className="text-13">
        Any bank's PDF statement, read by structure rather than by layout: a transaction is a line that
        starts with a date and ends with its amounts.
        <div className="text-12 text-neutral-500 mt-1">
          A scanned statement has no text to read — run OCR Scan on it first. The Summary sheet checks
          that opening + credits − debits ties to the closing balance.
        </div>
      </div>
    </Notice>
  ),
  ResultNote: ({ output }) => {
    const skipped = skippedLine(output.meta.skipped);
    return (
      <div className="text-13 text-neutral-500">
        {n(output.meta.transactions)} transactions from {n(output.meta.page_count)} pages ·
        debit ₹{money(output.meta.total_debit)} · credit ₹{money(output.meta.total_credit)}
        {output.meta.closing !== null && output.meta.closing !== undefined
          ? ` · closing ₹${money(output.meta.closing)}` : ''}
        .{' '}
        {output.meta.balanced
          ? 'The balances tie.'
          : 'The balances do not tie — check the Summary sheet.'}
        {skipped ? ` ${skipped}` : ''}
      </div>
    );
  },
};

// ── 3. Form 26AS to Excel ────────────────────────────────────────────────

export const form26asToExcelUI: ToolUI = {
  actionLabel: 'Convert to Excel',
  processingLabel: 'Reading Part A…',
  Options: () => (
    <Notice tone="info">
      <div className="text-13">
        Takes the PDF or the caret-delimited text export from TRACES and lifts Part A — TDS by deductor —
        into a transaction sheet plus per-deductor totals.
        <div className="text-12 text-neutral-500 mt-1">
          The text export parses more reliably than the PDF; prefer it when TRACES offers both.
        </div>
      </div>
    </Notice>
  ),
  ResultNote: ({ output }) => {
    const skipped = skippedLine(output.meta.skipped);
    return (
      <div className="text-13 text-neutral-500">
        {n(output.meta.rows)} entries from {n(output.meta.deductors)} deductors ·
        credited ₹{money(output.meta.total_credited)} · TDS ₹{money(output.meta.total_tds)}.
        {skipped ? ` ${skipped}` : ''}
      </div>
    );
  },
};

// ── 4. Excel to Tally XML ────────────────────────────────────────────────

function TallyOptions({ value, onChange, disabled }: OptionsProps) {
  return (
    <div className={disabled ? 'opacity-60 pointer-events-none' : ''}>
      <TextField
        label="Tally company name"
        value={String(value.company_name ?? '')}
        onChange={(v) => onChange({ company_name: v })}
        placeholder="Leave blank to import into the open company"
        hint="Written into SVCURRENTCOMPANY. Blank imports into whichever company is open in Tally."
      />
      <div className="mt-3">
        <Columns
          required={['Date', 'Amount', 'Party Ledger']}
          optional={['Voucher Type', 'Voucher No', 'Ledger Name', 'Narration', 'Dr/Cr']}
        />
      </div>
      <div className="mt-3">
        <Notice tone="warn">
          <div className="text-13">
            Each row becomes a two-sided voucher: the party ledger and one nominal account.
            <div className="text-12 text-neutral-500 mt-1">
              Without a <strong className="font-medium">Dr/Cr</strong> column the party is debited on a
              sale or receipt and credited on a purchase or payment. Ledgers must already exist in Tally —
              this file posts vouchers, it does not create masters.
            </div>
          </div>
        </Notice>
      </div>
    </div>
  );
}

export const excelToTallyXmlUI: ToolUI = {
  actionLabel: 'Generate Tally XML',
  processingLabel: 'Building vouchers…',
  defaults: { company_name: '' },
  Options: TallyOptions,
  ResultNote: ({ output }) => {
    const types = (output.meta.voucher_types as string[] | undefined) ?? [];
    const skipped = n(output.meta.skipped);
    return (
      <div className="text-13 text-neutral-500">
        {n(output.meta.vouchers)} vouchers · ₹{money(output.meta.total_amount)}
        {types.length ? ` · ${types.join(', ')}` : ''}.
        {skipped ? ` ${skipped} ${skipped === 1 ? 'row was' : 'rows were'} skipped.` : ''}
        {' '}Import in Tally via Gateway → Import Data → Vouchers.
      </div>
    );
  },
};

// ── 5. TDS Text / FVU Generator ──────────────────────────────────────────

function TdsOptions({ value, onChange, disabled }: OptionsProps) {
  return (
    <div className={disabled ? 'opacity-60 pointer-events-none' : ''}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <SelectField
          label="Form" value={String(value.form_type ?? '26Q')}
          onChange={(v) => onChange({ form_type: v })}
          options={[
            { value: '24Q', label: '24Q — salary' },
            { value: '26Q', label: '26Q — other than salary' },
            { value: '27Q', label: '27Q — non-resident' },
            { value: '27EQ', label: '27EQ — TCS' },
          ]}
        />
        <SelectField
          label="Quarter" value={String(value.quarter ?? 'Q1')}
          onChange={(v) => onChange({ quarter: v })}
          options={[
            { value: 'Q1', label: 'Q1 — Apr to Jun' },
            { value: 'Q2', label: 'Q2 — Jul to Sep' },
            { value: 'Q3', label: 'Q3 — Oct to Dec' },
            { value: 'Q4', label: 'Q4 — Jan to Mar' },
          ]}
        />
        <TextField
          label="Financial year" value={String(value.financial_year ?? '')}
          onChange={(v) => onChange({ financial_year: v })} placeholder="2026-27"
        />
        <TextField
          label="Deductor TAN" value={String(value.tan ?? '')}
          onChange={(v) => onChange({ tan: v.toUpperCase() })} placeholder="CHEA12345B"
        />
      </div>
      <TextField
        label="Deductor name" value={String(value.deductor_name ?? '')}
        onChange={(v) => onChange({ deductor_name: v })} placeholder="As registered with TRACES"
        className="mt-3"
      />
      <div className="mt-3">
        <Columns
          required={['PAN', 'Name', 'Amount Paid', 'TDS']}
          optional={['Section', 'Date of Payment', 'Date of Deduction', 'Rate', 'BSR Code', 'Challan No', 'Challan Date']}
        />
      </div>
      <div className="mt-3">
        <Notice tone="warn">
          <div className="text-13">
            This produces the <strong className="font-medium">input text file</strong>, not a validated .fvu.
            <div className="text-12 text-neutral-500 mt-1">
              Only NSDL's File Validation Utility can produce a .fvu. Run this file through the FVU to
              validate it and get the file you upload. Rows are grouped into challans by BSR code,
              challan number and challan date.
            </div>
          </div>
        </Notice>
      </div>
    </div>
  );
}

export const tdsFvuGeneratorUI: ToolUI = {
  actionLabel: 'Generate return file',
  processingLabel: 'Building records…',
  defaults: { form_type: '26Q', quarter: 'Q1', financial_year: '', tan: '', deductor_name: '' },
  Options: TdsOptions,
  validate: (v) => {
    const tan = String(v.tan ?? '').trim();
    if (tan && !/^[A-Z]{4}\d{5}[A-Z]$/.test(tan)) return 'A TAN is four letters, five digits, then a letter — for example CHEA12345B.';
    const fy = String(v.financial_year ?? '').trim();
    if (fy && !/^\d{4}-\d{2,4}$/.test(fy)) return 'Write the financial year as 2026-27.';
    return null;
  },
  ResultNote: ({ output }) => {
    const skipped = n(output.meta.skipped);
    return (
      <div className="text-13 text-neutral-500">
        {n(output.meta.deductees)} deductees across {n(output.meta.challans)} challans ·
        TDS ₹{money(output.meta.total_tds)} · {String(output.meta.form_type ?? '')} {String(output.meta.quarter ?? '')}.
        {skipped ? ` ${skipped} ${skipped === 1 ? 'row was' : 'rows were'} skipped.` : ''}
        {' '}Validate it with NSDL's FVU before uploading.
      </div>
    );
  },
};

// ── 6. Invoice to e-Invoice JSON ─────────────────────────────────────────

export const invoiceToEInvoiceJsonUI: ToolUI = {
  actionLabel: 'Generate e-Invoice JSON',
  processingLabel: 'Building invoices…',
  Options: () => (
    <div>
      <Columns
        required={['Invoice No', 'Invoice Date', 'Seller GSTIN', 'Buyer GSTIN', 'Taxable Value']}
        optional={['Seller Name', 'Seller Address', 'Buyer Name', 'Buyer Address', 'Place of Supply', 'Item Description', 'HSN', 'Quantity', 'Unit', 'Unit Price', 'GST Rate', 'IGST', 'CGST', 'SGST', 'Cess']}
      />
      <div className="mt-3">
        <Notice tone="info">
          <div className="text-13">
            One row is one line item; rows sharing an invoice number become a single invoice with an ItemList.
            <div className="text-12 text-neutral-500 mt-1">
              Schema 1.1. Invoice totals are summed from the line items rather than read from the sheet,
              so they always tie to the lines the IRP sees — a mismatch there is the most common rejection.
            </div>
          </div>
        </Notice>
      </div>
    </div>
  ),
  ResultNote: ({ output }) => {
    const skipped = n(output.meta.skipped);
    return (
      <div className="text-13 text-neutral-500">
        {n(output.meta.invoices)} invoices from {n(output.meta.items)} line items ·
        ₹{money(output.meta.total_value)}.
        {skipped ? ` ${skipped} ${skipped === 1 ? 'row was' : 'rows were'} skipped.` : ''}
      </div>
    );
  },
};
