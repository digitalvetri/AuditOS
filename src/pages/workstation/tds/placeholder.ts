/**
 * TDS placeholder status generators.
 *
 * Deterministic hash-derived statuses per (clientId, tan, subService,
 * fyLabel) so a client's status stays stable across renders and matches
 * the numbers other TDS screens show. Same pattern as the GST module's
 * placeholder.ts — swappable for real backend one function at a time
 * when task #4 lands.
 *
 * All the status shapes below are intentionally simple. The real engine
 * will replace them; component code should treat these as opaque and
 * only branch on the surfaced union type.
 */

export type SubServiceStatusKey =
  | 'not_registered'
  | 'applied'
  | 'active'          // TAN allotted / no action pending
  | 'due'             // action due soon
  | 'overdue'         // past the deadline
  | 'in_progress'
  | 'filed'
  | 'unpaid'
  | 'paid'
  | 'issued'
  | 'pending'
  | 'not_applicable'; // greyed row with reason

export interface SubServiceStatus {
  key: SubServiceStatusKey;
  /** One-liner shown in the sub-service list row. */
  label: string;
  /** Optional secondary text: TAN, ARN, due date, etc. */
  detail?: string;
  /** Whether this row should render greyed / disabled. */
  greyed?: boolean;
  /** Reason string when greyed — surfaced in the row. */
  greyedReason?: string;
}

export function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Deterministic pseudo-boolean derived from a stable key. */
function coin(key: string): boolean {
  return hash(key) % 2 === 0;
}

interface Ctx {
  clientId: string;
  tan: string | null;
  fyLabel: string;
  /** Whether an Incorporation case is currently open for this client. */
  incorporating?: boolean;
  /** Whether the return for the current period has been filed — drives
   *  Form 16/16A eligibility and Correction eligibility. */
  hasFiledReturn?: boolean;
  /** For Correction — whether a token exists for the FY. */
  hasOriginalToken?: boolean;
  /** Last checked timestamp for Notices, from noticeCheckStore. */
  lastNoticeCheckAt?: string;
}

export function registrationStatus(ctx: Ctx): SubServiceStatus {
  if (ctx.incorporating) {
    return {
      key: 'not_applicable',
      label: 'Handled by SPICe+',
      detail: 'TAN allotted automatically through the incorporation route',
      greyed: true,
      greyedReason: 'Incorporation case open',
    };
  }
  if (ctx.tan) {
    return { key: 'active', label: `TAN ${ctx.tan}`, detail: 'Registered' };
  }
  const h = hash(ctx.clientId + 'reg');
  if (h % 3 === 0) {
    return { key: 'applied', label: 'Applied · awaiting allotment', detail: 'Ack pending TAN' };
  }
  return { key: 'not_registered', label: 'Not registered', detail: 'Apply Form 49B on Protean TIN' };
}

/** Challan status for the CURRENT deduction month. */
export function challanStatus(ctx: Ctx): SubServiceStatus {
  if (!ctx.tan) return notApplicable('No TAN — register first');
  const now = new Date();
  const month = now.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  const h = hash(ctx.clientId + ctx.tan + 'challan' + month);
  const cycle = h % 4;
  if (cycle === 0) return { key: 'paid',    label: 'Paid',        detail: month };
  if (cycle === 1) return { key: 'unpaid',  label: 'Unpaid',      detail: `${month} · due 7th of next month` };
  if (cycle === 2) return { key: 'overdue', label: 'Overdue',     detail: `${month} deduction unpaid` };
  return              { key: 'in_progress', label: 'In progress', detail: `${month} · draft` };
}

export function returnFilingStatus(ctx: Ctx): SubServiceStatus {
  if (!ctx.tan) return notApplicable('No TAN — register first');
  const h = hash(ctx.clientId + ctx.tan + 'return' + ctx.fyLabel);
  const cycle = h % 4;
  if (cycle === 0) return { key: 'filed',       label: 'All quarters filed',    detail: ctx.fyLabel };
  if (cycle === 1) return { key: 'in_progress', label: 'Q2 in progress',        detail: ctx.fyLabel };
  if (cycle === 2) return { key: 'due',         label: 'Q2 due · not started',  detail: ctx.fyLabel };
  return              { key: 'overdue',         label: 'Q1 overdue',            detail: ctx.fyLabel };
}

export function correctionStatus(ctx: Ctx): SubServiceStatus {
  if (!ctx.tan) return notApplicable('No TAN — register first');
  if (!ctx.hasOriginalToken) {
    return {
      key: 'not_applicable',
      label: '—',
      detail: 'No original return to correct',
      greyed: true,
      greyedReason: 'No original return',
    };
  }
  const h = hash(ctx.clientId + ctx.tan + 'correction' + ctx.fyLabel);
  if (h % 3 === 0) return { key: 'in_progress', label: '1 open correction' };
  return { key: 'active', label: 'No open corrections' };
}

export function form16Status(ctx: Ctx): SubServiceStatus {
  if (!ctx.tan) return notApplicable('No TAN — register first');
  if (!ctx.hasFiledReturn) {
    return {
      key: 'not_applicable',
      label: '—',
      detail: 'Requires the return to be filed first',
      greyed: true,
      greyedReason: 'Return not filed',
    };
  }
  const h = hash(ctx.clientId + ctx.tan + 'form16' + ctx.fyLabel);
  const cycle = h % 3;
  if (cycle === 0) return { key: 'issued',  label: 'Q1 16A issued', detail: ctx.fyLabel };
  if (cycle === 1) return { key: 'pending', label: 'Q1 16A pending issue', detail: ctx.fyLabel };
  return              { key: 'due',        label: 'Q1 16A due',           detail: ctx.fyLabel };
}

export function noticesStatus(ctx: Ctx): SubServiceStatus {
  if (!ctx.tan) return notApplicable('No TAN — register first');
  const h = hash(ctx.clientId + ctx.tan + 'notices' + ctx.fyLabel);
  const openCount = h % 4 === 0 ? 2 : h % 4 === 1 ? 1 : 0;
  const lastChecked = ctx.lastNoticeCheckAt
    ? new Date(ctx.lastNoticeCheckAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
    : `${(h % 10) + 1}d ago`;
  return openCount > 0
    ? { key: 'overdue',    label: `last checked ${lastChecked}`, detail: `${openCount} open` }
    : { key: 'active',     label: `last checked ${lastChecked}` };
}

function notApplicable(reason: string): SubServiceStatus {
  return { key: 'not_applicable', label: '—', greyed: true, greyedReason: reason };
}

/** Deterministic placeholder TANs when a client actually has any. Real
 *  data replaces this once the backend has a TAN table. */
export function placeholderTans(clientId: string): string[] {
  const h = hash(clientId);
  if (h % 5 === 0) return [];                                 // no TAN registered
  if (h % 5 === 1) return [tanFor(clientId, 0), tanFor(clientId, 1)]; // multi-TAN
  return [tanFor(clientId, 0)];
}

function tanFor(clientId: string, idx: number): string {
  const h = hash(clientId + idx);
  const letters = (n: number) => {
    let s = '';
    for (let i = 0; i < 4; i++) {
      s += String.fromCharCode(65 + ((n + i * 7) % 26));
      n = Math.floor(n / 26);
    }
    return s;
  };
  const first = letters(h);
  const digits = String(h % 100000).padStart(5, '0');
  const last = String.fromCharCode(65 + (h % 26));
  return `${first}${digits}${last}`;
}

/** Placeholder deductor type — real value comes from the backend TAN row. */
export function placeholderDeductorType(clientId: string, tan: string | null): string {
  if (!tan) return '—';
  const kinds = ['Company', 'Firm', 'Individual/HUF', 'Government'];
  return kinds[hash(clientId + tan) % kinds.length];
}

/** Placeholder for "responsible person" from the TAN registration. */
export function placeholderResponsiblePerson(clientId: string, tan: string | null): string {
  if (!tan) return '—';
  const first = ['Ravi', 'Priya', 'Anitha', 'Vikram', 'Meera', 'Karthik'];
  const last = ['Krishnan', 'Menon', 'Iyer', 'Rao', 'Nair', 'Reddy'];
  const h = hash(clientId + tan);
  return `${first[h % first.length]} ${last[(h >> 3) % last.length]}`;
}

/** Whether the current period's return has been filed. Deterministic per
 *  (clientId, TAN, FY). */
export function placeholderHasFiledReturn(clientId: string, tan: string | null, fyLabel: string): boolean {
  if (!tan) return false;
  return coin(clientId + tan + 'filedReturn' + fyLabel);
}

export function placeholderHasOriginalToken(clientId: string, tan: string | null, fyLabel: string): boolean {
  if (!tan) return false;
  // Original token needs a filed return.
  return placeholderHasFiledReturn(clientId, tan, fyLabel) && !coin(clientId + tan + 'onlyClean' + fyLabel);
}
