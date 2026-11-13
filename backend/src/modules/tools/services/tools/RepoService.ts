/**
 * Repo tool — Amazon MTR-B2C CSV → GSTR-1 preview JSON.
 *
 * Reproduces the output shape of the Repotic product's "Ecommerce GSTR-1"
 * download (sections `b2cs` + `supeco.clttx`) so the file can be reviewed
 * against a manual Repotic run for the same period and, once ETIN coverage
 * is filled in (see eco-etins.ts), uploaded to the GST portal.
 *
 * Pure function — CSV bytes in, JSON bytes out. No DB access, no session
 * state. This lets the Tools runner call it like any other converter.
 *
 * Aggregation rules (verified against a Repotic-produced R1_*.json for an
 * August-2026 Amazon MTR):
 *  - Only `Shipment` rows contribute to b2cs. Cancel / Refund / FreeReplacement
 *    are excluded (cancels without a credit-note ref would need Table 9B,
 *    which we do not emit here yet).
 *  - `txval` = sum of "Tax Exclusive Gross" (col 29) grouped by
 *    (sply_ty, place-of-supply, rate%).
 *  - `iamt` / `camt` / `samt` = per-row `round(txval * rate * 100) / 100`
 *    summed into the group. (Rounding per row, THEN summing — summing raw
 *    then rounding diverges from Repotic by a paise on some states.)
 *  - `supeco.clttx` = one entry per marketplace ETIN with totals across
 *    every b2cs row for the file. Flag "N" — the seller pays GST; the
 *    marketplace only collects TCS.
 *
 * What this does NOT produce (deliberate scope — matches the reference
 * file we built against): b2cl, cdnur, hsn, doc_issue, nil_rated. Add
 * these when a reference file that includes them is available.
 */
import { stateNameToCode, gstinStateCode } from '../../../repotic/states.js'
import { lookupEtin, type MarketplaceKey } from '../../../repotic/eco-etins.js'
import { parseCsv } from '../../../zpay/invoice-import.js'

export interface RepoConvertResult {
  bytes: Buffer
  filename: string
  gstin: string
  period: string                       // 'MMYYYY' — matches GSTN's fp
  rowsTotal: number
  rowsIncluded: number
  rowsExcluded: Record<ExcludeReason, number>
  warnings: string[]
}

type ExcludeReason = 'cancel' | 'refund' | 'free_replacement' | 'other' | 'zero_taxable' | 'no_state'

interface B2csEntry {
  sply_ty: 'INTER' | 'INTRA'
  rt: number
  typ: 'OE'
  pos: string
  txval: number
  iamt: number
  samt: number
  camt: number
  csamt: number
}

interface SupecoEntry {
  etin: string
  suppval: number
  igst: number
  cgst: number
  sgst: number
  cess: number
  flag: 'N'
}

interface Gstr1Preview {
  gstin: string
  fp: string
  b2cs: B2csEntry[]
  supeco?: { clttx: SupecoEntry[] }
}

/** Amazon MTR-B2C column headers — stable since 2019. The CSV has a fixed
 *  shape so we don't need the adapter-fingerprint path here. */
const MTR_COLS = {
  sellerGstin: 'Seller Gstin',
  invoiceDate: 'Invoice Date',
  txType: 'Transaction Type',
  orderId: 'Order Id',
  shipToState: 'Ship To State',
  taxableGross: 'Tax Exclusive Gross',
  cgstRate: 'Cgst Rate',
  sgstRate: 'Sgst Rate',
  igstRate: 'Igst Rate',
  cessRate: 'Compensatory Cess Rate',
} as const

/** Pure helper — used from both the service and tests. */
export function convertAmazonMtrCsv(csvText: string, opts: { marketplace?: MarketplaceKey } = {}): RepoConvertResult {
  const marketplace: MarketplaceKey = opts.marketplace ?? 'amazon'
  const stripped = csvText.charCodeAt(0) === 0xfeff ? csvText.slice(1) : csvText
  const rows = parseCsv(stripped)
  if (rows.length < 2) {
    throw new Error('The file has no data rows. Upload the full Amazon MTR-B2C export (header + at least one shipment).')
  }

  const header = rows[0]
  const headerIndex = buildHeaderIndex(header)
  const col = (label: string) => {
    const idx = headerIndex.get(normaliseHeader(label))
    if (idx === undefined) {
      throw new Error(`Column "${label}" not found in CSV. Is this an Amazon MTR-B2C file?`)
    }
    return idx
  }

  const colIdx = {
    sellerGstin: col(MTR_COLS.sellerGstin),
    invoiceDate: col(MTR_COLS.invoiceDate),
    txType: col(MTR_COLS.txType),
    orderId: col(MTR_COLS.orderId),
    shipToState: col(MTR_COLS.shipToState),
    taxableGross: col(MTR_COLS.taxableGross),
    cgstRate: col(MTR_COLS.cgstRate),
    sgstRate: col(MTR_COLS.sgstRate),
    igstRate: col(MTR_COLS.igstRate),
    cessRate: col(MTR_COLS.cessRate),
  }

  const dataRows = rows.slice(1)
  const warnings: string[] = []
  const excluded: Record<ExcludeReason, number> = {
    cancel: 0, refund: 0, free_replacement: 0, other: 0, zero_taxable: 0, no_state: 0,
  }

  // Order-level netting — a shipment that is later refunded in the same
  // period cancels out in GSTR-1 (Repotic drops the pair instead of emitting
  // a CDNUR entry). We pre-compute per-order net taxable and skip shipments
  // whose order already sums to zero (a full refund).
  const netByOrder = new Map<string, number>()
  for (const row of dataRows) {
    const t = classifyTxType(cell(row, colIdx.txType))
    if (t !== 'shipment' && t !== 'refund') continue
    const orderId = cell(row, colIdx.orderId)
    if (!orderId) continue
    const amount = parseAmount(cell(row, colIdx.taxableGross))
    netByOrder.set(orderId, (netByOrder.get(orderId) ?? 0) + amount)
  }
  const nettedOrders = new Set<string>()
  for (const [id, net] of netByOrder) {
    if (Math.abs(net) < 0.01) nettedOrders.add(id)
  }

  let gstin: string | null = null
  let sellerStateCode: string | null = null
  const periodCounts = new Map<string, number>()   // "082026" → occurrences
  // Insertion-ordered: preserves the order states first appear, matching
  // Repotic's output layout.
  const b2cs = new Map<string, B2csEntry>()
  let supecoSuppval = 0
  let supecoIgst = 0
  let supecoCgst = 0
  let supecoSgst = 0
  let supecoCess = 0

  for (const row of dataRows) {
    const g = cell(row, colIdx.sellerGstin)
    if (!gstin && g) {
      gstin = g
      sellerStateCode = gstinStateCode(g) ?? null
    }

    const txType = classifyTxType(cell(row, colIdx.txType))
    if (txType !== 'shipment') {
      if (txType === 'cancel') excluded.cancel++
      else if (txType === 'refund') excluded.refund++
      else if (txType === 'free_replacement') excluded.free_replacement++
      else excluded.other++
      continue
    }

    // Skip shipments that were fully refunded in the same period — their
    // order net is ~0 so Table 7 (b2cs) should not list them.
    const orderId = cell(row, colIdx.orderId)
    if (orderId && nettedOrders.has(orderId)) { excluded.refund++; continue }

    const txval = parseAmount(cell(row, colIdx.taxableGross))
    if (txval <= 0) { excluded.zero_taxable++; continue }

    const pos = stateNameToCode(cell(row, colIdx.shipToState))
    if (!pos) { excluded.no_state++; continue }

    const igstRate = parseRate(cell(row, colIdx.igstRate))
    const cgstRate = parseRate(cell(row, colIdx.cgstRate))
    const sgstRate = parseRate(cell(row, colIdx.sgstRate))
    const cessRate = parseRate(cell(row, colIdx.cessRate))

    const sply_ty: 'INTER' | 'INTRA' = igstRate > 0 ? 'INTER' : 'INTRA'
    const rt = sply_ty === 'INTER' ? pct(igstRate) : pct(cgstRate + sgstRate)
    if (rt === 0) { excluded.other++; continue }

    const iamt = sply_ty === 'INTER' ? round2(txval * igstRate) : 0
    const camt = sply_ty === 'INTRA' ? round2(txval * cgstRate) : 0
    const samt = sply_ty === 'INTRA' ? round2(txval * sgstRate) : 0
    const csamt = round2(txval * cessRate)

    const key = `${sply_ty}|${pos}|${rt}`
    const existing = b2cs.get(key)
    if (existing) {
      existing.txval = round2(existing.txval + txval)
      existing.iamt = round2(existing.iamt + iamt)
      existing.camt = round2(existing.camt + camt)
      existing.samt = round2(existing.samt + samt)
      existing.csamt = round2(existing.csamt + csamt)
    } else {
      b2cs.set(key, { sply_ty, rt, typ: 'OE', pos, txval: round2(txval), iamt, samt, camt, csamt })
    }

    supecoSuppval = round2(supecoSuppval + txval)
    supecoIgst = round2(supecoIgst + iamt)
    supecoCgst = round2(supecoCgst + camt)
    supecoSgst = round2(supecoSgst + samt)
    supecoCess = round2(supecoCess + csamt)

    const fp = fpFromInvoiceDate(cell(row, colIdx.invoiceDate))
    if (fp) periodCounts.set(fp, (periodCounts.get(fp) ?? 0) + 1)
  }

  if (!gstin) throw new Error('Could not read Seller GSTIN from the CSV (column "Seller Gstin" was empty on every row).')
  const fp = mostCommon(periodCounts) ?? ''
  if (!fp) throw new Error('Could not infer the filing period from Invoice Date. Check the CSV\'s date format.')

  const preview: Gstr1Preview = { gstin, fp, b2cs: Array.from(b2cs.values()) }

  // supeco.clttx — needs the marketplace's ETIN registered for the seller's
  // state. If we don't know it yet, omit rather than emit a wrong ETIN.
  const etin = sellerStateCode ? lookupEtin(marketplace, sellerStateCode) : null
  if (etin) {
    preview.supeco = {
      clttx: [{
        etin,
        suppval: supecoSuppval,
        igst: supecoIgst,
        cgst: supecoCgst,
        sgst: supecoSgst,
        cess: supecoCess,
        flag: 'N',
      }],
    }
  } else if (supecoSuppval > 0) {
    warnings.push(`Supplies-via-ECO section (Table 14) omitted: no ETIN registered for ${marketplace} in state ${sellerStateCode ?? '?'}. Add it to backend/src/modules/repotic/eco-etins.ts before uploading to the GST portal.`)
  }

  // Match Repotic's layout byte-for-byte: fixed key order within each
  // entry, section keys in the order they appear in a Repotic export.
  const orderedJson = serialise(preview)
  const [year, mm] = [fp.slice(2), fp.slice(0, 2)]
  const filename = `R1_${gstin}_${mm}_${year}.json`

  return {
    bytes: Buffer.from(orderedJson, 'utf8'),
    filename,
    gstin,
    period: fp,
    rowsTotal: dataRows.length,
    rowsIncluded: dataRows.length - Object.values(excluded).reduce((a, b) => a + b, 0),
    rowsExcluded: excluded,
    warnings,
  }
}

/** Service entry used by the Tools runner. */
export const RepoService = {
  convertAmazonMtr(csvBytes: Buffer, opts: { marketplace?: MarketplaceKey } = {}): RepoConvertResult {
    return convertAmazonMtrCsv(csvBytes.toString('utf8'), opts)
  },
}

// ── helpers ────────────────────────────────────────────────────────────────

function buildHeaderIndex(header: string[]): Map<string, number> {
  const idx = new Map<string, number>()
  header.forEach((h, i) => {
    const key = normaliseHeader(h ?? '')
    if (key && !idx.has(key)) idx.set(key, i)
  })
  return idx
}

function normaliseHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function cell(row: string[], i: number): string {
  if (i < 0 || i >= row.length) return ''
  return (row[i] ?? '').toString().trim()
}

type TxType = 'shipment' | 'cancel' | 'refund' | 'free_replacement' | 'other'
function classifyTxType(raw: string): TxType {
  const v = raw.toLowerCase()
  if (!v) return 'other'
  if (v.includes('cancel')) return 'cancel'
  if (v.includes('refund')) return 'refund'
  if (v.includes('freereplacement') || v.includes('free_replacement') || v.includes('free replacement')) return 'free_replacement'
  if (v.includes('shipment') || v === 'sale' || v === 'invoice') return 'shipment'
  return 'other'
}

/** '549' / '-338.14' / '' → number. Non-numeric or empty → 0. */
function parseAmount(raw: string): number {
  if (!raw) return 0
  const s = raw.replace(/[₹,\s]/g, '')
  if (!s || s === '-') return 0
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

/** '0.18' / '18' / '18%' → fractional rate (0.18). Treats 0<x<1 as already
 *  fractional, x>=1 as a percent that needs /100. */
function parseRate(raw: string): number {
  if (!raw) return 0
  const s = raw.replace('%', '').trim()
  if (!s) return 0
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return 0
  if (n > 0 && n < 1) return n
  return n / 100
}

/** 0.18 → 18 (integer percent used in the output JSON). */
function pct(rate: number): number {
  return Math.round(rate * 10000) / 100
}

/** Round to 2 decimals using JavaScript's default half-to-even-ish behavior
 *  (float-induced). Matches the Repotic reference output. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** '02-08-2026 22:55' → '082026'. Also tolerates YYYY-MM-DD. */
function fpFromInvoiceDate(raw: string): string | null {
  if (!raw) return null
  const s = raw.trim()
  const dmY = /^(\d{2})[-/](\d{2})[-/](\d{4})/.exec(s)
  if (dmY) return `${dmY[2]}${dmY[3]}`
  const ymd = /^(\d{4})[-/](\d{2})[-/](\d{2})/.exec(s)
  if (ymd) return `${ymd[2]}${ymd[1]}`
  return null
}

function mostCommon<K>(counts: Map<K, number>): K | null {
  let best: K | null = null
  let bestN = -1
  for (const [k, n] of counts) {
    if (n > bestN) { bestN = n; best = k }
  }
  return best
}

/** Serialise with the exact key order Repotic uses, so a byte-diff against
 *  a reference file is meaningful. JSON.stringify preserves insertion
 *  order for string keys in modern V8. */
function serialise(p: Gstr1Preview): string {
  const b2cs = p.b2cs.map((e) => ({
    sply_ty: e.sply_ty, rt: e.rt, typ: e.typ, pos: e.pos,
    txval: e.txval, iamt: e.iamt, samt: e.samt, camt: e.camt, csamt: e.csamt,
  }))
  const out: Record<string, unknown> = { gstin: p.gstin, fp: p.fp, b2cs }
  if (p.supeco) {
    out.supeco = {
      clttx: p.supeco.clttx.map((e) => ({
        etin: e.etin, suppval: e.suppval, igst: e.igst,
        cgst: e.cgst, sgst: e.sgst, cess: e.cess, flag: e.flag,
      })),
    }
  }
  return JSON.stringify(out)
}
