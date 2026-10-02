/**
 * The quotation DOCUMENT model: what a template is, which blocks exist, how
 * the page is laid out, and what a new quotation starts as.
 *
 * Deliberately separate from `api.ts` (the wire) and from the renderer (the
 * pixels). A quotation stores data + template + layout + blocks; changing any
 * one of the three must not require touching the other two, which is what
 * makes a second or third template a small change later.
 */

export type TemplateId = 'jns-compliance' | 'gst-line-item';

/** Every section the document can contain, in its natural order. */
export type BlockKey =
  | 'company_header'
  | 'quotation_title'
  | 'quotation_meta'
  | 'client_information'
  | 'subject'
  | 'introduction'
  | 'fee_table'
  | 'nature_of_work'
  | 'terms'
  | 'payment_details'
  | 'notes'
  | 'closing'
  | 'custom'
  | 'spacer';

export interface BlockSpec {
  key: BlockKey;
  /** Stable id — a custom block can appear more than once. */
  id: string;
  enabled: boolean;
  /** Heading for a custom block; the built-ins carry their own. */
  title?: string;
  /** Body for a custom block. */
  body?: string;
  /**
   * Spacer only: how much blank paper, in millimetres.
   * @deprecated Superseded by `heightPx`. Still read so quotations saved
   * before the switch keep the gap their author chose.
   */
  heightMm?: number;
  /** Spacer only: how much blank paper, in CSS pixels. */
  heightPx?: number;
}

export const BLOCK_LABEL: Record<BlockKey, string> = {
  company_header: 'Company header',
  quotation_title: 'Quotation title',
  quotation_meta: 'Quotation information',
  client_information: 'Client information',
  subject: 'Subject',
  introduction: 'Introduction',
  fee_table: 'Service / fee table',
  nature_of_work: 'Nature of work',
  terms: 'Terms & conditions',
  payment_details: 'Payment details',
  notes: 'Notes',
  closing: 'Closing / signature',
  custom: 'Custom block',
  spacer: 'Space',
};

// ── Space blocks ──────────────────────────────────────────────────────────
// A space is a real block, not a CSS margin: it sits in the block list, so it
// reorders, deletes and paginates exactly like a section, and it survives the
// trip through `block_config` to the server and back out into the PDF.

export const SPACE_DEFAULT_PX = 24;
export const SPACE_MIN_PX = 8;
export const SPACE_MAX_PX = 120;
/** One press of the increase/decrease control. */
export const SPACE_STEP_PX = 8;

export const clampSpace = (px: number): number =>
  Math.min(SPACE_MAX_PX, Math.max(SPACE_MIN_PX, Math.round(px)));

/**
 * The height a spacer should render at, in pixels.
 *
 * Reads `heightPx` first, then falls back to the millimetre field that older
 * saved quotations carry, so nothing that was already composed shifts on the
 * page. Deliberately NOT clamped: a pre-existing 25mm gap is its author's
 * choice, and silently shrinking it would reflow a document they signed off.
 */
export function spaceHeightPx(b: Pick<BlockSpec, 'heightPx' | 'heightMm'>): number {
  if (typeof b.heightPx === 'number' && Number.isFinite(b.heightPx)) return b.heightPx;
  if (typeof b.heightMm === 'number' && Number.isFinite(b.heightMm)) return b.heightMm * MM;
  return SPACE_DEFAULT_PX;
}

/** A fresh space block, ready to drop into the block list. */
export const makeSpace = (id: string, heightPx = SPACE_DEFAULT_PX): BlockSpec =>
  ({ key: 'spacer', id, enabled: true, heightPx: clampSpace(heightPx) });

export interface LayoutConfig {
  pageSize: 'A4' | 'Letter';
  orientation: 'portrait' | 'landscape';
  margin: 'narrow' | 'normal' | 'wide';
  font: 'sans' | 'serif';
  /** Body size in points, as a document editor states it. */
  fontSize: number;
  headingSize: 'compact' | 'normal' | 'large';
  lineHeight: 'tight' | 'normal' | 'relaxed';
  tableStyle: 'lined' | 'striped' | 'plain';
  headerStyle: 'bar' | 'rule' | 'plain';
  footerStyle: 'none' | 'page-numbers' | 'company';
  logoPosition: 'left' | 'center' | 'right';
}

export interface CompanyInfo {
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  pin: string;
  email: string;
  phone: string;
  gstin: string;
  website: string;
  logo: string;
}

/** §7/§8 — the client's particulars as they appear ON the quotation. */
export interface ClientSnapshot {
  name: string;
  client_type: string;
  industry: string;
  location: string;
  transactions: string;
}

/** A Nature-of-Work section in the editor. */
export interface WorkSection {
  /** Local key for React; the server assigns real ids. */
  key: string;
  title: string;
  description: string;
  items: string[];
}

export const DEFAULT_LAYOUT: LayoutConfig = {
  pageSize: 'A4',
  orientation: 'portrait',
  margin: 'normal',
  font: 'sans',
  fontSize: 10.5,
  headingSize: 'normal',
  lineHeight: 'normal',
  tableStyle: 'lined',
  headerStyle: 'rule',
  footerStyle: 'page-numbers',
  logoPosition: 'left',
};

/**
 * The firm's own letterhead. One place to change it, and every field is
 * editable per quotation in the builder — nothing about the renderer assumes
 * this particular firm.
 */
export const DEFAULT_COMPANY: CompanyInfo = {
  name: 'JNS Accounting Solutions',
  addressLine1: '83, PV Krishnan Street',
  addressLine2: 'K K Nagar',
  city: 'Coimbatore',
  state: 'Tamil Nadu',
  pin: '641038',
  email: 'jnsacctax@gmail.com',
  phone: '9363993765',
  gstin: '',
  website: '',
  logo: '/jns-logo-tight.png',
};

const block = (key: BlockKey, enabled = true): BlockSpec => ({ key, id: key, enabled });

/** Block order per template. The compliance document follows the reference. */
export function defaultBlocks(template: TemplateId): BlockSpec[] {
  if (template === 'gst-line-item') {
    return [
      block('company_header'),
      block('quotation_title'),
      block('quotation_meta'),
      block('client_information', false),
      block('subject'),
      block('introduction', false),
      block('fee_table'),
      block('nature_of_work', false),
      block('terms'),
      block('payment_details', false),
      block('notes'),
      block('closing'),
    ];
  }
  return [
    block('company_header'),
    block('quotation_title'),
    block('quotation_meta'),
    block('subject'),
    block('introduction'),
    block('client_information'),
    block('fee_table'),
    block('nature_of_work'),
    block('terms', false),
    block('payment_details', false),
    block('notes', false),
    block('closing'),
  ];
}

/**
 * Starting content for a new compliance quotation.
 *
 * SUGGESTIONS, not fixed text: every line is editable and deletable in the
 * builder, and none of it is written into the document unless the user keeps
 * it. Amounts are deliberately absent — the reference figures belong to the
 * quotation they came from, not to this system.
 */
export const COMPLIANCE_STARTER = {
  introduction:
    'Dear Sir/Madam,\n\nWe are pleased to provide our quotation for handling statutory compliance and filing services for your organisation as detailed below:',
  closingText: 'Thanks',
  services: [
    { description: 'Accounting (Vouching of entries)', frequency: 'Monthly' },
    { description: 'MIS Reporting (Analysis of FS)', frequency: 'Monthly' },
    { description: 'GST Filing', frequency: 'Quarterly' },
    { description: 'TDS Filing', frequency: 'Quarterly' },
    { description: 'Income Tax Filing (Without Tax Audit)', frequency: 'Yearly' },
  ],
  workSections: [
    {
      title: 'Nature of Work – Data Entry / Bookkeeping',
      description: '',
      items: [
        'Weekly recording of all transactions in Tally',
        'Bank reconciliation (all accounts)',
        'Purchase, sales, expenses, receipts, payments',
        'Inventory accounting support (basic stock ledger)',
        'Maintenance of books of accounts as per Income Tax & GST requirements',
      ],
    },
    {
      title: 'MIS Reporting',
      description: '',
      items: [
        'Monthly profit and loss statement',
        'Receivables and payables ageing',
        'Analysis of financial statements',
      ],
    },
    {
      title: 'GST Monthly Compliance',
      description: '',
      items: [
        'Monthly GSTR-1 & GSTR-3B filing',
        'ITC reconciliation (GSTR-2B vs books)',
      ],
    },
    {
      title: 'GST Annual Compliance',
      description: '',
      items: [
        'GSTR-9 computation and filing',
        'GSTR-9C – reconciliation filing',
      ],
    },
    {
      title: 'TDS Compliance',
      description: '',
      items: [
        'TDS calculation on payments',
        'Quarterly TDS returns (26Q / 24Q / 27Q as applicable)',
        'Form 16 / 16A generation support',
        'TDS payment challans',
      ],
    },
    {
      title: 'Income Tax Filing',
      description: '',
      items: [
        'Preparation of Profit & Loss Account and Balance Sheet',
        'Computation of taxable income',
        'Advance tax calculation & reminders',
        'Filing of ITR for the firm',
        'Filing of ITR for the partners',
        'Tax audit forms',
      ],
    },
  ],
};

/** §12 — the common ones, plus whatever the user types. */
export const FREQUENCY_OPTIONS = [
  'Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'One-Time',
  'As Required', 'Per Filing', 'Per Transaction',
];

// ── Page geometry ─────────────────────────────────────────────────────────
// Millimetres, converted at the CSS reference of 96dpi. The renderer works in
// pixels because that is what a browser measures in, and the page must be a
// real A4 so what is on screen is what comes out of the printer.

export const MM = 96 / 25.4;

export const PAGE_MM: Record<LayoutConfig['pageSize'], { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  Letter: { w: 215.9, h: 279.4 },
};

export const MARGIN_MM: Record<LayoutConfig['margin'], number> = {
  narrow: 12,
  normal: 18,
  wide: 25,
};

export function pageGeometry(layout: LayoutConfig) {
  const base = PAGE_MM[layout.pageSize] ?? PAGE_MM.A4;
  const portrait = layout.orientation !== 'landscape';
  const wMm = portrait ? base.w : base.h;
  const hMm = portrait ? base.h : base.w;
  const mMm = MARGIN_MM[layout.margin] ?? MARGIN_MM.normal;
  return {
    widthMm: wMm,
    heightMm: hMm,
    marginMm: mMm,
    widthPx: wMm * MM,
    heightPx: hMm * MM,
    marginPx: mMm * MM,
    contentHeightPx: (hMm - mMm * 2) * MM,
  };
}

export const LINE_HEIGHT: Record<LayoutConfig['lineHeight'], number> = {
  tight: 1.35,
  normal: 1.55,
  relaxed: 1.8,
};

export const HEADING_SCALE: Record<LayoutConfig['headingSize'], number> = {
  compact: 1.15,
  normal: 1.35,
  large: 1.6,
};
