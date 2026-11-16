/**
 * The 14 marketplaces + report kinds listed on Repotic's import screen,
 * per REPOTIC-MODULE.md §2.1. The spec is deliberate about this list:
 * these are the sources accountants actually receive, not a wishlist.
 *
 * Each entry carries the "intended coverage" — which GSTR-1 tables an
 * adapter for this (marketplace, report_kind) is expected to populate.
 * The import screen reads this to answer "what can this adapter do?"
 * BEFORE a file is uploaded, instead of surprising the user at export
 * time (which is the original Repotic's bug per §2.1).
 */

export interface Marketplace {
  /** URL slug + storage key. Lower-case, snake-case. */
  key: string
  /** Display name shown on the import screen. */
  label: string
  /** The report kinds this marketplace emits, in display order. */
  reports: ReportKind[]
}

export interface ReportKind {
  key: string
  /** Button text on the Upload cell, e.g. "MTR B2C", "Sales", "GST". */
  label: string
  /**
   * Which GSTR-1 tables the builder produces from this report (codes from
   * B2C_TABLES; empty = not built). The import screen shows exactly this.
   */
  intendedCoverage: readonly string[]
}

/**
 * The GSTR-1 tables the builder (gstr1-builder.ts) actually produces from a
 * B2C marketplace report: 5A (B2CL), 7 (B2CS, net of returns), 9B (credit
 * notes against B2CL invoices only), 12 (HSN) and 14 (ECO supplies, where
 * the marketplace's ETIN is known). Nothing else — no B2B (4A), exports,
 * advances, nil-rated or documents issued (13).
 */
export const B2C_TABLES = ['5A', '7', '9B', '12', '14'] as const

const B2C = B2C_TABLES as unknown as readonly string[]
/** B2B reports are not built at all: their rows are left out of the
 *  return (Table 4 is not produced). */
const NONE: readonly string[] = []

export const MARKETPLACES: Marketplace[] = [
  {
    key: 'gov_excel', label: 'Gov. excel',
    reports: [{ key: 'gov_summary', label: 'Summary', intendedCoverage: B2C }],
  },
  {
    key: 'other', label: 'Other',
    reports: [
      { key: 'b2c_sheet', label: 'B2C sheet', intendedCoverage: B2C },
      { key: 'b2b_sheet', label: 'B2B sheet', intendedCoverage: NONE },
    ],
  },
  {
    key: 'amazon', label: 'Amazon',
    reports: [
      { key: 'mtr_b2c', label: 'MTR B2C', intendedCoverage: B2C },
      { key: 'mtr_b2b', label: 'MTR B2B', intendedCoverage: NONE },
    ],
  },
  {
    key: 'flipkart', label: 'Flipkart',
    reports: [
      { key: 'sales', label: 'Sales', intendedCoverage: B2C },
      { key: 'gst', label: 'GST', intendedCoverage: B2C },
    ],
  },
  { key: 'meesho', label: 'Meesho', reports: [{ key: 'sales', label: 'Sales', intendedCoverage: B2C }] },
  { key: 'myntra', label: 'Myntra', reports: [{ key: 'sales', label: 'Sales', intendedCoverage: B2C }] },
  { key: 'ajio',   label: 'Ajio',   reports: [{ key: 'sales', label: 'Sales', intendedCoverage: B2C }] },
  {
    key: 'glowroad', label: 'GlowRoad',
    reports: [
      { key: 'tcs_b2c', label: 'B2C TCS', intendedCoverage: B2C },
      { key: 'tcs_b2b', label: 'B2B TCS', intendedCoverage: NONE },
    ],
  },
  { key: 'jiomart',   label: 'JioMart',   reports: [{ key: 'sales', label: 'Sales', intendedCoverage: B2C }] },
  { key: 'limeroad',  label: 'LimeRoad',  reports: [{ key: 'sales', label: 'Sales', intendedCoverage: B2C }] },
  { key: 'shop101',   label: 'Shop101',   reports: [{ key: 'sales', label: 'Sales', intendedCoverage: B2C }] },
  { key: 'citymall',  label: 'CityMall',  reports: [{ key: 'sales', label: 'Sales', intendedCoverage: B2C }] },
  { key: 'paytm',     label: 'Paytm',     reports: [{ key: 'sales', label: 'Sales', intendedCoverage: B2C }] },
  { key: 'snapdeal',  label: 'Snapdeal',  reports: [{ key: 'sales', label: 'Sales', intendedCoverage: B2C }] },
]

export const MARKETPLACE_KEYS = MARKETPLACES.map((m) => m.key)
export function isMarketplaceKey(k: unknown): k is string {
  return typeof k === 'string' && MARKETPLACE_KEYS.includes(k)
}

/** Find the report-kind descriptor for an (marketplace, report_kind) pair. */
export function findReportKind(mp: string, rk: string): ReportKind | undefined {
  return MARKETPLACES.find((m) => m.key === mp)?.reports.find((r) => r.key === rk)
}
