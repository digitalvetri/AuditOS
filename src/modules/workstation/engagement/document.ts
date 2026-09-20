/**
 * The ENGAGEMENT LETTER document model.
 *
 * A letter is an ordered list of blocks, not a fixed JSX layout: that is what
 * lets a firm move Confidentiality above Fees, add a clause, or drop a
 * section without touching the renderer. The server stores the list verbatim
 * and its PDF walks the same list, so preview and paper cannot disagree about
 * what the letter contains or in what order.
 */
import { DEFAULT_LAYOUT, type CompanyInfo, type LayoutConfig } from '@/modules/workstation/quotations/document';

export type EBlockKey =
  | 'letterhead'
  | 'date'
  | 'recipient'
  | 'subject'
  | 'salutation'
  /** Untitled prose — the introduction, the objective. */
  | 'paragraph'
  /** Titled prose — management responsibility, confidentiality, terms, custom. */
  | 'section'
  | 'fees'
  | 'closing'
  | 'signature'
  | 'confirmation'
  | 'spacer';

export type ListStyle = 'none' | 'bullet' | 'number';

/**
 * One paragraph or list item of prose — the unit that is edited, paginated
 * and printed. `html` is INLINE only (b, i, u, br) with {{placeholders}} kept
 * as literal text; the paragraph-level facts (list kind, alignment, indent)
 * live beside it as data, so the PDF can render them without parsing layout
 * out of markup.
 */
export type LineKind = 'p' | 'bullet' | 'number';
export type Align = 'left' | 'center' | 'right' | 'justify';
export interface Line {
  id: string;
  kind: LineKind;
  align: Align;
  /** 0–4 levels. */
  indent: number;
  html: string;
}

export interface EBlock {
  id: string;
  key: EBlockKey;
  enabled: boolean;
  /** Heading for a section, or the Fees heading. */
  title?: string;
  /** Prose. Supports {{placeholders}}; blank lines separate paragraphs. */
  body?: string;
  /** How a LEGACY `body` renders. New prose lives in `lines`. */
  listStyle?: ListStyle;
  /** Prose blocks (paragraph, section, closing, fees note): the text itself. */
  lines?: Line[];
  /** Spacer only. */
  heightPx?: number;
  /**
   * Shown in the EDITOR only, never printed — used where the firm's own
   * wording is required and must not be invented on its behalf.
   */
  hint?: string;
}

export const BLOCK_LABEL: Record<EBlockKey, string> = {
  letterhead: 'Letterhead',
  date: 'Date',
  recipient: 'Recipient',
  subject: 'Subject',
  salutation: 'Salutation',
  paragraph: 'Paragraph',
  section: 'Section',
  fees: 'Fees',
  closing: 'Closing',
  signature: 'Signature',
  confirmation: 'Client confirmation',
  spacer: 'Space',
};

export interface Recipient {
  name: string;
  designation: string;
  companyName: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  email: string;
  phone: string;
}

export interface FeeLine {
  key: string;
  service: string;
  description: string;
  frequency: string;
  /** Rupees as typed, so a half-finished figure does not become 0. */
  amountText: string;
  billingBasis: string;
  notes: string;
}

export const EMPTY_RECIPIENT: Recipient = {
  name: '', designation: '', companyName: '', address: '',
  city: '', state: '', pincode: '', email: '', phone: '',
};

/**
 * How a letter looks, in the quotation's own layout vocabulary (page, margins,
 * type, header, footer) so the two documents are set up the same way. The
 * reference letter's look: centred letterhead over a rule, page numbers.
 */
export const ENGAGEMENT_LAYOUT: LayoutConfig = {
  ...DEFAULT_LAYOUT,
  font: 'sans',
  fontSize: 10.5,
  lineHeight: 'normal',
  headingSize: 'normal',
  headerStyle: 'rule',
  footerStyle: 'page-numbers',
  logoPosition: 'center',
};

/** A saved layout_config (layout keys + company) back to a full layout. */
export function layoutOf(cfg: Record<string, unknown> | null | undefined): LayoutConfig {
  const { company: _company, ...rest } = (cfg ?? {}) as Record<string, unknown>;
  void _company;
  return { ...ENGAGEMENT_LAYOUT, ...(rest as Partial<LayoutConfig>) };
}

/** The letterhead on the reference engagement letter. Editable per letter. */
export const ENGAGEMENT_COMPANY: CompanyInfo = {
  name: 'JNS Accounting Solutions',
  addressLine1: '2A, Velavan Nagar, IInd Street, SRP Mills',
  addressLine2: 'Saravanampatti',
  city: 'Coimbatore',
  state: 'Tamil Nadu',
  pin: '641 035',
  email: 'jnsacctax@gmail.com',
  phone: '97900 39150',
  gstin: '',
  website: '',
  logo: '',
};

export const PLACEHOLDERS: { token: string; label: string }[] = [
  { token: '{{company_name}}', label: 'Client company' },
  { token: '{{client_name}}', label: 'Contact person' },
  { token: '{{designation}}', label: 'Designation' },
  { token: '{{financial_year}}', label: 'Financial year' },
  { token: '{{effective_from}}', label: 'Effective from' },
  { token: '{{effective_until}}', label: 'Effective until' },
  { token: '{{firm_name}}', label: 'Firm name' },
];

let seq = 0;
export const bid = () => `b${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Prose defaults are written as text and converted, so they read naturally here. */
const b = (key: EBlockKey, extra: Partial<EBlock> = {}): EBlock => {
  const block: EBlock = { id: bid(), key, enabled: true, ...extra };
  return PROSE.has(key) ? normalizeBlocks([block])[0] : block;
};

/**
 * The reference letter as a starting template.
 *
 * Client-specific facts (the company, the period) are PLACEHOLDERS, so the
 * reference client never leaks into a new letter. Management responsibility
 * and confidentiality start empty with an editor-only hint: their wording is
 * the firm's legal position and is not something to invent.
 */
export function defaultBlocks(): EBlock[] {
  return [
    b('letterhead'),
    b('date'),
    b('recipient'),
    b('subject'),
    b('salutation', { body: 'Dear Sir,' }),
    b('paragraph', {
      body:
        'You have requested that we provide Accounting and Bookkeeping Services of {{company_name}} for the '
        + 'Financial year starting from {{effective_from}} till end of {{effective_until}} including GST and TDS '
        + 'return filing, if applicable. This engagement does not include provision of payroll services and '
        + 'income tax filing services.',
    }),
    b('paragraph', {
      body:
        'We are pleased to confirm our acceptance and our understanding of this engagement by means of this '
        + 'letter. The objective of this engagement is to help the organization maintain proper and timely set '
        + 'of books and records and help with the legal compliances relating to tax and accounting matters.',
    }),
    b('section', {
      title: 'Responsibility of the management:',
      body: '',
      hint: 'Enter the management-responsibility wording your firm uses.',
    }),
    b('section', {
      title: 'Confidentiality:',
      body: '',
      hint: 'Enter the confidentiality wording your firm uses.',
    }),
    b('fees', {
      title: 'Fees:',
      body: 'Any other consultancy and other services shall be billed separately as and when the services are provided.',
    }),
    b('section', {
      title: 'Additional terms:',
      body:
        'Out of the above services - the tax audit shall be carried on by L.Venkatasubbu and Co, Chartered '
        + 'Accountants situated in Coimbatore.',
    }),
    b('closing', {
      body:
        'We look forward for your full cooperation with your staff and we also cordially thank in advance for the same.',
    }),
    b('signature'),
    b('confirmation', { body: 'The above terms and conditions are agreed and confirmed by;' }),
  ];
}

let fseq = 0;
export const fkey = () => `f${(fseq++).toString(36)}`;

export const newFee = (over: Partial<FeeLine> = {}): FeeLine => ({
  key: fkey(), service: '', description: '', frequency: '', amountText: '',
  billingBasis: '', notes: '', ...over,
});

/** The reference fee schedule — the firm's own pricing, editable per letter. */
export const DEFAULT_FEES = (): FeeLine[] => [
  newFee({ service: 'Accounting and GST Filing', frequency: 'per month', amountText: '2,000' }),
  newFee({ service: 'TDS Filing', frequency: 'per quarter', amountText: '1,500', billingBasis: 'per return type' }),
  newFee({ service: 'Income tax return and tax audit', frequency: 'per year', amountText: '20,000' }),
  newFee({ service: 'Annual Return and MCA compliances', frequency: 'per year', amountText: '15,000' }),
];

export const FEE_FREQUENCIES = ['per month', 'per quarter', 'per half-year', 'per year', 'per return', 'one-time'];

export const fmtLong = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
};

/**
 * Substitute {{placeholders}}. An unknown or still-empty name is left as
 * typed, so a missing value shows up on the page instead of vanishing into a
 * sentence that silently reads wrong.
 */
export function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (vars[k] ? vars[k] : m));
}

export const rupees = (paise: number): string =>
  `Rs. ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

// ── Lines ─────────────────────────────────────────────────────────────────

/** Prose blocks carry `lines`; the rest keep single plain strings. */
export const PROSE: ReadonlySet<EBlockKey> = new Set(['paragraph', 'section', 'closing', 'fees']);

let lseq = 0;
export const lid = () => `l${Date.now().toString(36)}${(lseq++).toString(36)}`;

export const escapeHtml = (t: string) =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const newLine = (over: Partial<Line> = {}): Line =>
  ({ id: lid(), kind: 'p', align: 'justify', indent: 0, html: '', ...over });

/** Plain text, as the first version of the builder stored it, into lines. */
export function linesFromText(body: string, style: ListStyle = 'none'): Line[] {
  const t = body.trim();
  if (!t) return [];
  if (style === 'bullet' || style === 'number') {
    return t.split('\n').map((x) => x.trim()).filter(Boolean)
      .map((x) => newLine({ kind: style, align: 'left', html: escapeHtml(x) }));
  }
  return t.split(/\n\s*\n/).map((para) => newLine({ html: escapeHtml(para.trim()).replace(/\n/g, '<br>') }));
}

/**
 * Bring any saved block list up to the current shape: legacy `body` prose
 * becomes `lines`, and an editable prose block always has at least one line
 * so there is somewhere on the page to click and type.
 */
export function normalizeBlocks(blocks: EBlock[]): EBlock[] {
  return blocks.map((b) => {
    if (!PROSE.has(b.key)) return b;
    let lines = b.lines;
    if (!lines) lines = linesFromText(b.body ?? '', b.listStyle);
    if (!lines.length) lines = [newLine()];
    const { body: _legacy, ...rest } = b;
    void _legacy;
    return { ...rest, lines };
  });
}

/** A line with nothing but markup or whitespace in it. */
export const lineIsEmpty = (l: Line) => !l.html.replace(/<br\s*\/?>/gi, '').replace(/&nbsp;|\u00a0/g, '').trim();
