/**
 * TDS sections, rates and thresholds — the deductee register's calculator.
 *
 * [VERIFY EACH YEAR] Rates and thresholds are as amended by the Finance
 * (No. 2) Act, 2024 and the Finance Act, 2025 (thresholds from 1 Apr 2025).
 * Section codes use the Income-tax Act, 1961 numbering that return
 * software, TRACES and firms still work in. From FY 2026-27 the
 * Income-tax Act, 2025 renumbers these provisions (TDS moves to s. 393);
 * the substance carried over, but check each figure against the current
 * law before relying on it. Everything the firm enters can override the
 * computed TDS — the calculator proposes, it never forces.
 *
 * Salary (192) and payments to non-residents (195) are rate-by-case: no
 * rate is proposed and the firm enters the TDS.
 */

export type DeducteeCategory = 'individual_huf' | 'other'

export interface SectionRule {
  code: string
  label: string
  /** Rate % for individuals / HUFs, and for everyone else. null = entered by hand. */
  rateIndividual: number | null
  rateOther: number | null
  /** No deduction while one payment is below this… */
  singleThreshold?: number
  /** …and the FY total to the deductee under this section stays at or below this. */
  annualThreshold?: number
  /** Threshold per month (rent u/s 194-I): deduct when a month's rent exceeds it. */
  monthlyThreshold?: number
  /** Rate when the deductee has no PAN (s. 206AA). Default: higher of 20% and twice the rate. */
  noPanRate?: number
  /** Return the deduction is reported in. */
  returnForm: '24Q' | '26Q' | '27Q' | '26QB' | '26QC' | '26QD'
  /** 15G / 15H declarations can apply to this income. */
  declarationAllowed?: boolean
}

export const SECTIONS: SectionRule[] = [
  { code: '192', label: 'Salary', rateIndividual: null, rateOther: null, returnForm: '24Q' },
  { code: '193', label: 'Interest on securities', rateIndividual: 10, rateOther: 10, annualThreshold: 10_000, returnForm: '26Q', declarationAllowed: true },
  { code: '194', label: 'Dividend', rateIndividual: 10, rateOther: 10, annualThreshold: 10_000, returnForm: '26Q', declarationAllowed: true },
  { code: '194A', label: 'Interest other than on securities', rateIndividual: 10, rateOther: 10, annualThreshold: 10_000, returnForm: '26Q', declarationAllowed: true },
  { code: '194B', label: 'Lottery / crossword / game winnings', rateIndividual: 30, rateOther: 30, singleThreshold: 10_000, returnForm: '26Q' },
  { code: '194C', label: 'Contractors / sub-contractors', rateIndividual: 1, rateOther: 2, singleThreshold: 30_000, annualThreshold: 1_00_000, returnForm: '26Q' },
  { code: '194D', label: 'Insurance commission', rateIndividual: 2, rateOther: 10, annualThreshold: 20_000, returnForm: '26Q' },
  { code: '194H', label: 'Commission / brokerage', rateIndividual: 2, rateOther: 2, annualThreshold: 20_000, returnForm: '26Q' },
  { code: '194I(a)', label: 'Rent — plant, machinery, equipment', rateIndividual: 2, rateOther: 2, monthlyThreshold: 50_000, returnForm: '26Q' },
  { code: '194I(b)', label: 'Rent — land, building, furniture', rateIndividual: 10, rateOther: 10, monthlyThreshold: 50_000, returnForm: '26Q' },
  { code: '194J(a)', label: 'Fees for technical services, call centre, film royalty', rateIndividual: 2, rateOther: 2, annualThreshold: 50_000, returnForm: '26Q' },
  { code: '194J(b)', label: 'Fees for professional services, royalty, non-compete', rateIndividual: 10, rateOther: 10, annualThreshold: 50_000, returnForm: '26Q' },
  { code: '194O', label: 'E-commerce operator payments', rateIndividual: 0.1, rateOther: 0.1, noPanRate: 5, returnForm: '26Q' },
  { code: '194Q', label: 'Purchase of goods (buyer turnover > ₹10 cr)', rateIndividual: 0.1, rateOther: 0.1, annualThreshold: 50_00_000, noPanRate: 5, returnForm: '26Q' },
  { code: '194R', label: 'Business perquisites / benefits', rateIndividual: 10, rateOther: 10, annualThreshold: 20_000, returnForm: '26Q' },
  { code: '194S', label: 'Transfer of virtual digital assets', rateIndividual: 1, rateOther: 1, returnForm: '26Q' },
  { code: '194IA', label: 'Purchase of immovable property (26QB)', rateIndividual: 1, rateOther: 1, singleThreshold: 50_00_000, returnForm: '26QB' },
  { code: '194IB', label: 'Rent paid by individuals / HUFs (26QC)', rateIndividual: 2, rateOther: 2, monthlyThreshold: 50_000, returnForm: '26QC' },
  { code: '194M', label: 'Contract / commission / professional fees by individuals (26QD)', rateIndividual: 2, rateOther: 2, annualThreshold: 50_00_000, returnForm: '26QD' },
  { code: '195', label: 'Payments to non-residents', rateIndividual: null, rateOther: null, returnForm: '27Q' },
]

export const sectionByCode = (code: string) => SECTIONS.find((s) => s.code === code)

export type Basis = 'normal' | 'no_pan' | 'lower_certificate' | 'declaration' | 'below_threshold' | 'manual'

export interface TdsCalcInput {
  section: string
  category: DeducteeCategory
  hasPan: boolean
  /** Amount paid / credited now, in rupees. */
  amount: number
  /** FY total already paid to this deductee under this section, before this payment. */
  priorFyTotal: number
  /** A valid 15G / 15H for the FY. */
  declaration: boolean
  /** A valid lower-deduction certificate (Form 13 / s. 197) covering this payment. */
  lowerCertificate: { rate: number; remainingLimit: number | null } | null
}

export interface TdsCalcResult {
  /** Proposed TDS in rupees (rounded to the rupee), or null when entered by hand. */
  tds: number | null
  rate: number | null
  basis: Basis
  note: string
}

const roundRupee = (n: number) => Math.round(n)

export function computeTds(i: TdsCalcInput): TdsCalcResult {
  const rule = sectionByCode(i.section)
  if (!rule) return { tds: null, rate: null, basis: 'manual', note: 'Unknown section — enter the TDS.' }
  const base = i.category === 'individual_huf' ? rule.rateIndividual : rule.rateOther
  if (base === null) return { tds: null, rate: null, basis: 'manual', note: `${rule.code} is computed case by case — enter the TDS.` }

  if (i.declaration && rule.declarationAllowed) {
    return { tds: 0, rate: 0, basis: 'declaration', note: '15G / 15H on file — no deduction.' }
  }

  // Thresholds (simplified to the tests the Act uses for each section).
  const fyTotal = i.priorFyTotal + i.amount
  if (rule.monthlyThreshold !== undefined && i.amount <= rule.monthlyThreshold) {
    return { tds: 0, rate: 0, basis: 'below_threshold', note: `Within ₹${rule.monthlyThreshold.toLocaleString('en-IN')} a month — no deduction.` }
  }
  if (rule.singleThreshold !== undefined && rule.annualThreshold === undefined && i.amount < rule.singleThreshold) {
    return { tds: 0, rate: 0, basis: 'below_threshold', note: `Below ₹${rule.singleThreshold.toLocaleString('en-IN')} — no deduction.` }
  }
  if (rule.annualThreshold !== undefined && fyTotal <= rule.annualThreshold
    && (rule.singleThreshold === undefined || i.amount < rule.singleThreshold)) {
    return { tds: 0, rate: 0, basis: 'below_threshold', note: `FY total ₹${fyTotal.toLocaleString('en-IN')} is within ₹${rule.annualThreshold.toLocaleString('en-IN')} — no deduction yet.` }
  }
  // 194Q taxes only the part above ₹50 lakh.
  const taxable = rule.code === '194Q' && rule.annualThreshold !== undefined
    ? Math.min(i.amount, Math.max(0, fyTotal - rule.annualThreshold))
    : i.amount

  if (!i.hasPan) {
    const rate = rule.noPanRate ?? Math.max(20, base * 2)
    return { tds: roundRupee((taxable * rate) / 100), rate, basis: 'no_pan', note: `No PAN — s. 206AA higher rate ${rate}%.` }
  }
  if (i.lowerCertificate) {
    const { rate, remainingLimit } = i.lowerCertificate
    const covered = remainingLimit === null ? taxable : Math.min(taxable, Math.max(0, remainingLimit))
    const tds = (covered * rate) / 100 + ((taxable - covered) * base) / 100
    return {
      tds: roundRupee(tds), rate, basis: 'lower_certificate',
      note: covered < taxable ? `Lower-deduction certificate at ${rate}% up to its limit, ${base}% on the rest.` : `Lower-deduction certificate — ${rate}%.`,
    }
  }
  return { tds: roundRupee((taxable * base) / 100), rate: base, basis: 'normal', note: `${rule.code} at ${base}%.` }
}

/** Which quarterly return a deduction belongs in. */
export function returnFormFor(section: string, residency: 'resident' | 'non_resident'): string {
  if (residency === 'non_resident') return '27Q'
  return sectionByCode(section)?.returnForm ?? '26Q'
}

/** Deductee-row remark codes used by return software (26Q / 27Q). */
export const REMARK_CODE: Partial<Record<Basis, string>> = {
  lower_certificate: 'A', declaration: 'B', no_pan: 'C',
}
