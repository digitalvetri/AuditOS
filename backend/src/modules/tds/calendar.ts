/**
 * TDS statutory calendar — the server's copy of the due-date rules the TDS
 * page shows (src/pages/workstation/tds/status.ts). Used by the firm-wide
 * board and the reminder job, which run without the browser. Pure
 * functions; `today` is always passed in. The test suite pins these dates
 * so the two copies cannot drift apart unnoticed.
 *
 *   challan      7th of next month; March deductions → 30 April
 *   return       Q1 31 Jul · Q2 31 Oct · Q3 31 Jan · Q4 31 May
 *   Form 16A/27D 15 days after that quarter's return due date
 *   Form 16      15 June after the FY (needs Q4 24Q filed)
 *   26QB/QC/QD   30 days from the end of the month of deduction;
 *                Form 16B/16C/16D 15 days after that
 */

export type Quarter = 'Q1' | 'Q2' | 'Q3' | 'Q4'
export const QUARTERS: Quarter[] = ['Q1', 'Q2', 'Q3', 'Q4']
export const NOTICE_CHECK_INTERVAL_DAYS = 7

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (y: number, m0: number, d: number) => {
  const dt = new Date(Date.UTC(y, m0, d))
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

/** Today in India, as YYYY-MM-DD — deadlines are Indian calendar dates. */
export function todayIst(now = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10)
}

export const fyStart = (fy: string) => Number(fy.split('-')[0])

/** The FY label ('2026-27') a date falls in. */
export function fyOf(date: string): string {
  const [y, m] = date.split('-').map(Number)
  const start = m >= 4 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

/** Deduction months of the FY, 'YYYY-MM', Apr → Mar. */
export function fyMonths(fy: string): string[] {
  const y = fyStart(fy)
  return Array.from({ length: 12 }, (_, i) => {
    const m0 = (3 + i) % 12
    return `${m0 < 3 ? y + 1 : y}-${pad(m0 + 1)}`
  })
}

export const monthStart = (ym: string) => `${ym}-01`
export function monthEnd(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return iso(y, m, 0)
}
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return iso(y, m - 1, d + days)
}
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

export function challanDue(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return m === 3 ? iso(y, 3, 30) : iso(y, m, 7) // m is 1-based → next month's 0-based index
}

const Q_END: Record<Quarter, [number, number]> = { Q1: [0, 5], Q2: [0, 8], Q3: [0, 11], Q4: [1, 2] }
export function quarterEnd(q: Quarter, fy: string): string {
  const [off, m0] = Q_END[q]
  return iso(fyStart(fy) + off, m0 + 1, 0)
}
export function quarterStart(q: Quarter, fy: string): string {
  const [off, m0] = Q_END[q]
  return iso(fyStart(fy) + off, m0 - 2, 1)
}
export function quarterOfMonth(ym: string): Quarter {
  const m = Number(ym.slice(5, 7))
  return m >= 4 && m <= 6 ? 'Q1' : m >= 7 && m <= 9 ? 'Q2' : m >= 10 ? 'Q3' : 'Q4'
}
export function returnDue(q: Quarter, fy: string): string {
  const y = fyStart(fy)
  return { Q1: iso(y, 6, 31), Q2: iso(y, 9, 31), Q3: iso(y + 1, 0, 31), Q4: iso(y + 1, 4, 31) }[q]
}
export function certificateDue(period: string, fy: string): string {
  if (period === 'FY') return iso(fyStart(fy) + 1, 5, 15)
  return addDays(returnDue(period as Quarter, fy), 15)
}
/** 26QB / 26QC / 26QD: statement due 30 days after the end of the deduction month. */
export function challanStatementDue(ym: string): string {
  return addDays(monthEnd(ym), 30)
}
/** Form 16B / 16C / 16D: 15 days after the statement was due. */
export function challanStatementCertificateDue(ym: string): string {
  return addDays(challanStatementDue(ym), 15)
}

// ── what is expected, and where it stands ───────────────────────────────────

export interface FilingLike {
  kind: string
  fy: string | null
  period: string | null
  formType: string | null
  status: string
  eventDate: string | null
  reference?: string | null
}

export type ItemState = 'done' | 'in_progress' | 'due' | 'overdue'
export interface ExpectedItem {
  kind: 'challan' | 'return' | 'certificate' | 'challan_statement_cert'
  period: string
  formType: string | null
  label: string
  due: string
  state: ItemState
}

const stateOf = (r: FilingLike | undefined, due: string, today: string): ItemState =>
  r?.status === 'done' ? 'done' : r?.status === 'in_progress' ? 'in_progress' : today > due ? 'overdue' : 'due'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`

/**
 * Every challan, return and certificate a TAN owes for an FY, with its
 * state. A month or quarter is expected once it has ended; anything
 * already recorded is always included.
 */
export function expectedItems(records: FilingLike[], fy: string, returnForms: string[], today: string): ExpectedItem[] {
  const out: ExpectedItem[] = []
  const find = (kind: string, period: string, form: string | null) =>
    records.find((r) => r.kind === kind && r.fy === fy && r.period === period && (r.formType ?? null) === form)

  for (const ym of fyMonths(fy)) {
    const r = find('challan', ym, null)
    if (!r && monthEnd(ym) >= today) continue
    const due = challanDue(ym)
    out.push({ kind: 'challan', period: ym, formType: null, label: `Challan ${monthLabel(ym)}`, due, state: stateOf(r, due, today) })
  }
  for (const form of returnForms) {
    for (const q of QUARTERS) {
      const r = find('return', q, form)
      if (!r && quarterEnd(q, fy) >= today) continue
      const due = returnDue(q, fy)
      out.push({ kind: 'return', period: q, formType: form, label: `${form} ${q} return`, due, state: stateOf(r, due, today) })
    }
  }
  for (const ret of records.filter((r) => r.kind === 'return' && r.fy === fy && r.status === 'done')) {
    const form = ret.formType === '24Q' ? (ret.period === 'Q4' ? '16' : null) : ret.formType === '27EQ' ? '27D' : '16A'
    if (!form) continue
    const period = form === '16' ? 'FY' : ret.period!
    const r = find('certificate', period, form)
    const due = certificateDue(period, fy)
    out.push({ kind: 'certificate', period, formType: form, label: form === '16' ? `Form 16 FY ${fy}` : `Form ${form} ${period}`, due, state: stateOf(r, due, today) })
  }
  // 26QB / 26QC / 26QD statements owe a Form 16B / 16C / 16D.
  for (const s of records.filter((r) => r.kind === 'challan_statement' && r.status === 'done' && r.period && fyOf(`${r.period}-01`) === fy)) {
    const cert = s.formType === '26QB' ? '16B' : s.formType === '26QC' ? '16C' : '16D'
    const due = challanStatementCertificateDue(s.period!)
    const issued = (s as FilingLike & { certIssuedOn?: string | null }).certIssuedOn
    out.push({
      kind: 'challan_statement_cert', period: s.period!, formType: cert,
      label: `Form ${cert} (${s.formType}${s.reference ? ` ack ${s.reference}` : ''})`, due,
      state: issued ? 'done' : today > due ? 'overdue' : 'due',
    })
  }
  return out
}

/** Last date the firm checked TRACES for this TAN, if ever. */
export function lastNoticeCheck(records: FilingLike[]): string | null {
  return records.filter((r) => r.kind === 'notice_check' && r.eventDate).map((r) => r.eventDate!).sort().at(-1) ?? null
}

export function noticeCheckStale(records: FilingLike[], today: string): boolean {
  const last = lastNoticeCheck(records)
  return !last || daysBetween(last, today) > NOTICE_CHECK_INTERVAL_DAYS
}
