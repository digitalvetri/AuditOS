/**
 * TDS sub-service catalogue.
 *
 * Six rows per the TDS-PAGE-PROMPT spec. Each entry mirrors the GST
 * services.ts shape — portal URL, click path, field sheet, capture schema.
 * Any TDS-specific guardrails (SPICe+ block, TRACES-needs-filed-return
 * caveat, correction requires original token, etc.) live on the entry as
 * additional flags/notes the handoff screen consumes.
 *
 * All dates and thresholds come from config.ts. Zero literals here.
 */
import {
  BellRing,
  Coins,
  FileMinus,
  FilePlus2,
  IdCard,
  RefreshCcw,
  type LucideIcon,
} from 'lucide-react';

export type TdsSubServiceSlug =
  | 'registration'
  | 'challan-payment'
  | 'return-filing'
  | 'correction-filing'
  | 'form-16'
  | 'notices';

export interface TdsSubService {
  slug: TdsSubServiceSlug;
  name: string;
  form: string;
  icon: LucideIcon;
  summary: string;
  /** Portal handoff config. */
  portal: {
    url: string;
    label: string;
    navPath: string[];
    preLogin: boolean;
    note?: string;
  };
  /** Additional handoff — some services (§3.3) require a small side-quest
   *  to fetch a supporting artifact first. */
  auxHandoff?: {
    label: string;
    url: string;
    navPath: string[];
    note?: string;
  };
  /** Field sheet — labels the operator will fill on the portal. */
  fieldSheet: { label: string; hint?: string; limit?: number }[];
  /** What comes back after portal step completes. */
  capture: { key: string; label: string; required?: boolean; pattern?: 'tan' | 'reg_ack_14'; hint?: string }[];
  /** Row-level guardrail flags the handoff screen enforces:
   *  - registration.disableWhenIncorporating: SPICe+ path already covers this.
   *  - form16.requiresFiledReturn: greyed unless a return exists.
   *  - correction.requiresOriginalToken: greyed unless an original token exists.
   *  - registration.requiresTracesRegistrationCaveat: show the "TRACES
   *    registration needs a filed return first" note.
   */
  guards?: {
    disableWhenIncorporating?: boolean;
    requiresFiledReturn?: boolean;
    requiresOriginalToken?: boolean;
    showTracesRegistrationCaveat?: boolean;
  };
}

const PROTEAN_TIN = 'https://tin.tin.proteantech.in/';
const EFILING = 'https://www.incometax.gov.in/';
const TRACES = 'https://www.tdscpc.gov.in/';

export const TDS_SUB_SERVICES: TdsSubService[] = [
  {
    slug: 'registration',
    name: 'TDS Registration',
    form: 'Form 49B',
    icon: IdCard,
    summary:
      'Obtain a TAN for a client that does not have one. Skip when the client is incorporating — PAN and TAN come through SPICe+ automatically.',
    portal: {
      url: PROTEAN_TIN,
      label: 'Protean TIN portal',
      navPath: ['Services', 'TAN', 'Apply Online', 'New TAN (Form 49B)'],
      preLogin: true,
      note: 'This is the Protean portal, NOT incometax.gov.in. People get this wrong constantly.',
    },
    fieldSheet: [
      { label: 'Entity PAN' },
      { label: 'Responsible person name', limit: 75 },
      { label: 'Responsible person designation' },
      { label: 'Responsible person PAN' },
      { label: 'Responsible person email' },
      { label: 'Responsible person mobile' },
      { label: 'Flat / door / block no.', limit: 25 },
      { label: 'Building name', limit: 25 },
      { label: 'Road / street', limit: 50 },
      { label: 'Area / locality', limit: 25 },
      { label: 'City / district', limit: 25 },
      { label: 'Pin code', limit: 6 },
      { label: 'AO code', hint: 'Area code · AO type · Range code · AO number' },
    ],
    capture: [
      { key: 'ack', label: '14-digit acknowledgement number', required: true, pattern: 'reg_ack_14' },
      { key: 'submission_date', label: 'Submission date', required: true },
      { key: 'fee_paid', label: 'Fee paid' },
      { key: 'ack_pdf', label: 'Acknowledgement PDF', required: true },
      { key: 'tan', label: 'TAN (once allotted)', pattern: 'tan', hint: '4 letters, 5 digits, 1 letter' },
    ],
    guards: {
      disableWhenIncorporating: true,
    },
  },
  {
    slug: 'challan-payment',
    name: 'Challan Payment',
    form: 'ITNS 281',
    icon: Coins,
    summary:
      'Monthly deposit of deducted tax. Firm enters the amount — this screen tracks and captures, it does not calculate.',
    portal: {
      url: EFILING,
      label: 'e-Pay Tax',
      navPath: ['e-File', 'e-Pay Tax'],
      preLogin: false,
    },
    fieldSheet: [
      { label: 'Assessment year' },
      { label: 'TAN' },
      { label: 'Type of payment', hint: 'TDS · TCS' },
      { label: 'Nature of payment / section' },
      { label: 'Amount — tax' },
      { label: 'Amount — surcharge' },
      { label: 'Amount — cess' },
      { label: 'Amount — interest' },
      { label: 'Amount — fee' },
    ],
    capture: [
      { key: 'bsr_code', label: 'BSR code', required: true },
      { key: 'deposit_date', label: 'Deposit date', required: true },
      { key: 'challan_serial', label: 'Challan serial number', required: true },
      { key: 'amount_breakup', label: 'Amount breakup (tax/surcharge/cess/interest/fee)' },
      { key: 'challan_receipt', label: 'Challan receipt document', required: true },
    ],
  },
  {
    slug: 'return-filing',
    name: 'TDS Return Filing',
    form: '24Q / 26Q / 27Q / 27EQ',
    icon: RefreshCcw,
    summary:
      'Quarterly statement. Firm prepares the file in KDK Spectrum / Winman / ClearTDS; this screen tracks readiness, hands off, and captures the outcome.',
    portal: {
      url: EFILING,
      label: 'e-Filing portal',
      navPath: ['e-File', 'Income Tax Forms', 'File Now', 'TDS returns'],
      preLogin: false,
    },
    auxHandoff: {
      label: 'Download CSI file (do this first)',
      url: EFILING,
      navPath: ['e-File', 'e-Pay Tax', 'Payment History', 'Download CSI'],
      note: 'CSI file arrives via download — capture it before starting return prep.',
    },
    fieldSheet: [
      { label: 'Form type', hint: '24Q · 26Q · 27Q · 27EQ' },
      { label: 'Quarter' },
      { label: 'All challans for the quarter captured', hint: 'Verify before starting' },
      { label: 'CSI file downloaded' },
      { label: '.fvu file ready', hint: 'Prepared in KDK Spectrum / Winman / ClearTDS' },
      { label: 'Form 27A ready' },
    ],
    capture: [
      { key: 'token', label: 'Token number', required: true, hint: '15-digit' },
      { key: 'provisional_receipt', label: 'Provisional receipt', required: true },
      { key: 'filed_at', label: 'Filing date', required: true },
      { key: 'filed_by', label: 'Filed by' },
    ],
  },
  {
    slug: 'correction-filing',
    name: 'TDS Correction Filing',
    form: 'Correction statement',
    icon: FileMinus,
    summary:
      'Fix a filed return. Creates a NEW record referencing the original token — the original stays unchanged. Requires the original return.',
    portal: {
      url: EFILING,
      label: 'e-Filing portal',
      navPath: ['e-File', 'Income Tax Forms', 'File Now', 'TDS Correction'],
      preLogin: false,
    },
    auxHandoff: {
      label: 'Request the Conso file from TRACES',
      url: TRACES,
      navPath: ['Statements/Payments', 'Request for Conso File'],
      note: 'Conso file is a request-then-download — capture the request date, expect a wait before you can proceed.',
    },
    fieldSheet: [
      { label: 'Original token number' },
      { label: 'Correction type', hint: 'C1 personal · C2 deductee · C3 challan · C4 salary · C5 PAN · C9 add challan' },
      { label: 'Conso file downloaded' },
      { label: 'Correction file prepared in your existing software' },
    ],
    capture: [
      { key: 'new_token', label: 'New token number', required: true, hint: 'References the original — original stays untouched' },
      { key: 'correction_type', label: 'Correction type' },
      { key: 'receipt', label: 'Provisional receipt', required: true },
    ],
    guards: {
      requiresOriginalToken: true,
    },
  },
  {
    slug: 'form-16',
    name: 'Form 16 / 16A',
    form: 'Form 16 · 16A',
    icon: FilePlus2,
    summary:
      'Issue certificates to deductees. Form 16A quarterly, Form 16 annually after Q4. Requires the underlying return to be filed first.',
    portal: {
      url: TRACES,
      label: 'TRACES',
      navPath: ['Downloads', 'Form 16A (or Form 16)'],
      preLogin: false,
      note: 'Request-then-download with a wait. Capture the request date.',
    },
    fieldSheet: [
      { label: 'Certificate type', hint: 'Form 16 (annual, Q4) · Form 16A (quarterly)' },
      { label: 'Quarter or FY' },
      { label: 'Request date on TRACES' },
    ],
    capture: [
      { key: 'certificate_files', label: 'Certificate files (per deductee)', required: true },
      { key: 'issue_date', label: 'Issue date' },
      { key: 'issuance_register', label: 'Issuance register', hint: 'Which deductee got which certificate, when, how' },
    ],
    guards: {
      requiresFiledReturn: true,
      showTracesRegistrationCaveat: true,
    },
  },
  {
    slug: 'notices',
    name: 'Notices & Defaults',
    form: '—',
    icon: BellRing,
    summary:
      'Weekly TRACES sweep. A missed short-deduction default accrues interest quietly. That "last checked" date is most of the value of this screen.',
    portal: {
      url: TRACES,
      label: 'TRACES',
      navPath: ['Defaults', 'Request for Justification Report'],
      preLogin: false,
    },
    fieldSheet: [
      { label: 'FY / quarter' },
      { label: 'Justification report requested?' },
    ],
    capture: [
      { key: 'justification_report', label: 'Justification report file' },
      { key: 'default_summary', label: 'Default summary (as entered by the firm)' },
      { key: 'last_checked_at', label: 'Last-checked date', required: true },
    ],
  },
];

export function findTdsSubService(slug: string): TdsSubService | undefined {
  return TDS_SUB_SERVICES.find((s) => s.slug === slug);
}
