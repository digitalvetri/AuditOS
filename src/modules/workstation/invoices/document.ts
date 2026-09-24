import {
  DEFAULT_COMPANY, DEFAULT_LAYOUT, MARGIN_MM, PAGE_MM,
  type CompanyInfo, type LayoutConfig,
} from '../quotations/document';

/**
 * INVOICE DOCUMENT MODEL — the shape the builder edits and the renderer draws.
 *
 * Deliberately built on the quotation's layout primitives rather than beside
 * them: `LayoutConfig`, `CompanyInfo`, `PAGE_MM` and `MARGIN_MM` are imported,
 * not copied. A second A4 geometry that drifts from the first is exactly the
 * failure §51 warns about, and it would show up as a PDF that no longer
 * matches the preview.
 *
 * What IS invoice-specific lives here: the block set, the tax-summary shape
 * and the client-side mirror of the tax arithmetic.
 */

export { DEFAULT_COMPANY, DEFAULT_LAYOUT, MARGIN_MM, PAGE_MM };
export type { CompanyInfo, LayoutConfig };

export type TemplateId = 'tax-invoice';

/** The blocks of the reference document, in its order (§29, §50). */
export type BlockKey =
  | 'company_header'
  | 'invoice_title'
  | 'invoice_meta'
  | 'bill_to'
  | 'ship_to'
  | 'items_table'
  | 'total_in_words'
  | 'notes'
  | 'tax_summary'
  | 'bank_details'
  | 'signature'
  | 'footer';

export interface BlockSpec {
  key: BlockKey;
  id: string;
  enabled: boolean;
}

export const BLOCK_LABEL: Record<BlockKey, string> = {
  company_header: 'Company header',
  invoice_title: 'TAX INVOICE title',
  invoice_meta: 'Invoice information',
  bill_to: 'Bill To',
  ship_to: 'Ship To',
  items_table: 'Items table',
  total_in_words: 'Total in words',
  notes: 'Notes',
  tax_summary: 'Tax summary',
  bank_details: 'Bank details',
  signature: 'Authorized signature',
  footer: 'Computer-generated footer',
};

/**
 * Bill To and Ship To share a row in the reference document, and the tax
 * summary sits beside Total-in-words/Notes. The renderer pairs them, so
 * reordering moves the pair — which is why these two are listed adjacently.
 */
export const DEFAULT_BLOCKS: BlockKey[] = [
  'company_header', 'invoice_title', 'invoice_meta', 'bill_to', 'ship_to',
  'items_table', 'total_in_words', 'notes', 'tax_summary',
  'bank_details', 'signature', 'footer',
];

let seq = 0;
export const blockId = () => `b${++seq}`;

export const defaultBlocks = (): BlockSpec[] =>
  DEFAULT_BLOCKS.map((key) => ({ key, id: blockId(), enabled: true }));

export const DEFAULT_FOOTER_NOTE = 'This is a computer generated invoice.';
export const DEFAULT_NOTES = 'Thanks for your business.';

/**
 * Indian states with their GST state codes. The code is what decides the tax
 * split, which is why it is carried alongside the name rather than looked up
 * from a second table at render time.
 */
export const STATES: { name: string; code: string }[] = [
  { name: 'Andaman and Nicobar Islands', code: '35' },
  { name: 'Andhra Pradesh', code: '37' },
  { name: 'Arunachal Pradesh', code: '12' },
  { name: 'Assam', code: '18' },
  { name: 'Bihar', code: '10' },
  { name: 'Chandigarh', code: '04' },
  { name: 'Chhattisgarh', code: '22' },
  { name: 'Dadra and Nagar Haveli and Daman and Diu', code: '26' },
  { name: 'Delhi', code: '07' },
  { name: 'Goa', code: '30' },
  { name: 'Gujarat', code: '24' },
  { name: 'Haryana', code: '06' },
  { name: 'Himachal Pradesh', code: '02' },
  { name: 'Jammu and Kashmir', code: '01' },
  { name: 'Jharkhand', code: '20' },
  { name: 'Karnataka', code: '29' },
  { name: 'Kerala', code: '32' },
  { name: 'Ladakh', code: '38' },
  { name: 'Lakshadweep', code: '31' },
  { name: 'Madhya Pradesh', code: '23' },
  { name: 'Maharashtra', code: '27' },
  { name: 'Manipur', code: '14' },
  { name: 'Meghalaya', code: '17' },
  { name: 'Mizoram', code: '15' },
  { name: 'Nagaland', code: '13' },
  { name: 'Odisha', code: '21' },
  { name: 'Puducherry', code: '34' },
  { name: 'Punjab', code: '03' },
  { name: 'Rajasthan', code: '08' },
  { name: 'Sikkim', code: '11' },
  { name: 'Tamil Nadu', code: '33' },
  { name: 'Telangana', code: '36' },
  { name: 'Tripura', code: '16' },
  { name: 'Uttar Pradesh', code: '09' },
  { name: 'Uttarakhand', code: '05' },
  { name: 'West Bengal', code: '19' },
];

/** 'Tamil Nadu (33)', the form the reference document prints. */
export const stateLabel = (name: string): string => {
  const s = STATES.find((x) => x.name === name);
  return s ? `${s.name} (${s.code})` : name;
};

/** The state name out of a 'Tamil Nadu (33)' label. */
export const stateName = (label: string): string => label.replace(/\s*\(\d+\)\s*$/, '').trim();

// ── The editor's working line ─────────────────────────────────────────────

export interface Line {
  key: string;
  itemName: string;
  description: string;
  hsnSac: string;
  /** Hundredths of a unit: 250 = 2.5. */
  quantityCenti: number;
  unit: string;
  ratePaise: number;
  discountPercent: number;
  /** The FULL slab; CGST/SGST are half each. */
  gstRatePercent: number;
}

let lineSeq = 0;
export const lineKey = () => `l${++lineSeq}`;

export const newLine = (): Line => ({
  key: lineKey(),
  itemName: '',
  description: '',
  hsnSac: '',
  quantityCenti: 100,
  unit: 'Nos',
  ratePaise: 0,
  discountPercent: 0,
  gstRatePercent: 18,
});

// ── Money ─────────────────────────────────────────────────────────────────
//
// A FAITHFUL MIRROR of server/src/modules/invoice/totals.ts. It exists so the
// preview can update on a keystroke without a round trip; the server remains
// the only thing that decides what is STORED. The two must agree, so the
// rules are copied exactly: integers throughout, half-up rounding once per
// line, CGST/SGST carried in basis points, and the line amount is the TAXABLE
// BASE with tax added on top — never tax-inclusive.

export const HALF_RATE_BPS: Record<number, number> = { 0: 0, 5: 250, 12: 600, 18: 900, 28: 1400 };

const divRound = (n: number, d: number) => Math.floor((n + Math.floor(d / 2)) / d);
const bpsOf = (paise: number, bps: number) => divRound(paise * bps, 10_000);
const clampPct = (n: number) => (Number.isFinite(n) ? Math.min(100, Math.max(0, Math.trunc(n))) : 0);

export interface LineTotals {
  taxableAmountPaise: number;
  cgstAmountPaise: number;
  sgstAmountPaise: number;
  igstAmountPaise: number;
  totalAmountPaise: number;
  cgstRatePercent: number;
  sgstRatePercent: number;
  igstRatePercent: number;
}

export interface Totals {
  lines: LineTotals[];
  subtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  roundOffPaise: number;
  totalPaise: number;
  balanceDuePaise: number;
}

export function lineTaxable(l: Pick<Line, 'quantityCenti' | 'ratePaise' | 'discountPercent'>): number {
  const gross = divRound(l.quantityCenti * l.ratePaise, 100);
  return Math.max(0, gross - bpsOf(gross, clampPct(l.discountPercent) * 100));
}

export function computeTotals(
  lines: Pick<Line, 'quantityCenti' | 'ratePaise' | 'discountPercent' | 'gstRatePercent'>[],
  opts: { invoiceDiscountPaise?: number; isInterState?: boolean; amountPaidPaise?: number; roundOff?: boolean } = {},
): Totals {
  const isInterState = opts.isInterState ?? false;
  const roundOff = opts.roundOff ?? true;

  const bases = lines.map(lineTaxable);
  const subtotalPaise = bases.reduce((a, b) => a + b, 0);

  const requested = Math.max(0, Math.trunc(opts.invoiceDiscountPaise ?? 0));
  const discountPaise = Math.min(requested, subtotalPaise);
  const shares: number[] = [];
  let spread = 0;
  bases.forEach((base, i) => {
    const share = i === bases.length - 1
      ? discountPaise - spread
      : subtotalPaise === 0 ? 0 : divRound(discountPaise * base, subtotalPaise);
    shares.push(share);
    spread += share;
  });

  const out: LineTotals[] = lines.map((l, i) => {
    const taxable = Math.max(0, bases[i] - (shares[i] ?? 0));
    const slab = clampPct(l.gstRatePercent);
    const halfBps = HALF_RATE_BPS[slab] ?? Math.trunc((slab * 100) / 2);
    const cgst = isInterState ? 0 : bpsOf(taxable, halfBps);
    const sgst = isInterState ? 0 : bpsOf(taxable, halfBps);
    const igst = isInterState ? bpsOf(taxable, slab * 100) : 0;
    return {
      taxableAmountPaise: taxable,
      cgstAmountPaise: cgst,
      sgstAmountPaise: sgst,
      igstAmountPaise: igst,
      totalAmountPaise: taxable + cgst + sgst + igst,
      cgstRatePercent: isInterState ? 0 : slab / 2,
      sgstRatePercent: isInterState ? 0 : slab / 2,
      igstRatePercent: isInterState ? slab : 0,
    };
  });

  const taxablePaise = out.reduce((a, l) => a + l.taxableAmountPaise, 0);
  const cgstPaise = out.reduce((a, l) => a + l.cgstAmountPaise, 0);
  const sgstPaise = out.reduce((a, l) => a + l.sgstAmountPaise, 0);
  const igstPaise = out.reduce((a, l) => a + l.igstAmountPaise, 0);

  const exact = taxablePaise + cgstPaise + sgstPaise + igstPaise;
  const rounded = roundOff ? divRound(exact, 100) * 100 : exact;
  const totalPaise = rounded;
  const paid = Math.max(0, Math.trunc(opts.amountPaidPaise ?? 0));

  return {
    lines: out,
    subtotalPaise,
    discountPaise,
    taxablePaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    roundOffPaise: rounded - exact,
    totalPaise,
    balanceDuePaise: Math.max(0, totalPaise - paid),
  };
}

// ── Currency and words ────────────────────────────────────────────────────

/** Indian grouping: 12,34,567.00 — never 1,234,567.00 (§44). */
export function inrAmount(paise: number): string {
  const neg = paise < 0;
  const n = Math.abs(paise);
  const whole = Math.floor(n / 100);
  const frac = String(n % 100).padStart(2, '0');
  const s = String(whole);
  // Last three digits, then pairs — the Indian lakh/crore grouping.
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${neg ? '-' : ''}${grouped}.${frac}`;
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function under100(n: number): string {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  const o = n % 10;
  return o ? `${t}-${ONES[o]}` : t;
}

function under1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (r) parts.push(under100(r));
  return parts.join(' ');
}

/**
 * Indian-system words — lakh and crore, not million (§21, §44).
 * Mirrors the server's amountInWords so the preview and the stored document
 * read the same; the stored invoice still carries the server's string.
 */
export function amountInWords(paise: number): string {
  const rupees = Math.floor(Math.abs(paise) / 100);
  const paiseRem = Math.abs(paise) % 100;
  if (rupees === 0 && paiseRem === 0) return 'Indian Rupee Zero Only';

  const crore = Math.floor(rupees / 10_000_000);
  const lakh = Math.floor((rupees % 10_000_000) / 100_000);
  const thousand = Math.floor((rupees % 100_000) / 1000);
  const rest = rupees % 1000;

  const parts: string[] = [];
  if (crore) parts.push(`${under1000(crore)} Crore`);
  if (lakh) parts.push(`${under1000(lakh)} Lakh`);
  if (thousand) parts.push(`${under1000(thousand)} Thousand`);
  if (rest) parts.push(under1000(rest));

  let s = `Indian Rupee ${parts.join(' ')}`.replace(/\s+/g, ' ').trim();
  if (paiseRem) s += ` and ${under100(paiseRem)} Paise`;
  return `${s} Only`;
}

/** 19/09/2026 — the reference document's date format. */
export function fmtDocDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}
