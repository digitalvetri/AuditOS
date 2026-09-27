import type { ToolUI, OptionsProps } from './types';
import { useEffect } from 'react';
import { SelectField, TextField, Notice, Checkbox } from '../workspace/fields';

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

// ── 5. TDS return file — Form No. 140 (formerly 26Q) ────────────────────

const TDS_STATES = [
  ['01', 'Andaman and Nicobar Islands'], ['02', 'Andhra Pradesh'], ['03', 'Arunachal Pradesh'], ['04', 'Assam'],
  ['05', 'Bihar'], ['06', 'Chandigarh'], ['07', 'Dadra & Nagar Haveli and Daman & Diu'], ['09', 'Delhi'],
  ['10', 'Goa'], ['11', 'Gujarat'], ['12', 'Haryana'], ['13', 'Himachal Pradesh'], ['14', 'Jammu & Kashmir'],
  ['15', 'Karnataka'], ['16', 'Kerala'], ['17', 'Lakshadweep'], ['18', 'Madhya Pradesh'], ['19', 'Maharashtra'],
  ['20', 'Manipur'], ['21', 'Meghalaya'], ['22', 'Mizoram'], ['23', 'Nagaland'], ['24', 'Odisha'],
  ['25', 'Puducherry'], ['26', 'Punjab'], ['27', 'Rajasthan'], ['28', 'Sikkim'], ['29', 'Tamil Nadu'],
  ['30', 'Tripura'], ['31', 'Uttar Pradesh'], ['32', 'West Bengal'], ['33', 'Chhattisgarh'], ['34', 'Uttarakhand'],
  ['35', 'Jharkhand'], ['36', 'Telangana'], ['37', 'Ladakh'],
].map(([value, label]) => ({ value, label }));
const STATE_OPTIONS = [{ value: '', label: 'Choose…' }, ...TDS_STATES];

const DEDUCTOR_TYPE_OPTIONS = [
  { value: '', label: 'Choose…' },
  { value: 'K', label: 'Company' }, { value: 'M', label: 'Branch / Division of Company' },
  { value: 'F', label: 'Firm' }, { value: 'Q', label: 'Individual / HUF' },
  { value: 'P', label: 'AOP' }, { value: 'T', label: 'AOP (Trust)' },
  { value: 'B', label: 'Body of Individuals' }, { value: 'J', label: 'Artificial Juridical Person' },
];

/**
 * The deductor block is the same every quarter, so it's kept per TAN in
 * this browser. The sheet, quarter and year are not — those change.
 */
const TDS_REMEMBERED = [
  'tan', 'deductor_pan', 'deductor_name', 'deductor_type', 'deductor_gstin',
  'address1', 'address2', 'address3', 'address4', 'address5', 'state', 'pincode', 'email', 'phone',
  'rp_name', 'rp_designation', 'rp_pan', 'rp_same_address',
  'rp_address1', 'rp_address2', 'rp_address3', 'rp_address4', 'rp_address5', 'rp_state', 'rp_pincode', 'rp_email', 'rp_phone',
] as const;
const TDS_STORE_KEY = 'tools.tds-form140.deductor';

function loadDeductor(): Record<string, unknown> | null {
  try { return JSON.parse(localStorage.getItem(TDS_STORE_KEY) ?? 'null'); } catch { return null; }
}
function saveDeductor(v: Record<string, unknown>) {
  try { localStorage.setItem(TDS_STORE_KEY, JSON.stringify(Object.fromEntries(TDS_REMEMBERED.map((k) => [k, v[k]])))); } catch { /* storage off */ }
}

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const EMAIL_RE = /^[^\s@^]+@[^\s@^]+\.[^\s@^]+$/;

function TdsOptions({ value, onChange, disabled }: OptionsProps) {
  const v = (k: string) => String(value[k] ?? '');
  const set = (k: string, upper = false) => (x: string) => onChange({ [k]: upper ? x.toUpperCase() : x });
  const same = value.rp_same_address !== false;

  // Fill the deductor block from last time, once, if this form is blank.
  useEffect(() => {
    if (value.tan || value.deductor_name) return;
    const saved = loadDeductor();
    if (saved) onChange(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (value.tan) saveDeductor(value); }, [value]);

  return (
    <div className={disabled ? 'opacity-60 pointer-events-none' : ''}>
      <p className="text-13 text-neutral-700 mb-3">
        Builds <strong className="font-medium">Form 140</strong> (formerly 26Q) — the quarterly TDS return for non-salary payments.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <SelectField
          label="Quarter" value={v('quarter') || 'Q1'} onChange={set('quarter')}
          options={[
            { value: 'Q1', label: 'Q1 — Apr to Jun' }, { value: 'Q2', label: 'Q2 — Jul to Sep' },
            { value: 'Q3', label: 'Q3 — Oct to Dec' }, { value: 'Q4', label: 'Q4 — Jan to Mar' },
          ]}
        />
        <TextField label="Tax year" value={v('financial_year')} onChange={set('financial_year')} placeholder="2026-27" />
      </div>

      <h4 className="text-12 font-medium text-neutral-700 mt-5 mb-2">Deductor</h4>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <TextField label="TAN" value={v('tan')} onChange={set('tan', true)} placeholder="CHEA12345B" />
        <TextField label="PAN" value={v('deductor_pan')} onChange={set('deductor_pan', true)} placeholder="AABCK1234M" />
        <SelectField label="Deductor type" value={v('deductor_type')} onChange={set('deductor_type')} options={DEDUCTOR_TYPE_OPTIONS} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
        <TextField label="Name" value={v('deductor_name')} onChange={set('deductor_name')} placeholder="As registered with TRACES" className="sm:col-span-2" />
        <TextField label="GSTIN (optional)" value={v('deductor_gstin')} onChange={set('deductor_gstin', true)} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
        <TextField label="Flat / door / block" value={v('address1')} onChange={set('address1')} />
        <TextField label="Road / street (optional)" value={v('address3')} onChange={set('address3')} />
        <TextField label="Area / locality (optional)" value={v('address4')} onChange={set('address4')} />
        <TextField label="District / city (optional)" value={v('address5')} onChange={set('address5')} />
        <SelectField label="State" value={v('state')} onChange={set('state')} options={STATE_OPTIONS} />
        <TextField label="PIN code" value={v('pincode')} onChange={set('pincode')} placeholder="600018" />
        <TextField label="Email" value={v('email')} onChange={set('email')} type="email" />
        <TextField label="Mobile" value={v('phone')} onChange={set('phone')} placeholder="10 digits" />
      </div>

      <h4 className="text-12 font-medium text-neutral-700 mt-5 mb-2">Person responsible for deduction</h4>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <TextField label="Name" value={v('rp_name')} onChange={set('rp_name')} />
        <TextField label="Designation" value={v('rp_designation')} onChange={set('rp_designation')} placeholder="Director" />
        <TextField label="PAN" value={v('rp_pan')} onChange={set('rp_pan', true)} />
        <TextField label="Email (blank = deductor's)" value={v('rp_email')} onChange={set('rp_email')} type="email" />
        <TextField label="Mobile (blank = deductor's)" value={v('rp_phone')} onChange={set('rp_phone')} />
      </div>
      <Checkbox className="mt-3" checked={same} onChange={(x) => onChange({ rp_same_address: x })}>
        Same address as the deductor
      </Checkbox>
      {same ? null : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
          <TextField label="Flat / door / block" value={v('rp_address1')} onChange={set('rp_address1')} />
          <TextField label="Road / street (optional)" value={v('rp_address3')} onChange={set('rp_address3')} />
          <TextField label="Area / locality (optional)" value={v('rp_address4')} onChange={set('rp_address4')} />
          <TextField label="District / city (optional)" value={v('rp_address5')} onChange={set('rp_address5')} />
          <SelectField label="State" value={v('rp_state')} onChange={set('rp_state')} options={STATE_OPTIONS} />
          <TextField label="PIN code" value={v('rp_pincode')} onChange={set('rp_pincode')} />
        </div>
      )}

      <Checkbox className="mt-4" checked={value.filed_earlier === true} onChange={(x) => onChange({ filed_earlier: x })}>
        A regular Form 140 has been filed for an earlier quarter
      </Checkbox>
      {value.filed_earlier === true ? (
        <TextField
          label="Token no. of the previous regular statement" value={v('previous_token')}
          onChange={set('previous_token')} placeholder="15 digits" className="mt-2 sm:w-1/2"
        />
      ) : null}

      <div className="mt-4">
        <Columns
          required={['PAN', 'Name', 'Section', 'Date of Payment', 'Amount Paid', 'TDS', 'BSR Code', 'Challan No', 'Challan Date']}
          optional={['Date of Deduction', 'Rate', 'TDS Deposited', 'Remark', 'Certificate No', 'Challan Interest', 'Challan Fee']}
        />
        <p className="text-12 text-neutral-500 mt-2">
          Section: the Form 140 code (1027 for professional fees, 1026 technical, 1023/1024 contract work, 1006 commission…)
          or the old section — 194H, 194C, 194Q and the like convert; 194J and 194-I need the rate to tell which code.
        </p>
      </div>
      <div className="mt-3">
        <Notice tone="warn">
          <div className="text-13">
            Validate the file in <strong className="font-medium">NSDL's FVU 1.2</strong> before you upload.
            <div className="text-12 text-neutral-500 mt-1">
              Tax year 2026-27 onwards only; earlier years are Form 26Q in RPU 6.0. The FVU needs the .csi file
              from Challan Status Inquiry and makes the .fvu you upload. Rows it would reject — dates outside the
              quarter, missing challan details, an unknown section — are skipped here and listed.
            </div>
          </div>
        </Notice>
      </div>
    </div>
  );
}

export const tdsFvuGeneratorUI: ToolUI = {
  actionLabel: 'Generate Form 140 file',
  processingLabel: 'Building records…',
  defaults: { quarter: 'Q1', financial_year: '', rp_same_address: true, filed_earlier: false },
  Options: TdsOptions,
  validate: (v) => {
    const s = (k: string) => String(v[k] ?? '').trim();
    const fy = s('financial_year').match(/^(\d{4})-(\d{2}|\d{4})$/);
    if (!fy) return 'Write the tax year as 2026-27.';
    if (Number(fy[1]) < 2026) return 'Form 140 starts with tax year 2026-27. For earlier years, file Form 26Q through NSDL\'s RPU 6.0.';
    if (!/^[A-Z]{4}\d{5}[A-Z]$/.test(s('tan'))) return 'A TAN is four letters, five digits, then a letter — for example CHEA12345B.';
    if (!PAN_RE.test(s('deductor_pan')) && s('deductor_pan') !== 'PANNOTREQD') return 'Enter the deductor\'s PAN.';
    if (!s('deductor_name')) return 'Enter the deductor\'s name as registered with TRACES.';
    if (!s('deductor_type')) return 'Choose the deductor type.';
    if (!s('address1') || !s('state') || !/^\d{6}$/.test(s('pincode'))) return 'Enter the deductor\'s address, state and 6-digit PIN code.';
    if (!EMAIL_RE.test(s('email'))) return 'Enter a valid deductor email.';
    if (s('phone').replace(/\D/g, '').length < 10) return 'Enter the deductor\'s 10-digit mobile number.';
    if (!s('rp_name') || !s('rp_designation')) return 'Enter the name and designation of the person responsible.';
    if (!PAN_RE.test(s('rp_pan'))) return 'Enter the PAN of the person responsible.';
    if (v.rp_same_address === false && (!s('rp_address1') || !s('rp_state') || !/^\d{6}$/.test(s('rp_pincode')))) {
      return 'Enter the responsible person\'s address, state and PIN code.';
    }
    if (v.filed_earlier === true && !/^\d{15}$/.test(s('previous_token'))) return 'Enter the 15-digit token number of the previous statement.';
    return null;
  },
  ResultNote: ({ output }) => {
    const skipped = n(output.meta.skipped);
    return (
      <div className="text-13 text-neutral-500">
        {n(output.meta.deductees)} deductees across {n(output.meta.challans)} challans ·
        TDS ₹{money(output.meta.total_tds)} · Form 140 {String(output.meta.quarter ?? '')}.
        {skipped ? ` ${skipped} ${skipped === 1 ? 'row was' : 'rows were'} skipped — see the warning above.` : ''}
        {' '}Validate it with NSDL's FVU 1.2, with the .csi file, before uploading.
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
