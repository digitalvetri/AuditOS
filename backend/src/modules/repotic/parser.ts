/**
 * REPOTIC Phase 2 — parse an RpEcommerceUpload into normalised rows.
 *
 * One pass over the source file:
 *   1. Read the header row and the data rows (XLSX / CSV / TSV) the same way
 *      the fingerprint step does — so what the parser sees matches what
 *      detect() saw.
 *   2. Build a header → column-index map using the adapter's columnMapJson.
 *      The spec lists field names (invoice_number, cgst_tax, …) → source
 *      header labels ("Invoice Number", "Cgst Tax", …).
 *   3. For each data row, extract the mapped values, classify Transaction
 *      Type (shipment / cancel / refund / free_replacement / other), convert
 *      currency to paise, and persist to RpParsedRow.
 *
 * Idempotent — every call deletes existing RpParsedRow for the upload before
 * writing new ones. A re-parse after an adapter edit is a drop+rebuild.
 *
 * All money is in INTEGER PAISE: ₹423.73 → 42373. The GSTR-1 builder adds up
 * thousands of these, so float drift at display time would be visible.
 */
import type { PrismaClient, Prisma } from '@prisma/client'
import { readStatementTable } from '../audit-automation/lib/tableFile.js'
import { parseCsv } from '../zpay/invoice-import.js'
import { stateNameToCode, gstinStateCode } from './states.js'

type MoneyPaise = number

/** Fields the GSTR-1 builder consumes. Everything else in the source row
 *  survives as JSON on `rawJson` for auditor spot-checks. */
export interface ColumnMap {
  invoice_number?: string
  invoice_date?: string
  invoice_amount?: string
  taxable_value?: string
  total_tax?: string
  cgst_tax?: string
  sgst_tax?: string
  igst_tax?: string
  cess_tax?: string
  cgst_rate?: string
  sgst_rate?: string
  igst_rate?: string
  hsn?: string
  quantity?: string
  ship_to_state?: string
  seller_gstin?: string
  transaction_type?: string
  credit_note_number?: string
  credit_note_date?: string
}

type TxType = 'shipment' | 'cancel' | 'refund' | 'free_replacement' | 'other'

/** Map Amazon's wide vocabulary of Transaction Type values to our 5 buckets.
 *  Marketplaces use slightly different phrasings — "Shipment", "SHIPPED",
 *  "ORDER_SHIPMENT" — so this is strict-ish on substrings. */
function classifyTxType(raw: string | undefined): TxType {
  if (!raw) return 'other'
  const v = raw.trim().toLowerCase()
  if (v.includes('cancel')) return 'cancel'
  if (v.includes('refund')) return 'refund'
  if (v.includes('freereplacement') || v.includes('free_replacement') || v.includes('free replacement'))
    return 'free_replacement'
  if (v.includes('shipment') || v === 'invoice' || v === 'order' || v === 'sale') return 'shipment'
  return 'other'
}

/** '₹1,234.56' / '1234.56' / '1,00,000' / '' → paise. Non-numeric → 0. */
export function toPaise(raw: unknown): MoneyPaise {
  if (raw === null || raw === undefined) return 0
  const s = String(raw).trim().replace(/[₹,\s]/g, '')
  if (s === '' || s === '-') return 0
  const n = Number(s)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100)
}

/** '0.18' / '18' / '18%' → percent × 100 (1800 for 18%). Amazon encodes
 *  rates as fractions ('0.18') for GST and whole numbers for TCS, so this
 *  must handle both without accidentally multiplying rate=18 by 100. */
export function toRateBps(raw: unknown): number {
  if (raw === null || raw === undefined) return 0
  const s = String(raw).trim().replace('%', '')
  if (!s) return 0
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return 0
  // Amazon writes 0.18 for 18%; writes 18 for 18% in other reports. The
  // 0–1 range unambiguously means fractional.
  if (n > 0 && n < 1) return Math.round(n * 10000)
  return Math.round(n * 100)
}

/** 'YYYY-MM-DD HH:mm:ss' → 'YYYY-MM-DD'. Falls back to first 10 chars. */
export function toDate(raw: unknown): string | null {
  if (!raw) return null
  const s = String(raw).trim()
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  // DD-MM-YYYY / DD/MM/YYYY fallback.
  const m2 = /^(\d{2})[-/](\d{2})[-/](\d{4})/.exec(s)
  if (m2) return `${m2[3]}-${m2[2]}-${m2[1]}`
  return null
}

/** Build a case-insensitive, punctuation-insensitive header → index map
 *  so the column_map can list 'Invoice Number' and still find
 *  'invoice_number' or 'INVOICE NO.' in the file. Matches fingerprint.ts
 *  normalisation. */
function headerIndex(headers: string[]): Map<string, number> {
  const idx = new Map<string, number>()
  headers.forEach((h, i) => {
    const key = (h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
    if (key && !idx.has(key)) idx.set(key, i)
  })
  return idx
}
function normaliseKey(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export interface ParseOutcome {
  rowsWritten: number
  typeCounts: Record<TxType, number>
  warnings: string[]
}

/**
 * Parse one upload and persist the normalised rows.
 *
 * Returns per-type counts so the API can store them on the upload row —
 * the UI badge "412 rows (380 shipment / 32 cancel)" reads from that.
 */
export async function parseUpload(uploadId: string, prisma: PrismaClient): Promise<ParseOutcome> {
  const upload = await prisma.rpEcommerceUpload.findUniqueOrThrow({ where: { id: uploadId } })
  if (!upload.adapterId) {
    throw new Error('upload has no adapter — no_match uploads cannot be parsed in Phase 2')
  }
  const adapter = await prisma.rpMarketplaceAdapter.findUniqueOrThrow({ where: { id: upload.adapterId } })
  const columnMap = safeParseColumnMap(adapter.columnMapJson)
  // We refetch the file from the persistence layer in Phase 2.1 (we don't
  // currently store bytes — only sha256). For Phase 2 we re-upload is the
  // only path, so parseUpload is called from the POST handler with the
  // buffer still in memory via a short-circuit. See `parseFromBuffer`.
  throw new Error('parseUpload(uploadId) requires file-bytes persistence (Phase 2.1). Use parseFromBuffer() for now.')
  // Unreachable — kept to document the shape of the full-pipeline API.
  // eslint-disable-next-line no-unreachable
  console.log(columnMap)
}

/**
 * Phase 2 workhorse — called from the upload POST handler with the file
 * bytes still in memory. Writes RpParsedRow records and returns per-type
 * counts.
 */
export async function parseFromBuffer(args: {
  uploadId: string
  organisationId: string
  buffer: Buffer
  ext: string
  adapterColumnMapJson: string
  prisma: PrismaClient
}): Promise<ParseOutcome> {
  const { uploadId, organisationId, buffer, ext, adapterColumnMapJson, prisma } = args
  const columnMap = safeParseColumnMap(adapterColumnMapJson)
  const rows = await readRowsFromBuffer(buffer, ext)
  if (rows.length === 0) return emptyOutcome('empty file')
  const header = rows[0]
  const body = rows.slice(1)
  const index = headerIndex(header)
  const colIndex = (label?: string) => (label ? index.get(normaliseKey(label)) ?? -1 : -1)

  const cells = {
    invoiceNumber: colIndex(columnMap.invoice_number),
    invoiceDate: colIndex(columnMap.invoice_date),
    invoiceAmount: colIndex(columnMap.invoice_amount),
    taxableValue: colIndex(columnMap.taxable_value),
    totalTax: colIndex(columnMap.total_tax),
    cgstTax: colIndex(columnMap.cgst_tax ?? 'Cgst Tax'),
    sgstTax: colIndex(columnMap.sgst_tax ?? 'Sgst Tax'),
    igstTax: colIndex(columnMap.igst_tax ?? 'Igst Tax'),
    cessTax: colIndex(columnMap.cess_tax ?? 'Compensatory Cess Tax'),
    cgstRate: colIndex(columnMap.cgst_rate ?? 'Cgst Rate'),
    sgstRate: colIndex(columnMap.sgst_rate ?? 'Sgst Rate'),
    igstRate: colIndex(columnMap.igst_rate ?? 'Igst Rate'),
    hsn: colIndex(columnMap.hsn),
    quantity: colIndex(columnMap.quantity ?? 'Quantity'),
    shipToState: colIndex(columnMap.ship_to_state),
    sellerGstin: colIndex(columnMap.seller_gstin),
    txType: colIndex(columnMap.transaction_type),
    creditNoteNumber: colIndex(columnMap.credit_note_number),
    creditNoteDate: colIndex(columnMap.credit_note_date),
  }

  const warnings: string[] = []
  if (cells.invoiceAmount < 0) warnings.push('invoice_amount column not found in file')
  if (cells.taxableValue < 0) warnings.push('taxable_value column not found in file')

  // Idempotent — drop prior rows for this upload before inserting fresh ones.
  await prisma.rpParsedRow.deleteMany({ where: { uploadId } })

  const typeCounts: Record<TxType, number> = {
    shipment: 0, cancel: 0, refund: 0, free_replacement: 0, other: 0,
  }
  const inserts: Prisma.RpParsedRowCreateManyInput[] = []
  body.forEach((row, i) => {
    const txType = classifyTxType(cell(row, cells.txType))
    typeCounts[txType]++
    const cgstTax = toPaise(cell(row, cells.cgstTax))
    const sgstTax = toPaise(cell(row, cells.sgstTax))
    const igstTax = toPaise(cell(row, cells.igstTax))
    const cessTax = toPaise(cell(row, cells.cessTax))
    // Rate is the HSN rate the row was taxed at. Prefer IGST rate when
    // IGST is populated (interstate); CGST rate otherwise. CGST = SGST
    // by GST law so either works; CGST is more commonly populated.
    const stateCodeIntra = igstTax === 0 && (cgstTax > 0 || sgstTax > 0)
    const rate = stateCodeIntra
      ? toRateBps(cell(row, cells.cgstRate)) + toRateBps(cell(row, cells.sgstRate))
      : toRateBps(cell(row, cells.igstRate))
    inserts.push({
      organisationId,
      uploadId,
      sourceRowIndex: i + 2,  // 1-based + skip header
      txType,
      invoiceNumber: cell(row, cells.invoiceNumber) || null,
      invoiceDate: toDate(cell(row, cells.invoiceDate)),
      invoiceAmount: toPaise(cell(row, cells.invoiceAmount)),
      taxableValue: toPaise(cell(row, cells.taxableValue)),
      cgstTax, sgstTax, igstTax, cessTax, rate,
      hsn: cell(row, cells.hsn) || null,
      quantity: Number(cell(row, cells.quantity) ?? 0) | 0,
      shipToState: cell(row, cells.shipToState) || null,
      sellerGstin: cell(row, cells.sellerGstin) || null,
      stateCodeIntra,
      creditNoteNumber: cell(row, cells.creditNoteNumber) || null,
      creditNoteDate: toDate(cell(row, cells.creditNoteDate)),
      rawJson: JSON.stringify(zip(header, row)),
    })
  })
  // Batch — createMany is faster than per-row create but doesn't trip the
  // CASCADE fk setup, which is fine for the no-return-ids path.
  if (inserts.length) {
    await prisma.rpParsedRow.createMany({ data: inserts })
  }
  await prisma.rpEcommerceUpload.update({
    where: { id: uploadId },
    data: {
      rowCount: inserts.length,
      typeCountsJson: JSON.stringify(typeCounts),
      status: 'parsed',
    },
  })
  return { rowsWritten: inserts.length, typeCounts, warnings }
}

function emptyOutcome(reason: string): ParseOutcome {
  return { rowsWritten: 0, typeCounts: { shipment: 0, cancel: 0, refund: 0, free_replacement: 0, other: 0 }, warnings: [reason] }
}

function cell(row: string[], idx: number): string {
  if (idx < 0 || idx >= row.length) return ''
  return (row[idx] ?? '').toString().trim()
}

function zip(header: string[], row: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  header.forEach((h, i) => { if (h) out[h] = (row[i] ?? '').toString() })
  return out
}

function safeParseColumnMap(json: string): ColumnMap {
  try {
    const v = JSON.parse(json) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as ColumnMap) : {}
  } catch { return {} }
}

export async function readRowsFromBuffer(buffer: Buffer, ext: string): Promise<string[][]> {
  const kind = (ext || '').toLowerCase().replace(/^\./, '')
  if (kind === 'xlsx' || kind === 'xls') {
    return await readStatementTable(buffer, 'xlsx')
  }
  const text = buffer.toString('utf8')
  // Strip UTF-8 BOM Amazon loves to prepend.
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return parseCsv(clean)
}

// Re-exports used by tests + states helpers.
export { gstinStateCode, stateNameToCode }
