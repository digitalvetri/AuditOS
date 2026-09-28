/**
 * BOOKKEEPING · IMPORT MAPPING SERVICE
 *
 * BOOKKEEPING-REBUILD.md §3.1 — Step 1 of the import pipeline.
 *
 * This service does only two things:
 *   1. Parse an uploaded Excel file into a sheet-picker preview (list of
 *      sheets + the first ten rows of each), so the operator can pick a
 *      tab and map columns on the wizard screen.
 *   2. CRUD the saved mapping (column letter → target field), keyed
 *      uniquely on (company, target). Next month the same file drops
 *      in and the mapping picks it up automatically.
 *
 * It does NOT derive vouchers, create ledgers, or write to the ledger.
 * That is Step 2 of the rebuild (§3.2). Keeping the two apart is
 * deliberate — a saved mapping is inert until the operator commits.
 */
import ExcelJS from 'exceljs'
import { PrismaClient, Prisma } from '@prisma/client'
import { ApiError } from '../../../lib/http.js'

/** How many rows of preview to return per sheet. */
const PREVIEW_ROWS = 10
/** How many columns to expose to the mapping UI. Wider sheets are cropped. */
const PREVIEW_MAX_COLS = 40

export type ImportTarget =
  | 'sales_register'
  | 'purchase_register'
  | 'receipt_register'
  | 'payment_register'

export const IMPORT_TARGETS: readonly ImportTarget[] = [
  'sales_register',
  'purchase_register',
  'receipt_register',
  'payment_register',
] as const

export function isImportTarget(v: unknown): v is ImportTarget {
  return typeof v === 'string' && (IMPORT_TARGETS as readonly string[]).includes(v)
}

/** The fields the wizard can map a column to. `ignore` means skip. */
export const MAPPABLE_FIELDS = [
  'ignore',
  'date',
  'invoice_no',
  'bill_no',
  'customer',
  'supplier',
  'description',
  'currency',
  'foreign_amount',
  'amount_inr',
  'exchange_rate',
  'taxable_value',
  'cgst',
  'sgst',
  'igst',
  'cess',
  'total',
  'gstin',
  'hsn',
] as const

export type MappableField = (typeof MAPPABLE_FIELDS)[number]

export function isMappableField(v: unknown): v is MappableField {
  return typeof v === 'string' && (MAPPABLE_FIELDS as readonly string[]).includes(v)
}

export interface SheetPreview {
  name: string
  rowCount: number
  columns: string[]      // ['A', 'B', ...] up to first empty header or PREVIEW_MAX_COLS
  headerRow: string[]    // trimmed text of the assumed header row
  sampleRows: string[][] // up to PREVIEW_ROWS rows AFTER the header
}

export interface WorkbookPreview {
  sheets: SheetPreview[]
}

/**
 * Parse an uploaded workbook into the sheet-picker view. Returns EVERY
 * sheet — the operator sees the tab bar the same way they see it in
 * Excel and picks one to map. Empty sheets are still listed so nothing
 * disappears silently.
 */
export async function previewWorkbook(bytes: Buffer): Promise<WorkbookPreview> {
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer)
  } catch {
    throw new ApiError(400, 'excel_invalid', 'This file could not be read as an .xlsx workbook.')
  }
  const sheets: SheetPreview[] = []
  for (const ws of wb.worksheets) {
    sheets.push(previewSheet(ws))
  }
  if (sheets.length === 0) {
    throw new ApiError(400, 'excel_empty', 'The workbook has no sheets.')
  }
  return { sheets }
}

function previewSheet(ws: ExcelJS.Worksheet): SheetPreview {
  // Find the width by scanning row 1 for content. Some files export empty
  // trailing columns; ws.columnCount reports those too, which would drown
  // the UI in blank pickers.
  const rawMaxCol = Math.min(ws.columnCount || 0, PREVIEW_MAX_COLS)
  let effectiveMaxCol = 0
  for (let c = 1; c <= rawMaxCol; c++) {
    const v = String(ws.getRow(1).getCell(c).text ?? '').trim()
    if (v !== '') effectiveMaxCol = c
  }
  // If row 1 is entirely empty, keep a small default so the operator can
  // still map columns manually. Ten is enough for any bank/register.
  if (effectiveMaxCol === 0) effectiveMaxCol = Math.min(rawMaxCol, 10)

  const columns: string[] = []
  const headerRow: string[] = []
  for (let c = 1; c <= effectiveMaxCol; c++) {
    columns.push(numberToColLetter(c))
    headerRow.push(String(ws.getRow(1).getCell(c).text ?? '').trim())
  }
  const sampleRows: string[][] = []
  const dataRows = Math.min(ws.rowCount, PREVIEW_ROWS + 1)
  for (let r = 2; r <= dataRows; r++) {
    const row = ws.getRow(r)
    const vals: string[] = []
    for (let c = 1; c <= effectiveMaxCol; c++) {
      vals.push(String(row.getCell(c).text ?? '').trim())
    }
    sampleRows.push(vals)
  }
  return {
    name: ws.name,
    rowCount: Math.max(0, ws.rowCount - 1), // header row is not "data"
    columns,
    headerRow,
    sampleRows,
  }
}

/** Excel column letters: 1→A, 27→AA, 703→AAA, … */
export function numberToColLetter(n: number): string {
  let s = ''
  let x = n
  while (x > 0) {
    const r = (x - 1) % 26
    s = String.fromCharCode(65 + r) + s
    x = Math.floor((x - 1) / 26)
  }
  return s
}

export function colLetterToIndex(letter: string): number {
  const s = (letter ?? '').toUpperCase().trim()
  if (!/^[A-Z]+$/.test(s)) return 0
  let n = 0
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

// ---------------------------------------------------------------------------
// Mapping CRUD
// ---------------------------------------------------------------------------

export interface SaveMappingInput {
  sheetName: string
  target: ImportTarget
  headerRow: number
  columnMap: Record<string, MappableField>
  dateFormat: string
  currencyAliases: Record<string, string>
}

/**
 * Validate a mapping before it hits the DB. The wizard's own dropdowns
 * are safe by construction, but a hand-crafted request could still send
 * nonsense — reject it here so a saved mapping is always parseable.
 */
export function validateMappingInput(input: SaveMappingInput): void {
  if (!input.sheetName || !input.sheetName.trim()) {
    throw new ApiError(400, 'sheet_name_required', 'Pick a sheet before saving.')
  }
  if (!isImportTarget(input.target)) {
    throw new ApiError(400, 'target_invalid', `Target must be one of: ${IMPORT_TARGETS.join(', ')}.`)
  }
  if (!Number.isInteger(input.headerRow) || input.headerRow < 1) {
    throw new ApiError(400, 'header_row_invalid', 'Header row must be a positive integer (usually 1).')
  }
  for (const [col, field] of Object.entries(input.columnMap)) {
    if (!/^[A-Z]+$/.test(col)) {
      throw new ApiError(400, 'column_key_invalid', `"${col}" is not a valid Excel column letter.`)
    }
    if (!isMappableField(field)) {
      throw new ApiError(400, 'field_invalid', `"${field}" is not a mappable field.`)
    }
  }
  const dateCols = Object.entries(input.columnMap).filter(([, f]) => f === 'date').length
  if (dateCols !== 1) {
    throw new ApiError(400, 'date_column_required', 'Exactly one column must be mapped to Date.')
  }
  // The invariant that makes multi-currency workable — at minimum we need
  // an INR amount so the ledger can post. Foreign + rate are optional
  // because a pure-INR register does not carry them.
  const hasInr = Object.values(input.columnMap).includes('amount_inr')
  const hasTotal = Object.values(input.columnMap).includes('total')
  if (!hasInr && !hasTotal) {
    throw new ApiError(400, 'amount_column_required',
      'Map one column to Amount (INR) or Total so the ledger has something to post.')
  }
}

export async function saveMapping(
  prisma: PrismaClient,
  companyId: string,
  input: SaveMappingInput,
  userId: string | null,
): Promise<Prisma.BookkeepingImportMappingGetPayload<Record<string, never>>> {
  validateMappingInput(input)

  const existing = await prisma.bookkeepingImportMapping.findUnique({
    where: { tallyCompanyId_target: { tallyCompanyId: companyId, target: input.target } },
  })

  const data = {
    tallyCompanyId: companyId,
    sheetName: input.sheetName.trim(),
    target: input.target,
    headerRow: input.headerRow,
    columnMapJson: input.columnMap as Prisma.InputJsonValue,
    dateFormat: input.dateFormat,
    currencyAliasesJson: input.currencyAliases as Prisma.InputJsonValue,
  }

  if (existing) {
    return prisma.bookkeepingImportMapping.update({
      where: { id: existing.id },
      data: { ...data, version: existing.version + 1, updatedByUserId: userId },
    })
  }
  return prisma.bookkeepingImportMapping.create({
    data: { ...data, createdByUserId: userId, updatedByUserId: userId },
  })
}

export async function listMappings(prisma: PrismaClient, companyId: string) {
  return prisma.bookkeepingImportMapping.findMany({
    where: { tallyCompanyId: companyId },
    orderBy: [{ target: 'asc' }],
  })
}

export async function getMapping(
  prisma: PrismaClient,
  companyId: string,
  target: ImportTarget,
) {
  return prisma.bookkeepingImportMapping.findUnique({
    where: { tallyCompanyId_target: { tallyCompanyId: companyId, target } },
  })
}
