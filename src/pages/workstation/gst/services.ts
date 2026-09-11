/**
 * GST service catalogue.
 *
 * Single source of truth for the eight services listed in
 * docs/gst-services/README.md. Consumed by both the landing grid and the
 * per-service handoff detail page.
 *
 * Per spec §1 ("How the redirect actually works for gst.gov.in"), most
 * GST portal pages are session-based and login-gated — a deep link bounces
 * to login and loses the destination. So for post-login services we open
 * the portal root and rely on the click-path breadcrumb. Only pre-login
 * pages (new Registration, track status, the e-invoice IRP) get a real
 * deep link.
 */
import {
  BookMarked,
  CalendarClock,
  ClipboardCheck,
  Coins,
  FileMinus,
  FilePlus2,
  FileText,
  Gavel,
  LogOut,
  RefreshCcw,
  ScrollText,
  Shield,
  type LucideIcon,
} from 'lucide-react';

export type Shape = 'recurring' | 'project' | 'externally-triggered' | 'retainer';

export interface GstService {
  slug: string;
  name: string;
  form: string;
  shape: Shape;
  icon: LucideIcon;
  summary: string;
  /** Path a user clicks through inside the portal after login. */
  navPath: string[];
  portalUrl: string;
  portalLabel: string;
  preLogin: boolean;
  /** What the firm actually does — richer text for the detail page. */
  detail: string;
  /** Field-sheet placeholder rows shown on the detail page. */
  fieldSheet?: { label: string; hint?: string }[];
  /** Values the firm captures back after the portal step (spec §5). */
  capture?: { key: string; label: string; required?: boolean }[];
}

export const SHAPE_TINT: Record<Shape, { bg: string; fg: string; label: string }> = {
  recurring:              { bg: '#E7F5EE', fg: '#166534', label: 'Recurring' },
  project:                { bg: '#E6EEFC', fg: '#1D4ED8', label: 'Project' },
  'externally-triggered': { bg: '#FDE7EA', fg: '#B91C1C', label: 'Externally triggered' },
  retainer:               { bg: '#EEF0F3', fg: '#475569', label: 'Retainer' },
};

const GST_ROOT = 'https://www.gst.gov.in/';
const EINVOICE_PORTAL = 'https://einvoice1.gst.gov.in/';

export const GST_SERVICES: GstService[] = [
  {
    slug: 'registration',
    name: 'Registration',
    form: 'REG-01',
    shape: 'project',
    icon: BookMarked,
    summary:
      'Get a client a GSTIN. Part A (OTP) → Part B (business, promoters, place, HSN) → Aadhaar auth or physical verification. Outcome: REG-06 certificate.',
    navPath: ['Services', 'Registration', 'New Registration'],
    portalUrl: 'https://reg.gst.gov.in/registration/',
    portalLabel: 'GST Portal – New Registration',
    preLogin: true,
    detail:
      'Collect and verify documents, get the business constitution and place-of-business proof right, choose HSN codes sensibly, and handle Form REG-03 if the officer raises a query — REG-04 reply window is short and missing it means the application is rejected and you start over.',
    fieldSheet: [
      { label: 'PAN of business', hint: 'From the client’s incorporation record' },
      { label: 'Authorised signatory Aadhaar', hint: 'Aadhaar auth avoids site visit' },
      { label: 'Principal place of business', hint: 'Address + proof (rent agreement / ownership)' },
      { label: 'Bank account', hint: 'Cancelled cheque / passbook' },
      { label: 'HSN / SAC codes', hint: 'Aligned with the client’s trade' },
    ],
    capture: [
      { key: 'trn', label: 'TRN', required: true },
      { key: 'arn', label: 'ARN', required: true },
      { key: 'ack', label: 'Acknowledgement document', required: true },
    ],
  },
  {
    slug: 'return-filing',
    name: 'Return Filing',
    form: 'GSTR-1 / 3B / CMP-08',
    shape: 'recurring',
    icon: RefreshCcw,
    summary:
      'The recurring core. GSTR-1 (outward), GSTR-3B (summary, tax paid), CMP-08 (composition). GSTR-2B reconciled by the Audit Automation module.',
    navPath: ['Services', 'Returns', 'Returns Dashboard'],
    portalUrl: GST_ROOT,
    portalLabel: 'GST Portal – Return Filing',
    preLogin: false,
    detail:
      'GSTR-1 reports outward supplies. GSTR-3B is the summary return where tax is actually paid. GSTR-2B is the system-generated ITC statement reconciled against purchases — that reconciliation happens in the Audit Automation module and the return service consumes the finalised figure.',
    fieldSheet: [
      { label: 'Return period', hint: 'e.g., April 2026' },
      { label: 'Outward supply figures (from GSTR-1 workings)' },
      { label: 'ITC available (from reconciled GSTR-2B)' },
      { label: 'Tax payable summary' },
    ],
    capture: [
      { key: 'arn', label: 'ARN', required: true },
      { key: 'filed_at', label: 'Filed timestamp' },
    ],
  },
  {
    slug: 'annual-return',
    name: 'Annual Return Filing',
    form: 'GSTR-9 / 9C',
    shape: 'recurring',
    icon: CalendarClock,
    summary:
      'Consolidates the FY: outward supplies, ITC, tax paid, amendments. GSTR-9C reconciles books to GSTR-9 above the threshold. Due 31 Dec [VERIFY].',
    navPath: ['Services', 'Returns', 'Annual Return'],
    portalUrl: GST_ROOT,
    portalLabel: 'GST Portal – Annual Return',
    preLogin: false,
    detail:
      'Reconcile twelve months of GSTR-1 and GSTR-3B against the books, explain every difference, and correct what can still be corrected. This is real work — mismatches accumulated across the year surface here, and it is the return most likely to attract scrutiny later.',
    fieldSheet: [
      { label: 'Financial year' },
      { label: 'Annualised outward supplies' },
      { label: 'ITC claimed vs 2B (reconciliation notes)' },
      { label: 'Amendments summary' },
    ],
    capture: [
      { key: 'arn', label: 'ARN', required: true },
      { key: 'reconciliation_pdf', label: 'GSTR-9C reconciliation PDF' },
    ],
  },
  {
    slug: 'notice-reply',
    name: 'Notice Reply',
    form: 'varies',
    shape: 'externally-triggered',
    icon: ClipboardCheck,
    summary:
      'REG-03 → REG-04, ASMT-10 → ASMT-11, DRC-01 → DRC-06, and more. Deadline comes from the notice, not the calendar. Weekly discovery task per client is the real value.',
    navPath: ['Services', 'User Services', 'View Additional Notices and Orders'],
    portalUrl: GST_ROOT,
    portalLabel: 'GST Portal – Notices & Orders',
    preLogin: false,
    detail:
      'The operational problem is not the reply. It is knowing the notice exists — the portal does not push notifications reliably, and a missed ASMT-10 becomes a DRC-01 becomes a demand order. A weekly scheduled task per client to check the notices tab is the highest-value single feature in this module.',
    fieldSheet: [
      { label: 'Notice reference number' },
      { label: 'Notice type (REG-03 / ASMT-10 / DRC-01 / …)' },
      { label: 'Reply due date (from the notice itself)' },
      { label: 'Reply draft (per notice format)' },
    ],
    capture: [
      { key: 'reply_arn', label: 'Reply ARN', required: true },
      { key: 'notice_pdf', label: 'Original notice PDF' },
      { key: 'reply_pdf', label: 'Filed reply PDF' },
    ],
  },
  {
    slug: 'amendment',
    name: 'Amendment',
    form: 'REG-14',
    shape: 'project',
    icon: FileText,
    summary:
      'Core fields (legal name, place, partners) need officer approval. Non-core (bank, contact) auto-approve. PAN / state changes are new registration + cancellation, not amendments.',
    navPath: ['Services', 'Registration', 'Amendment of Registration Core / Non-Core Fields'],
    portalUrl: GST_ROOT,
    portalLabel: 'GST Portal – Registration Amendment',
    preLogin: false,
    detail:
      'The distinction between core and non-core fields must be obvious before submission — a client expecting an instant change to their trade name will be surprised. Some things cannot be amended at all: PAN or state changes require new registration + cancellation of the old one.',
    fieldSheet: [
      { label: 'Field to amend', hint: 'Core or non-core?' },
      { label: 'Old value', hint: 'Shown alongside new so the operator sees what they are replacing' },
      { label: 'New value' },
      { label: 'Supporting document (if core field)' },
    ],
    capture: [
      { key: 'arn', label: 'ARN', required: true },
    ],
  },
  {
    slug: 'cancellation',
    name: 'Cancellation',
    form: 'REG-16',
    shape: 'project',
    icon: FileMinus,
    summary:
      'Surrender a GSTIN. REG-16 → officer review → REG-19 order. Don’t forget GSTR-10 final return within the window, and REG-21 revocation if suo-moto.',
    navPath: ['Services', 'Registration', 'Application for Cancellation'],
    portalUrl: GST_ROOT,
    portalLabel: 'GST Portal – Registration / Cancellation',
    preLogin: false,
    detail:
      'All returns up to the cancellation date must be filed first — the case should block until they are. Two things people forget: GSTR-10 (final return) within the window after cancellation, and REG-21 revocation within a short window if the department cancelled suo-moto.',
    fieldSheet: [
      { label: 'Reason for cancellation', hint: 'Business closure / turnover below threshold / merger / transfer' },
      { label: 'Cancellation effective date' },
      { label: 'Confirmation that all pending returns are filed' },
    ],
    capture: [
      { key: 'arn', label: 'Cancellation ARN', required: true },
      { key: 'reg19_order', label: 'REG-19 order (when issued)' },
    ],
  },
  {
    slug: 'lut-filing',
    name: 'LUT Filing',
    form: 'RFD-11',
    shape: 'recurring',
    icon: ScrollText,
    summary:
      'Letter of Undertaking — exporter ships without paying IGST upfront. Filed annually at the start of each FY. Small, easy, high-value; just don’t forget April.',
    navPath: ['Services', 'User Services', 'Furnish Letter of Undertaking'],
    portalUrl: GST_ROOT,
    portalLabel: 'GST Portal – LUT Services',
    preLogin: false,
    detail:
      'Model as a recurring annual obligation and it never gets missed — which is exactly the kind of thing a client notices. Needs two witnesses with names, addresses and occupations. Not carried forward — a fresh LUT every April.',
    fieldSheet: [
      { label: 'Financial year' },
      { label: 'Witness 1: name, address, occupation' },
      { label: 'Witness 2: name, address, occupation' },
    ],
    capture: [
      { key: 'arn', label: 'ARN', required: true },
      { key: 'lut_pdf', label: 'Filed LUT PDF' },
    ],
  },
  {
    slug: 'e-invoicing',
    name: 'E-Invoicing Support',
    form: '—',
    shape: 'retainer',
    icon: Shield,
    summary:
      'Ongoing support once turnover crosses the threshold. Every B2B / export invoice must get an IRN + signed QR from an IRP. E-invoice data auto-populates GSTR-1.',
    navPath: [],
    portalUrl: EINVOICE_PORTAL,
    portalLabel: 'GST E-Invoice Portal',
    preLogin: true,
    detail:
      'Determine applicability when turnover crosses the threshold, help set up the client’s billing software or IRP access, and handle the operational edges — cancellation is only permitted within a short window after generation, and errors flow straight into GSTR-1 so catching them at generation matters more than at filing.',
    fieldSheet: [
      { label: 'Client IRP account status' },
      { label: 'Billing software / integration in use' },
      { label: 'Rolling issue log (IRN failures, cancellations, credit-note remedies)' },
    ],
  },

  // ── Spec §6 — missing from the competitor menu ─────────────────────────
  {
    slug: 'refund',
    name: 'Refund',
    form: 'RFD-01',
    shape: 'project',
    icon: Coins,
    summary:
      'Exporters with LUT, inverted duty structure, excess cash ledger balance. Frequently needed by the same exporter clients who need LUT.',
    navPath: ['Services', 'Refunds', 'Application for Refund'],
    portalUrl: GST_ROOT,
    portalLabel: 'GST Portal – Refunds',
    preLogin: false,
    detail:
      'Choose the refund type (export with / without payment of IGST, inverted duty, excess balance), assemble the statement (invoice-wise export register or ITC accumulation working), file RFD-01 and track through provisional (RFD-04) and final (RFD-06). Bank realisation certificate for export refunds is the operational catch.',
    fieldSheet: [
      { label: 'Refund type', hint: 'Export with / without IGST · Inverted duty · Excess cash' },
      { label: 'Tax period(s) covered' },
      { label: 'Statement of invoices / BRC references' },
      { label: 'Bank account for refund credit' },
    ],
    capture: [
      { key: 'arn',        label: 'ARN',                required: true },
      { key: 'rfd06_pdf',  label: 'RFD-06 final order' },
    ],
  },
  {
    slug: 'appeal',
    name: 'Appeal',
    form: 'APL-01',
    shape: 'externally-triggered',
    icon: Gavel,
    summary:
      'When a demand order is unfavourable. Strict time limit from the order date, with a pre-deposit requirement. Project shape, externally triggered — same as Notice Reply.',
    navPath: ['Services', 'User Services', 'My Applications', 'Appeal to Appellate Authority'],
    portalUrl: GST_ROOT,
    portalLabel: 'GST Portal – Appeals',
    preLogin: false,
    detail:
      'Time limit runs from the order date [VERIFY]. Pre-deposit (typically 10% of disputed tax) must be paid before the appeal is admitted. Grounds of appeal, statement of facts and any additional evidence go in the annexures — get the statement of facts right, everything else follows.',
    fieldSheet: [
      { label: 'Order under appeal', hint: 'Order number, date, issuing authority' },
      { label: 'Disputed tax / interest / penalty (paise, per head)' },
      { label: 'Pre-deposit paid', hint: 'DRC-03 challan reference' },
      { label: 'Grounds of appeal' },
      { label: 'Statement of facts' },
    ],
    capture: [
      { key: 'arn',         label: 'Appeal ARN',       required: true },
      { key: 'apl02_ack',   label: 'APL-02 acknowledgement' },
    ],
  },
  {
    slug: 'composition-opt-in',
    name: 'Composition scheme opt-in',
    form: 'CMP-02',
    shape: 'recurring',
    icon: FilePlus2,
    summary:
      'Annual window at the start of the financial year. Small but easy to miss for eligible clients — turnover threshold and business type matter.',
    navPath: ['Services', 'Registration', 'Application to Opt for Composition Levy'],
    portalUrl: GST_ROOT,
    portalLabel: 'GST Portal – Opt for Composition',
    preLogin: false,
    detail:
      'CMP-02 must be filed before the FY starts to opt into the composition scheme for that year. Confirm the client is eligible (turnover below threshold, not a service provider above the service limit, not an inter-state supplier) before filing — an ineligible opt-in triggers recovery of tax with interest.',
    fieldSheet: [
      { label: 'Financial year' },
      { label: 'Turnover in preceding FY' },
      { label: 'Nature of supplies', hint: 'Goods · Restaurant · Services under §10(2A)' },
    ],
    capture: [
      { key: 'arn', label: 'ARN', required: true },
    ],
  },
  {
    slug: 'composition-opt-out',
    name: 'Composition scheme opt-out',
    form: 'CMP-04',
    shape: 'recurring',
    icon: LogOut,
    summary:
      'Withdraw from composition — voluntary, or forced when turnover crosses the threshold. Requires ITC-01 to claim ITC on stock held on the switch-over date.',
    navPath: ['Services', 'Registration', 'Application for Withdrawal from Composition Levy'],
    portalUrl: GST_ROOT,
    portalLabel: 'GST Portal – Withdraw from Composition',
    preLogin: false,
    detail:
      'CMP-04 is the withdrawal application. It takes effect from the date recorded in the form. Don’t forget ITC-01 within the prescribed window to reclaim ITC on inputs / semi-finished / finished goods held on the switch-over date — this is where working capital gets recovered.',
    fieldSheet: [
      { label: 'Effective date of withdrawal' },
      { label: 'Reason', hint: 'Voluntary · Turnover crossed · Ineligible supplies started' },
      { label: 'ITC-01 stock statement', hint: 'Filed within the prescribed window post-switch' },
    ],
    capture: [
      { key: 'arn',      label: 'ARN',               required: true },
      { key: 'itc01_arn', label: 'ITC-01 ARN' },
    ],
  },
];

export function findGstService(slug: string): GstService | undefined {
  return GST_SERVICES.find((s) => s.slug === slug);
}
