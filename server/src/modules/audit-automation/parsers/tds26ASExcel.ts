import ExcelJS from 'exceljs'
import {
  type NormalizedTdsEntry,
  type ParsedTds26AS,
  normalizeSection,
  normalizeTan,
  normalizeQuarter,
  toIsoDate,
  toPaise,
} from './tdsTypes.js'

/**
 * Parser for TRACES Form 26AS Excel (XLSX) download.
 *
 * Multi-sheet workbook — one sheet per Part (A / A1 / A2 / B / C).
 * TRACES puts a title / metadata in rows 1-4 and column headers on
 * row 5 or 6. Header detection scans for a known column.
 */

interface SheetSpec {
  part: string
  matchers: RegExp[]
}
const SHEETS: SheetSpec[] = [
  { part: 'part_a', matchers: [/part\s*a$/i, /^tds$/i] },
  { part: 'part_a1', matchers: [/part\s*a\s*1$/i, /15g|15h/i] },
  { part: 'part_a2', matchers: [/part\s*a\s*2$/i, /sale.*immovable/i] },
  { part: 'part_b', matchers: [/part\s*b$/i, /^tcs$/i] },
  { part: 'part_c', matchers: [/part\s*c$/i, /tax.*paid/i] },
]

const HEADER_ALIASES: Record<string, RegExp[]> = {
  section: [/^section$/i, /section\s*code/i, /section\s*under\s*which/i],
  deductorTan: [/^tan\b/i, /tan\s*of\s*deductor/i, /deductor.*tan/i],
  deductorName: [/name\s*of\s*deductor/i, /deductor\s*name/i, /^deductor$/i],
  quarter: [/^quarter$/i, /^qtr\b/i, /period\s*of\s*payment/i],
  amountPaid: [/amount\s*paid/i, /amount\s*credited/i, /gross\s*amount/i],
  tdsAmount: [/tds\s*deducted/i, /tax\s*deducted/i, /^tds\b/i, /amount\s*of\s*tax/i],
  tdsDate: [/date\s*of\s*booking/i, /booking\s*date/i, /date\s*of\s*payment/i, /transaction\s*date/i],
  status: [/^status\b/i, /processed\s*status/i],
}
type Field = keyof typeof HEADER_ALIASES

function classifySheet(name: string): string | null {
  for (const s of SHEETS) if (s.matchers.some((re) => re.test(name.trim()))) return s.part
  return null
}

function findHeaderRow(ws: ExcelJS.Worksheet): { row: number; cols: Partial<Record<Field, number>> } | null {
  for (let r = 1; r <= Math.min(ws.rowCount, 12); r++) {
    const row = ws.getRow(r)
    const cols: Partial<Record<Field, number>> = {}
    for (let c = 1; c <= ws.columnCount; c++) {
      const text = String(row.getCell(c).text ?? '').trim()
      if (!text) continue
      for (const key of Object.keys(HEADER_ALIASES) as Field[]) {
        if (cols[key]) continue
        if (HEADER_ALIASES[key].some((re) => re.test(text))) cols[key] = c
      }
    }
    if (cols.tdsAmount && (cols.deductorTan || cols.section)) return { row: r, cols }
  }
  return null
}

export async function parseTds26ASExcel(bytes: Buffer): Promise<ParsedTds26AS> {
  const wb = new ExcelJS.Workbook()
  try { await wb.xlsx.load(bytes as unknown as ArrayBuffer) } catch {
    throw new Error('tds_26as_excel_invalid')
  }
  const entries: NormalizedTdsEntry[] = []
  let pan: string | undefined
  let assessmentYear: number | undefined
  let generatedAt: string | undefined

  // Header pull from any leading metadata sheet
  for (const ws of wb.worksheets) {
    const head = [ws.getCell('A1').text, ws.getCell('A2').text, ws.getCell('A3').text, ws.getCell('B1').text, ws.getCell('B2').text]
      .filter(Boolean).join(' ')
    const p = /([A-Z]{5}\d{4}[A-Z])\b/.exec(head)
    if (p && !pan) pan = p[1]
    const ay = /assessment\s*year[^\d]*(\d{4})/i.exec(head)
    if (ay && !assessmentYear) assessmentYear = Number(ay[1])
    const g = /(?:generated\s+on|view\s+as\s+on|as\s+on)\s*[:\-]?\s*([\d\-\/\.]+)/i.exec(head)
    if (g && !generatedAt) generatedAt = toIsoDate(g[1])
  }

  for (const ws of wb.worksheets) {
    const part = classifySheet(ws.name)
    if (!part) continue
    const header = findHeaderRow(ws)
    if (!header) continue
    for (let r = header.row + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r)
      const get = (k: Field) => header.cols[k] ? row.getCell(header.cols[k]!) : null
      const tan = normalizeTan(String(get('deductorTan')?.text ?? ''))
      const section = normalizeSection(String(get('section')?.text ?? ''))
      const tdsCell = get('tdsAmount')
      if (!tan || tdsCell === null) continue
      entries.push({
        part,
        section,
        deductorTan: tan,
        deductorName: String(get('deductorName')?.text ?? '').trim() || undefined,
        quarter: normalizeQuarter(String(get('quarter')?.text ?? '') || String(get('tdsDate')?.text ?? '')),
        amountPaid: toPaise(get('amountPaid')?.value ?? get('amountPaid')?.text ?? 0),
        tdsAmount: toPaise(tdsCell.value ?? tdsCell.text ?? 0),
        tdsDate: toIsoDate(get('tdsDate')?.value ?? get('tdsDate')?.text ?? ''),
        status: String(get('status')?.text ?? '').trim() || undefined,
      })
    }
  }

  return { pan, assessmentYear, generatedAt, entries }
}
