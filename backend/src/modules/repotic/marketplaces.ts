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
   * Which GSTR-1 tables an adapter for this report CAN populate. Values
   * are the GSTR-1 table codes (4A, 5A, 7, 9B, 6A, 11A, 11B, 8, 12,
   * 13, 14a, 14b). An adapter that lacks a declared table shows up as
   * "no doc 13" / "no 14(a)" on the import screen's coverage column.
   */
  intendedCoverage: readonly string[]
}

/**
 * The full table set a complete adapter would cover. Anything missing
 * from a report kind's `intendedCoverage` is a known gap for that
 * source — e.g. Myntra's seller report lacks "Documents issued"
 * because Myntra does not expose per-invoice counts.
 */
export const ALL_GSTR1_TABLES = [
  '4A', '5A', '7', '9B', '6A', '11A', '11B', '8', '12', '13', '14a',
] as const

const ALL = ALL_GSTR1_TABLES as unknown as readonly string[]
const NO_DOC_13 = ALL.filter((t) => t !== '13')

export const MARKETPLACES: Marketplace[] = [
  {
    key: 'gov_excel', label: 'Gov. excel',
    reports: [{ key: 'gov_summary', label: 'Summary', intendedCoverage: ALL }],
  },
  {
    key: 'other', label: 'Other',
    reports: [
      { key: 'b2c_sheet', label: 'B2C sheet', intendedCoverage: ALL },
      { key: 'b2b_sheet', label: 'B2B sheet', intendedCoverage: ALL },
    ],
  },
  {
    key: 'amazon', label: 'Amazon',
    reports: [
      { key: 'mtr_b2c', label: 'MTR B2C', intendedCoverage: ALL },
      { key: 'mtr_b2b', label: 'MTR B2B', intendedCoverage: ALL },
    ],
  },
  {
    key: 'flipkart', label: 'Flipkart',
    reports: [
      { key: 'sales', label: 'Sales', intendedCoverage: ALL },
      { key: 'gst', label: 'GST', intendedCoverage: ALL },
    ],
  },
  { key: 'meesho', label: 'Meesho', reports: [{ key: 'sales', label: 'Sales', intendedCoverage: ALL }] },
  { key: 'myntra', label: 'Myntra', reports: [{ key: 'sales', label: 'Sales', intendedCoverage: NO_DOC_13 }] },
  { key: 'ajio',   label: 'Ajio',   reports: [{ key: 'sales', label: 'Sales', intendedCoverage: NO_DOC_13 }] },
  {
    key: 'glowroad', label: 'GlowRoad',
    reports: [
      { key: 'tcs_b2c', label: 'B2C TCS', intendedCoverage: NO_DOC_13 },
      { key: 'tcs_b2b', label: 'B2B TCS', intendedCoverage: NO_DOC_13 },
    ],
  },
  { key: 'jiomart',   label: 'JioMart',   reports: [{ key: 'sales', label: 'Sales', intendedCoverage: NO_DOC_13 }] },
  { key: 'limeroad',  label: 'LimeRoad',  reports: [{ key: 'sales', label: 'Sales', intendedCoverage: NO_DOC_13 }] },
  { key: 'shop101',   label: 'Shop101',   reports: [{ key: 'sales', label: 'Sales', intendedCoverage: NO_DOC_13 }] },
  { key: 'citymall',  label: 'CityMall',  reports: [{ key: 'sales', label: 'Sales', intendedCoverage: NO_DOC_13 }] },
  { key: 'paytm',     label: 'Paytm',     reports: [{ key: 'sales', label: 'Sales', intendedCoverage: NO_DOC_13 }] },
  { key: 'snapdeal',  label: 'Snapdeal',  reports: [{ key: 'sales', label: 'Sales', intendedCoverage: NO_DOC_13 }] },
]

export const MARKETPLACE_KEYS = MARKETPLACES.map((m) => m.key)
export function isMarketplaceKey(k: unknown): k is string {
  return typeof k === 'string' && MARKETPLACE_KEYS.includes(k)
}

/** Find the report-kind descriptor for an (marketplace, report_kind) pair. */
export function findReportKind(mp: string, rk: string): ReportKind | undefined {
  return MARKETPLACES.find((m) => m.key === mp)?.reports.find((r) => r.key === rk)
}
