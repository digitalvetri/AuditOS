/**
 * ENGAGEMENT LETTER TEMPLATES — the five starting points a letter can be
 * switched between.
 *
 * `jns-accounting` is the original builder template, drawn in the builder's
 * own "classic" look. The other four reproduce the firm's Word letters
 * (Enagement form/*.pdf) exactly: the same words, the same fonts and sizes,
 * the same spacing and the same page breaks. Their look is a WORD SKIN —
 * page geometry, line pitch, letterhead and footer measured off the PDFs —
 * and their content is ordinary blocks, so every word stays editable on the
 * page. Distances are in points (1/72 in), as Word states them; positions are
 * the TOP of a line box.
 *
 * The server's PDF mirrors the skins in backend/src/modules/engagement/skins.ts.
 * Change a number here, change it there.
 */
import type { CompanyInfo } from '@/modules/workstation/quotations/document';
import {
  ENGAGEMENT_COMPANY, EMPTY_RECIPIENT, bid, defaultBlocks, DEFAULT_FEES, newFee, newLine,
  type EBlock, type FeeLine, type Line, type Recipient, type TableCell,
} from './document';

export type EngagementTemplateId =
  | 'jns-accounting'
  | 'jns-compliance'
  | 'jns-epr'
  | 'jns-accounting-services'
  | 'jns-bookkeeping';

// ── Word skins ────────────────────────────────────────────────────────────

export type FontKey = 'times' | 'segoe' | 'arial' | 'bell' | 'calibri';

/** CSS stacks: the Word font first, then a metric-compatible bundled face. */
export const FONT_STACK: Record<FontKey, string> = {
  times: '"Times New Roman", "EL Tinos", Tinos, "Liberation Serif", Times, serif',
  segoe: '"Segoe UI", "Open Sans", "Helvetica Neue", Arial, sans-serif',
  arial: 'Arial, "Liberation Sans", Arimo, Helvetica, sans-serif',
  bell: '"Bell MT", Georgia, "EL Tinos", "Times New Roman", serif',
  calibri: 'Calibri, "EL Carlito", Carlito, sans-serif',
};

/**
 * Where a font puts its baseline inside a line box as tall as the font size:
 * 0.5 + (ascent − descent) / 2, from each face's own metrics. Used to place
 * letterhead and footer lines by the baselines measured off the PDFs.
 */
export const BASELINE_K: Record<FontKey, number> = {
  times: 0.8375, segoe: 0.914, arial: 0.8467, bell: 0.83, calibri: 0.84,
};

export interface HeadLine { font: FontKey; size: number; bold: boolean; color: string; baseline: number }

export interface WordSkin {
  /** Body size (pt) and its line pitch. */
  size: number;
  pitch: number;
  /** Line pitch for other sizes used in the letter; else size × 1.16. */
  pitchBySize?: Record<string, number>;
  /** Space after a line that runs straight into the next one. */
  gap: number;
  /** Space after a paragraph that is followed by one blank line (Word's default here). */
  blank: number;
  /** Top of the first body line on page 1, and on every later page. */
  top: [number, number];
  /** Body text may not run below this (842 − Word's 72pt bottom margin). */
  bottom: number;
  /** Left / right margins. */
  margin: number;
  /** Letterhead: the firm name, then the three address lines. */
  letterhead: { name: HeadLine; addr: HeadLine[]; repeat: boolean };
  /** The "1 | Page" footer: its baseline, and whether "Page" is letter-spaced. */
  footer: { baseline: number; spaced: boolean };
  /** A list marker sits this far in from the text column; the text this far past the marker. */
  listIndent: number;
  markerWidth: number;
  /** The client company as pasted into the original: its own size and ink. */
  company?: { size: number; color: string };
}

const NAVY = '#002060';
const addr = (font: FontKey, size: number, baselines: number[]): HeadLine[] =>
  baselines.map((baseline) => ({ font, size, bold: true, color: '#000000', baseline }));

export const WORD_SKINS: Record<Exclude<EngagementTemplateId, 'jns-accounting'>, WordSkin> = {
  'jns-compliance': {
    size: 11, pitch: 13.63, gap: 2.03, blank: 17.7,
    top: [115.57, 93.67], bottom: 770, margin: 72,
    letterhead: {
      name: { font: 'segoe', size: 16, bold: true, color: NAVY, baseline: 31.2 },
      addr: addr('bell', 10, [43.0, 54.5, 65.8]),
      repeat: false,
    },
    footer: { baseline: 789.8, spaced: true },
    listIndent: 18, markerWidth: 18,
  },
  'jns-epr': {
    // The EPR PDF was rescaled on conversion (heights ~1.5% taller than set);
    // sizes are the true 11 / 12 / 14pt, pitches as measured on the sheet.
    size: 11, pitch: 13.4, pitchBySize: { '12': 13.8, '14': 16.1 }, gap: 2.1, blank: 17.9,
    company: { size: 10.5, color: '#212121' },
    top: [97.6, 17.2], bottom: 770, margin: 72,
    letterhead: {
      name: { font: 'times', size: 15.8, bold: true, color: NAVY, baseline: 28.5 },
      addr: addr('times', 10.1, [41.5, 53.0, 64.5]),
      repeat: false,
    },
    footer: { baseline: 790.2, spaced: false },
    listIndent: 18, markerWidth: 18,
  },
  'jns-accounting-services': {
    size: 11, pitch: 13.75, gap: 1.83, blank: 17.25,
    top: [108.2, 44.7], bottom: 770, margin: 72,
    letterhead: {
      name: { font: 'arial', size: 16, bold: true, color: NAVY, baseline: 29.0 },
      addr: addr('bell', 9.8, [43.0, 58.0, 73.0]),
      repeat: false,
    },
    footer: { baseline: 791.5, spaced: false },
    listIndent: 18, markerWidth: 18.5,
  },
  'jns-bookkeeping': {
    size: 11, pitch: 13.63, gap: 2.03, blank: 17.7,
    top: [121.37, 121.47], bottom: 770, margin: 72,
    letterhead: {
      name: { font: 'segoe', size: 16, bold: true, color: NAVY, baseline: 52.2 },
      addr: addr('bell', 10, [65.0, 76.2, 87.5]),
      repeat: true,
    },
    footer: { baseline: 789.8, spaced: true },
    listIndent: 18, markerWidth: 18,
  },
};

export function skinOf(templateId: string | null | undefined): WordSkin | null {
  return (WORD_SKINS as Record<string, WordSkin>)[templateId ?? ''] ?? null;
}

export const pitchOf = (skin: WordSkin, size?: number): number => {
  if (!size || size === skin.size) return skin.pitch;
  return skin.pitchBySize?.[String(size)] ?? Math.round(size * 1.16 * 100) / 100;
};

/** A4 in points. */
export const PAGE_PT = { w: 595.32, h: 841.92 };

// ── Template contents ─────────────────────────────────────────────────────

export interface TemplatePreset {
  subject: string;
  letterDate: string;
  company: CompanyInfo;
  recipient: Recipient;
  blocks: EBlock[];
  fees: FeeLine[];
  signatoryName: string;
  signatoryDesignation: string;
  clientSignatoryName: string;
  clientSignatoryDesignation: string;
}

export interface TemplateDef {
  id: EngagementTemplateId;
  name: string;
  /** What the letter covers, and which original it reproduces. */
  description: string;
  pages: number;
  build: () => TemplatePreset;
}

const blk = (key: EBlock['key'], extra: Partial<EBlock> = {}): EBlock => ({ id: bid(), key, enabled: true, ...extra });
const ln = (html: string, extra: Partial<Line> = {}): Line => newLine({ align: 'left', html, ...extra });
const para = (lines: Line[], extra: Partial<EBlock> = {}) => blk('paragraph', { lines, ...extra });
const section = (title: string, lines: Line[]) => blk('section', { title, lines });
const cell = (html: string, valign?: TableCell['valign'], padTop?: number): TableCell => ({ html, valign, padTop });

const JNS: CompanyInfo = { ...ENGAGEMENT_COMPANY, name: 'JNS Accounting Solutions', phone: '97900 39150' };

const P2_SAME = 'We are pleased to confirm our acceptance and our understanding of this engagement by means of this '
  + 'letter. The objective of this engagement is to help the organization maintain proper and timely set of '
  + 'books and records and help with the legal compliances relating to tax and accounting matters.';
const CONFIDENTIAL = 'We provide assurance that the information provided by you shall be very confidential and shall not be '
  + 'utilized for any other purposes or shared with any other persons except when required by law.';
const OTHER_SERVICES = 'Any other consultancy and other services shall be billed separately as and when the services are provided.';
const EFFECTIVE = 'The letter will be effective for future years unless it is terminated, amended or superseded.';
const CONFIRM = 'The above terms and conditions are agreed and confirmed by;';

/** Accounting & compliance — Engagement Letter - Celestivox Technologies. */
function compliance(): TemplatePreset {
  const g = WORD_SKINS['jns-compliance'].gap;
  return {
    subject: 'Engagement letter for accounting and compliance services',
    letterDate: '2024-08-01',
    company: JNS,
    recipient: {
      ...EMPTY_RECIPIENT,
      name: 'Shreyansh Pandey',
      designation: 'Director',
      companyName: 'Celestivox Technologies Private Limited,',
      address: 'Wework Berger Delhi One, Sector 16B, C-001/A2,\nNoida, Sector 16,\nNoida, Gautam Buddha Nagar,',
      state: 'Uttar Pradesh',
      pincode: '201 301',
    },
    blocks: [
      blk('letterhead'),
      blk('date', { dateFormat: 'd MMMM, yyyy', place: 'Uttar Pradesh', afterPt: g }),
      blk('recipient', { afterPt: 33.27 }),
      blk('subject'),
      blk('salutation', { body: 'Dear Sir,' }),
      para([ln('You have requested that we provide Accounting and Bookkeeping Services of {{company_name_caps}} for the '
        + 'Financial year starting from 1<sup>st</sup> August 2024 till end of 31<sup>st</sup> March 2025 including GST and TDS '
        + 'return filing, if applicable. This engagement does not include provision of payroll services and income tax filing services.')]),
      para([ln(P2_SAME)]),
      section('Responsibility of the management:', [ln('The responsibility of the management includes providing of sales, purchases and '
        + 'other related invoices, if any on a timely basis including bank and other loan statements. All the bills and other '
        + 'documents has to be provided within 1<sup>st</sup> to 6<sup>th</sup> of every month for smooth processing of all the compliances.')]),
      section('Confidentiality:', [ln(CONFIDENTIAL)]),
      section('Fees:', [ln('The fees would be billed as follows –', { after: g })]),
      blk('fees', { title: '', lines: [ln(OTHER_SERVICES)] }),
      blk('pagebreak'),
      para([ln('Out of the above services - the tax audit shall be carried on by L.Venkatasubbu and Co, Chartered '
        + 'Accountants situated in Coimbatore.')]),
      blk('closing', { lines: [
        ln('We look forward for you full cooperation with your staff and we also cordially thank in advance for the same.'),
        ln(EFFECTIVE),
        ln('Thanking you'),
      ] }),
      blk('signature', { body: 'Yours truly,', gapPt: 54.37, rule: true, ruleGapPt: 1.2, afterPt: 17.47 }),
      blk('confirmation', { body: CONFIRM, showCompany: false }),
    ],
    fees: [
      newFee({ service: 'Accounting and GST Filing', frequency: 'per month', amountText: '2,000' }),
      newFee({ service: 'TDS Filing', frequency: 'per quarter', amountText: '1,500', billingBasis: 'per return type' }),
      newFee({ service: 'Income tax return and tax audit', frequency: 'per year', amountText: '20,000' }),
      newFee({ service: 'Annual Return and MCA compliances', frequency: 'per year', amountText: '15,000' }),
    ],
    signatoryName: 'Nandhini .N',
    signatoryDesignation: 'Proprietor',
    clientSignatoryName: '',
    clientSignatoryDesignation: '',
  };
}

/** EPR registration — Engagement Letter - EPR Registration. */
function epr(): TemplatePreset {
  const s = WORD_SKINS['jns-epr'];
  const g = s.gap;
  const big = (html: string, extra: Partial<Line> = {}) => ln(html, { size: 12, ...extra });
  const doc = (html: string, after: number, pad?: number) => big(html, { after, pad });
  // Word's Symbol-font bullet at 15.8pt, then two spaces — as typed in the original.
  const note = (html: string, after: number) => big(`  ${html}`, { marker: '•', pad: 2.2, after });
  return {
    subject: 'Engagement letter for EPR Registration',
    letterDate: '2025-07-30',
    company: { ...JNS, phone: '93639 93765' },
    recipient: {
      ...EMPTY_RECIPIENT,
      companyName: 'SPM SUBSTRATES PRIVATE LIMITED',
      address: 'SF No. 230, Thenkumarapalayam, TK Palayam,\nPollachi,\nTamil Nadu',
    },
    blocks: [
      blk('letterhead'),
      blk('date', { dateFormat: 'do MMMM yyyy', place: 'Coimbatore', bold: true, afterPt: g }),
      blk('recipient', { afterPt: 17.9 }),
      blk('subject', { afterPt: 18.0 }),
      blk('salutation', { body: 'Dear Sir,', afterPt: 18.2 }),
      para([
        ln('You have requested that we provide EPR services of {{company_name_caps}} for the Financial year starting from July 2025.', { after: 14.9 }),
        big('Extended Producer Responsibility (EPR) is a regulatory framework under the Plastic Waste Management Rules, 2016 '
          + '(as amended in 2022) which mandates that Producers, Importers, and Brand Owners (PIBOs) are responsible for '
          + 'managing plastic waste generated due to their products.', { after: 14.0 }),
        big('EPR ensures that producers take responsibility for the environmental impact of their products, especially '
          + 'plastic packaging waste, throughout their life cycle.', { after: 14.2 }),
        big('EPR Registration is mandatory for the following entities:', { after: 13.7 }),
        big('Producers of plastic packaging (including those selling under own brand).', { kind: 'number', after: 0 }),
        big('Importers of plastic-packaged goods or plastic packaging.', { kind: 'number', after: 0 }),
        big('Brand Owners (including online marketplaces and aggregators).', { kind: 'number', after: 0 }),
        big('Plastic Waste Processors (PWPs) involved in recycling, waste-to-energy, co-processing, etc.', { kind: 'number', after: 13.8 }),
        ln('Documents Required for EPR Registration', { after: g - 0.1 }),
        ln('Kindly provide us the below documents for commencement of the work --', { after: 5.3 }),
        doc('GST Certificate', 4.6),
        doc('PAN Card of Company/Firm', 4.2),
        doc('CIN/LLPIN and Certificate of Incorporation (for companies)', 4.5),
        doc('Authorised Signatory Aadhaar &amp; PAN Card', 4.6),
        doc('IEC Certificate (for Importers)', 4.6),
        doc('Product Details with Plastic Category (I to IV)', 4.5),
        doc('Manufacturing/Import/Brand Ownership Declaration Letter', 4.6),
        doc('DIC/UDYAM Certificate (if MSME)', 4.9),
        doc('Board Resolution/Authorisation Letter for Signatory', 3.2, 2.2),
        doc('For PWPs (Plastic Waste Processors)', 3.2, 2.2),
      ]),
      blk('pagebreak'),
      para([
        doc('PAN, GST, and CIN/LLPIN', 2.8, 2.2),
        doc('Consent to Operate (from SPCB/PCC)', 3.1, 2.2),
        doc('Recycling/Waste-to-energy license', 3.1, 2.2),
        doc('Details of Plant Capacity and Machinery', 2.8, 2.2),
        doc('Process Flow Diagram', 3.1, 2.2),
        doc('Site Photos', 27.9, 2.2),
        ln('Filing Frequency and Compliance Requirements', { size: 14, pad: 2.2, after: 3.0 }),
      ]),
      blk('table', {
        afterPt: 18.6,
        table: {
          cols: [171.5, 194.9, 84.9],
          head: ['Task', 'Frequency', 'Platform'],
          heights: [24, 40, 36.4, 26.4, 89],
          rows: [
            [cell('Annual EPR Filing'), cell('Annually (by 30th June for previous FY)'), cell('CPCB EPR<br>Portal')],
            [cell('Quarterly Returns <i>(Optional but recommended)</i>'), cell('Every Quarter (esp. for large PIBOs)'), cell('CPCB/SPCB')],
            [cell('EPR Action Plan Submission'), cell('Once during Registration'), cell('CPCB Portal')],
            [cell('Annual Fulfilment Report'), cell('Every FY (with evidence of plastic waste management)'), cell('CPCB Portal', 'top', 5.3)],
          ],
        },
      }),
      para([ln('Estimated Government Fees for EPR Registration', { size: 14, pad: 2.2, after: 1.2 })]),
      blk('table', {
        afterPt: 20.1,
        table: {
          cols: [199, 97],
          pad: [4.7, 0],
          head: ['Category of Entity', 'Estimated Fees (₹)'],
          heights: [24.6, 24.6, 24.6, 24.6, 24.6],
          rows: [
            [cell('Micro/Small Enterprise (Turnover &lt; ₹5 Cr)'), cell('₹5,000 to ₹10,000')],
            [cell('Medium Enterprise (₹5 Cr - ₹250 Cr)'), cell('₹20,000 to ₹40,000')],
            [cell('Large Enterprise (Turnover &gt; ₹250 Cr)'), cell('₹50,000 to ₹1,00,000')],
            [cell('Plastic Waste Processors'), cell('₹10,000 to ₹25,000')],
          ],
        },
      }),
      para([
        note('Registration is valid for 1 year and must be renewed annually.', 14.0),
        note('Non-compliance may lead to penalties, ban on sales, or cancellation of registration.', 13.9),
        note('A company must submit evidence of plastic waste collection and processing (through registered recyclers, ULB tie-ups, etc.).', 14.0),
        note('Categories of plastic packaging (I to IV) must be clearly declared:', 13.9),
        big('I – Rigid Plastic', { kind: 'bullet', pad: 2.2, after: 0 }),
        big('II – Flexible Plastic (single layer)', { kind: 'bullet', pad: 2.2, after: 0 }),
        big('III – Multi-layered Plastic (MLP)', { kind: 'bullet', pad: 2.2, after: 0 }),
        big('IV – Compostable Plastics', { kind: 'bullet', pad: 2.2, after: 0 }),
      ]),
      blk('pagebreak'),
      blk('spacer', { heightPx: 18 }),
      blk('closing', { lines: [ln(EFFECTIVE, { after: 17.9 }), ln('Thanking you', { after: 18.0 })] }),
      blk('signature', { body: 'Yours truly,', gapPt: 33.4, rule: true, ruleGapPt: 1.7, afterPt: 86.5 }),
      blk('confirmation', { body: CONFIRM, showCompany: true }),
    ],
    fees: [],
    signatoryName: 'Nandhini .N',
    signatoryDesignation: 'Proprietor',
    clientSignatoryName: '',
    clientSignatoryDesignation: 'Partner',
  };
}

/** Accounting services — Engagement Letter - Nellai Agro Tech Farms. */
function accountingServices(): TemplatePreset {
  const s = WORD_SKINS['jns-accounting-services'];
  const j = (html: string, extra: Partial<Line> = {}) => ln(html, { align: 'justify', ...extra });
  const item = (html: string) => j(html, { kind: 'bullet', marker: '-', after: 0 });
  return {
    subject: 'Engagement letter for accounting services',
    letterDate: '2025-06-02',
    company: { ...JNS, phone: '93639 93765' },
    recipient: {
      ...EMPTY_RECIPIENT,
      name: 'Mr. R.C. Suresh',
      designation: 'Partner',
      companyName: 'Nellai Agro Tech Farms',
      address: 'Soorangudi, Nanguneri Taluk\nTirunelveli,\nTamil Nadu',
    },
    blocks: [
      blk('letterhead'),
      blk('date', { dateFormat: 'ddo MMMM yyyy', place: 'Coimbatore', afterPt: s.gap + 0.4 }),
      blk('recipient', { afterPt: 17.75 }),
      blk('subject', { afterPt: 17.25 }),
      blk('salutation', { body: 'Dear Sir,', afterPt: 17.75 }),
      para([j('You have requested that we provide Accounting services of <b>{{company_name_caps}}</b> for the Financial year '
        + 'starting from August 2022. This engagement does not include provision of GST, TDS, payroll services, income tax '
        + 'filing or any compliance services.', { after: 17.25 })]),
      para([j('We are pleased to confirm our acceptance and our understanding of this engagement by means of this letter. '
        + 'The objective of this engagement is to help the organization maintain a proper and timely set of books and '
        + 'records and help with the legal compliances relating to tax and accounting matters.', { after: 17.75 })]),
      section('Responsibility of the management:', [j('The responsibility of the management includes providing of sales, '
        + 'purchases and other related invoices, if any on a timely basis including bank and other loan statements. All the '
        + 'bills and other documents have to be provided on the last day of every month for smooth processing of all the '
        + 'compliances.', { after: 17.75 })]),
      section('Confidentiality:', [j(CONFIDENTIAL, { after: 17.75 })]),
      blk('fees', { title: 'Fees:', lines: [], afterPt: 17.25 }),
      para([
        j('The above fees shall be for accounting and bookkeeping which includes maintaining of purchase bills, sales bills, '
          + 'stock and Bank reconciliation.', { after: 2.25 }),
        j('We shall provide you with a monthly report in relation to Sales, Purchases and Expenses', { after: 1.75 }),
        j('All the above reports along with monthly comparison shall be sent by 7th of next month.', { after: 17.75 }),
        j('We shall also conduct a personal visit on a quarterly basis for an additional charge of Rs. 5,000 per quarter '
          + '(If required and agreed upon)'),
      ]),
      blk('pagebreak'),
      para([j(OTHER_SERVICES, { after: 17.75 })]),
      section('Required documents for commencement:', [
        j('Kindly provide us the below documents for commencement of the work --', { after: 1.75 }),
        item('All partners - PAN, Adhaar, Phone number and Mail id'),
        item('Partnership deed and Partnership PAN'),
        item('Audited or Signed financial statements of March 2022'),
        item('Provisional statements till July 2022 (If any data backup is available, kindly provide us the same)'),
        item('Vouchers and bills from August 2022 till date'),
        item('All bank statements from August 2022 till May 2025'),
        { ...item('Ledger or cash book scanned copy (if any maintained)'), after: 17.75 },
      ]),
      para([j('You shall pay an advance of Rs. 5,000 along with the first set of bills for commencing the work.', { after: 17.75 })]),
      blk('closing', { lines: [
        j('We look forward to your full cooperation with you and we also cordially thank you in advance for the same.', { after: 17.25 }),
        j(EFFECTIVE, { after: 17.75 }),
        j('Thanking you', { after: 17.25 }),
      ] }),
      blk('signature', { body: 'Yours truly,', gapPt: 33.25, rule: true, ruleGapPt: 17.0, afterPt: 16.7 }),
      blk('confirmation', { body: CONFIRM, showCompany: true }),
    ],
    fees: [newFee({ service: 'The fees would be billed as follows', frequency: 'per month', amountText: '1,000' })],
    signatoryName: 'Nandhini .N',
    signatoryDesignation: 'Proprietor',
    clientSignatoryName: '',
    clientSignatoryDesignation: '',
  };
}

/** Bookkeeping services — Engagement Letter - Nirmala Traders. */
function bookkeeping(): TemplatePreset {
  const g = WORD_SKINS['jns-bookkeeping'].gap;
  return {
    subject: 'Engagement letter for bookkeeping services',
    letterDate: '2023-06-02',
    company: { ...JNS, name: 'JNS Accounting and Taxation services' },
    recipient: {
      ...EMPTY_RECIPIENT,
      name: 'Vivek Jalkhare',
      designation: 'Proprietor',
      companyName: 'Nirmala Traders',
      address: 'Rahi Chowk, Near Gaytri Mandir,\nSeoni, Malwa,\nMadhya Pradesh – 461 223\nBanlag, Solan,\nHimachal Pradesh – 173 206',
    },
    blocks: [
      blk('letterhead'),
      blk('date', { dateFormat: 'd MMMM, yyyy', place: 'Coimbatore, Tamil Nadu', afterPt: g }),
      blk('recipient', { afterPt: 33.37 }),
      blk('subject'),
      blk('salutation', { body: 'Dear Sir,' }),
      para([ln('You have requested that we provide book keeping services for {{company_name}} for the Financial year '
        + 'starting from 1<sup>st</sup> April, 2023 till end of 31<sup>st</sup> March 2024. We understand that we have to provide the '
        + 'sales, purchase records for GST filing and monthly accounts receivable balance. This engagement does not include '
        + 'provision of GST, TDS Filings, payroll services and income tax filing services.')]),
      para([ln(P2_SAME)]),
      section('Responsibility of the management:', [ln('The responsibility of the management includes providing of sales, purchases and '
        + 'other related invoices, if any on a timely basis including bank and other loan statements. All the bills and other '
        + 'documents has to be provided every Wednesday and Saturday for smooth processing of all the compliances.')]),
      section('Confidentiality:', [ln(CONFIDENTIAL)]),
      section('Fees:', [ln('The fees would be billed as follows –', { after: g })]),
      blk('fees', { title: '', lines: [ln(OTHER_SERVICES)] }),
      blk('pagebreak'),
      blk('closing', { lines: [
        ln('We look forward for you full cooperation with your staff and we also cordially thank in advance for the same.'),
        ln(EFFECTIVE),
        ln('Thanking you'),
      ] }),
      blk('signature', { body: 'Yours truly,', gapPt: 33.37, rule: true, ruleGapPt: 1.5, afterPt: 17.07 }),
      blk('confirmation', { body: CONFIRM, showCompany: false }),
    ],
    fees: [newFee({ service: 'Maintenance of accounts [in Tally]', frequency: 'per month', amountText: '1,000' })],
    signatoryName: 'Nandhini .N',
    signatoryDesignation: 'Proprietor',
    clientSignatoryName: '',
    clientSignatoryDesignation: '',
  };
}

/** The builder's original template, unchanged. */
function standard(): TemplatePreset {
  return {
    subject: 'Engagement letter for accounting and compliance services',
    letterDate: new Date().toISOString().slice(0, 10),
    company: ENGAGEMENT_COMPANY,
    recipient: EMPTY_RECIPIENT,
    blocks: defaultBlocks(),
    fees: DEFAULT_FEES(),
    signatoryName: 'Nandhini .N',
    signatoryDesignation: 'Proprietor',
    clientSignatoryName: '',
    clientSignatoryDesignation: '',
  };
}

export const TEMPLATES: TemplateDef[] = [
  { id: 'jns-accounting', name: 'Standard', description: 'The builder’s original letter — accounting, GST and TDS, with a fee schedule.', pages: 2, build: standard },
  { id: 'jns-compliance', name: 'Accounting & compliance', description: 'Accounting, GST and TDS filing — as the Celestivox Technologies letter.', pages: 2, build: compliance },
  { id: 'jns-epr', name: 'EPR registration', description: 'Plastic-waste EPR registration, with document list and fee tables — as the SPM Substrates letter.', pages: 3, build: epr },
  { id: 'jns-accounting-services', name: 'Accounting services', description: 'Accounting only, with required documents and advance — as the Nellai Agro Tech Farms letter.', pages: 2, build: accountingServices },
  { id: 'jns-bookkeeping', name: 'Bookkeeping services', description: 'Bookkeeping for GST records, letterhead on every page — as the Nirmala Traders letter.', pages: 2, build: bookkeeping },
];

export const templateOf = (id: string | null | undefined): TemplateDef =>
  TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
