/**
 * COMPLIANCE CALENDAR — the due-date engine (docs/compliance/README.md).
 *
 * Pure functions over the ComplianceForm catalogue. Every date is an IST
 * calendar date string 'YYYY-MM-DD'; nothing here touches a Date in local
 * time, so a server in UTC and one in IST give the same answer.
 *
 *   due = anchor + offsetMonths months, on `dueDay` (clamped to month end;
 *         31 = last day; null = the anchor's own day), then + offsetDays.
 *
 * Anchors: period_end | fy_end | fy_start | agm | event.
 */
import { addDays, daysBetween, lastDayOfMonth } from '../../lib/dates.js'

export interface FormRule {
  code: string
  name?: string
  authority?: string
  frequency: string
  entityTypes?: string
  anchor: string
  offsetMonths: number
  dueDay: number | null
  offsetDays: number
  months: string | null
  lateFeeNote?: string | null
}

export interface Period {
  /** '2025-26' (annual), '2025-26-Q1', '2026-04' (month), '2025-26-H1' */
  key: string
  label: string
  /** Last day of the period, 'YYYY-MM-DD'. */
  end: string
  /** Calendar month (1-12) the period ends in. */
  endMonth: number
}

const pad = (n: number) => String(n).padStart(2, '0')
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '2025-26' → 2025. Throws on a malformed label. */
export function fyStartYear(fy: string): number {
  const m = /^(\d{4})-(\d{2})$/.exec(fy)
  if (!m || (Number(m[1]) + 1) % 100 !== Number(m[2])) throw new Error(`invalid financial year: ${fy}`)
  return Number(m[1])
}
export const isFy = (fy: unknown): fy is string => {
  if (typeof fy !== 'string') return false
  try { fyStartYear(fy); return true } catch { return false }
}
export function fyLabel(startYear: number): string {
  return `${startYear}-${pad((startYear + 1) % 100)}`
}
/** The FY ('2026-27') an IST date falls in. */
export function fyOfDate(date: string): string {
  const [y, m] = date.split('-').map(Number)
  return fyLabel(m >= 4 ? y : y - 1)
}
export const shiftFy = (fy: string, by: number) => fyLabel(fyStartYear(fy) + by)

const monthEnd = (y: number, m: number) => `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}`

/** Add months to (y, m) → [y, m]. m is 1-12. */
function addMonths(y: number, m: number, n: number): [number, number] {
  const idx = y * 12 + (m - 1) + n
  return [Math.floor(idx / 12), (idx % 12) + 1]
}

export function parseMonths(months: string | null | undefined): number[] | null {
  if (!months) return null
  const out = months.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 12)
  return out.length ? out : null
}

/** The periods a form has in one FY, in calendar order. Event forms have none. */
export function periodsOf(form: Pick<FormRule, 'frequency' | 'months' | 'anchor'>, fy: string): Period[] {
  const y = fyStartYear(fy)
  const only = parseMonths(form.months)
  const keep = (p: Period) => !only || only.includes(p.endMonth)
  if (form.anchor === 'event' || form.frequency === 'event') return []
  if (form.frequency === 'annual') {
    return [{ key: fy, label: `FY ${fy}`, end: `${y + 1}-03-31`, endMonth: 3 }]
  }
  if (form.frequency === 'monthly') {
    const out: Period[] = []
    for (let i = 0; i < 12; i++) {
      const [yy, mm] = addMonths(y, 4, i)
      out.push({ key: `${yy}-${pad(mm)}`, label: `${MON[mm - 1]} ${yy}`, end: monthEnd(yy, mm), endMonth: mm })
    }
    return out.filter(keep)
  }
  if (form.frequency === 'quarterly') {
    const ends: [number, number][] = [[y, 6], [y, 9], [y, 12], [y + 1, 3]]
    return ends.map(([yy, mm], i) => ({
      key: `${fy}-Q${i + 1}`, label: `Q${i + 1} FY ${fy}`, end: monthEnd(yy, mm), endMonth: mm,
    })).filter(keep)
  }
  if (form.frequency === 'half_yearly') {
    return [
      { key: `${fy}-H1`, label: `Apr–Sep ${y}`, end: `${y}-09-30`, endMonth: 9 },
      { key: `${fy}-H2`, label: `Oct ${y}–Mar ${y + 1}`, end: `${y + 1}-03-31`, endMonth: 3 },
    ].filter(keep)
  }
  return []
}

/** The FY a period key belongs to. */
export function fyOfPeriodKey(key: string): string {
  const fy = /^(\d{4}-\d{2})(?:-(?:Q[1-4]|H[12]))?$/.exec(key)
  if (fy && isFy(fy[1])) return fy[1]
  const ym = /^\d{4}-(\d{2})$/.exec(key)
  if (ym && Number(ym[1]) >= 1 && Number(ym[1]) <= 12) return fyOfDate(`${key}-01`)
  throw new Error(`invalid period key: ${key}`)
}

/** The last permitted AGM date for an FY: 30 September after it ends. */
export const defaultAgmDate = (fy: string) => `${fyStartYear(fy) + 1}-09-30`

/**
 * Apply the rule to an anchor date: + offsetMonths, on dueDay (clamped;
 * null keeps the anchor's day, also clamped), then + offsetDays.
 */
export function applyRule(anchorDate: string, rule: Pick<FormRule, 'offsetMonths' | 'dueDay' | 'offsetDays'>): string {
  const [ay, am, ad] = anchorDate.split('-').map(Number)
  const [y, m] = addMonths(ay, am, rule.offsetMonths ?? 0)
  const day = Math.min(rule.dueDay ?? ad, lastDayOfMonth(y, m))
  const base = `${y}-${pad(m)}-${pad(day)}`
  return rule.offsetDays ? addDays(base, rule.offsetDays) : base
}

export interface DueResult {
  statutory_due_date: string
  /** Anchor date used (AGM forms: the entered AGM date, or the assumed 30 Sep). */
  anchor_date: string
  /** AGM-anchored and no AGM date entered yet — the date assumes 30 September. */
  anchor_missing: boolean
}

/**
 * Statutory due date of one period of a form. `agmDate` is the client's AGM
 * date for the FY (ComplianceItem.anchorDate); null → the last permitted day.
 * Null for event-anchored forms.
 */
export function dueFor(form: FormRule, period: Period | string, fy?: string, agmDate?: string | null): DueResult | null {
  const p = typeof period === 'string' ? findPeriod(form, period) : period
  if (!p) return null
  const year = fy ?? fyOfPeriodKey(p.key)
  const y = fyStartYear(year)
  let anchor: string
  let missing = false
  switch (form.anchor) {
    case 'period_end': anchor = p.end; break
    case 'fy_end': anchor = `${y + 1}-03-31`; break
    case 'fy_start': anchor = `${y}-04-01`; break
    case 'agm':
      anchor = agmDate && /^\d{4}-\d{2}-\d{2}$/.test(agmDate) ? agmDate : defaultAgmDate(year)
      missing = !agmDate
      break
    default: return null
  }
  return { statutory_due_date: applyRule(anchor, form), anchor_date: anchor, anchor_missing: missing }
}

export function findPeriod(form: FormRule, key: string): Period | null {
  let fy: string
  try { fy = fyOfPeriodKey(key) } catch { return null }
  return periodsOf(form, fy).find((p) => p.key === key) ?? null
}

// ── Entity type ──────────────────────────────────────────────────────────────

export type EntityType = 'company' | 'llp' | 'firm' | 'individual' | 'huf' | 'trust' | 'society' | 'aop' | 'any'
export const ENTITY_TYPES: EntityType[] = ['company', 'llp', 'firm', 'individual', 'huf', 'trust', 'society', 'aop', 'any']

/**
 * Client.businessType is free text typed at onboarding. Order matters:
 * "Limited Liability Partnership" holds both "limited" and "partnership".
 */
export function entityTypeOf(businessType: string | null | undefined): EntityType {
  const s = ` ${String(businessType ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `
  if (!s.trim()) return 'any'
  if (/ llp | limited liability partnership /.test(s)) return 'llp'
  if (/ huf | hindu undivided /.test(s)) return 'huf'
  if (/ trust /.test(s)) return 'trust'
  if (/ society | cooperative | co operative | co op /.test(s)) return 'society'
  if (/ aop | boi | association of persons | body of individuals /.test(s)) return 'aop'
  if (/ opc | one person | private limited | pvt ltd | pvt limited | private ltd | public limited | public ltd | ltd | limited | company | section 8 | sec 8 | producer company /.test(s)) return 'company'
  if (/ partnership | firm /.test(s)) return 'firm'
  if (/ proprietor | proprietorship | proprietary concern | sole | individual | salaried | professional /.test(s)) return 'individual'
  return 'any'
}

export function formEntityTypes(form: Pick<FormRule, 'entityTypes'>): string[] {
  return String(form.entityTypes ?? 'any').split(',').map((s) => s.trim()).filter(Boolean)
}

// ── Late fees ────────────────────────────────────────────────────────────────

export interface LateFeeEstimate { amount_paise?: number; note: string }

const ITR = new Set(['ITR_NON_BUSINESS', 'ITR_NON_AUDIT_BUSINESS', 'ITR_AUDIT', 'ITR_TP'])
const ROC_PER_DAY = new Set(['AOC4', 'MGT7', 'ADT1', 'DPT3', 'LLP11', 'LLP8'])

/**
 * Late fee / interest ESTIMATE for an item filed late or still open past its
 * due date. Null when on time. Notes only where an amount cannot be computed.
 */
export function lateFeeEstimate(
  form: Pick<FormRule, 'code' | 'lateFeeNote'>,
  dueDate: string,
  opts: { today: string; filedOn?: string | null; status?: string },
): LateFeeEstimate | null {
  if (opts.status === 'not_applicable') return null
  const end = opts.filedOn ?? (opts.status === 'filed' ? null : opts.today)
  if (!end) return null
  const days = daysBetween(dueDate, end)
  if (days <= 0) return null
  const est = (s: string) => `Estimate: ${s}`
  switch (true) {
    case form.code === 'GSTR9':
      return { amount_paise: 200_00 * days, note: est(`₹200/day (₹100 CGST + ₹100 SGST) for ${days} day${days === 1 ? '' : 's'}, capped at 0.5% of turnover in the State/UT.`) }
    case form.code === 'GSTR9C':
      return { note: est('GSTR-9C is filed with GSTR-9 — the GSTR-9 late fee of ₹200/day applies until both are filed.') }
    case form.code === 'CMP08':
      return { note: est('Interest at 18% p.a. on the tax paid late, from the day after the due date.') }
    case form.code === 'GSTR4':
      return { amount_paise: Math.min(200_00 * days, 2000_00), note: est('₹200/day (₹100 CGST + ₹100 SGST), capped at ₹2,000 where there is no tax liability.') }
    case form.code === 'PMT06':
      return { note: est('Interest at 18% p.a. on the tax paid late.') }
    case ITR.has(form.code):
      return { amount_paise: 5000_00, note: est('s.234F fee ₹5,000 (₹1,000 if total income ≤ ₹5 lakh), plus s.234A interest at 1% per month on unpaid tax.') }
    case form.code === 'TAX_AUDIT_REPORT':
      return { note: est('s.271B penalty: 0.5% of turnover, up to ₹1,50,000.') }
    case form.code === 'FORM_3CEB':
      return { note: est('s.271BA penalty ₹1,00,000.') }
    case form.code === 'SFT_61A':
      return { amount_paise: 500_00 * days, note: est(`s.271FA penalty ₹500/day for ${days} day${days === 1 ? '' : 's'}.`) }
    case ROC_PER_DAY.has(form.code):
      return { amount_paise: 100_00 * days, note: est(`Additional fee ₹100/day for ${days} day${days === 1 ? '' : 's'}.`) }
    case form.code === 'DIR3_KYC':
      return { amount_paise: 5000_00, note: est('Late fee ₹5,000 to reactivate the DIN.') }
    case form.code === 'PF_ECR':
      return { note: est('Interest 12% p.a. (s.7Q) plus damages (s.14B) on contributions paid late.') }
    case form.code === 'ESI':
      return { note: est('Interest 12% p.a. on contributions paid late; damages may apply.') }
    case form.code === 'ADVANCE_TAX':
      return { note: est('s.234C interest at 1% per month on the shortfall of the instalment.') }
    default:
      return form.lateFeeNote ? { note: est(form.lateFeeNote) } : null
  }
}
