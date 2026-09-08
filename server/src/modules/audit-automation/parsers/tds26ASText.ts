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
 * Parser for TRACES Form 26AS text (`.txt`) download.
 *
 * TRACES text has a header block with PAN / name / AY, then labelled
 * PARTs. Detail rows are pipe- or tab-delimited. Column order varies
 * slightly by TRACES version, so this parser identifies columns by
 * their header names within each PART.
 *
 * The parser walks the file line-by-line, tracks the current PART, and
 * for each PART finds the header row (contains a mix of "Section",
 * "TAN", "Amount Paid", "TDS Deducted") and then reads detail rows
 * until the next PART or a blank line.
 *
 * Amounts arrive as rupees decimals in the file — toPaise() converts.
 */

const PART_MARKERS: [RegExp, string][] = [
  [/^PART\s*A\s*1\b/i, 'part_a1'],
  [/^PART\s*A\s*2\b/i, 'part_a2'],
  [/^PART\s*A\b/i, 'part_a'],
  [/^PART\s*B\b/i, 'part_b'],
  [/^PART\s*C\b/i, 'part_c'],
]

const HEADER_ALIASES: Record<string, RegExp[]> = {
  section: [/^section$/i, /^section\s*code$/i, /^section\s*under\s*which/i],
  deductorTan: [/^tan\b/i, /tan\s*of\s*deductor/i, /deductor.*tan/i],
  deductorName: [/name\s*of\s*deductor/i, /deductor\s*name/i, /^deductor$/i],
  quarter: [/^quarter$/i, /^qtr\b/i, /period\s*of\s*payment/i],
  amountPaid: [/amount\s*paid/i, /amount\s*credited/i, /gross\s*amount/i],
  tdsAmount: [/tds\s*deducted/i, /tax\s*deducted/i, /^tds\b/i, /amount\s*of\s*tax/i],
  tdsDate: [/date\s*of\s*booking/i, /booking\s*date/i, /date\s*of\s*payment/i, /transaction\s*date/i],
  status: [/^status\b/i, /processed\s*status/i],
}

type Field = keyof typeof HEADER_ALIASES

function splitRow(line: string): string[] {
  if (line.includes('|')) return line.split('|').map((s) => s.trim())
  if (line.includes('\t')) return line.split('\t').map((s) => s.trim())
  return line.split(/\s{2,}/).map((s) => s.trim())
}

function mapHeader(cols: string[]): Partial<Record<Field, number>> {
  const map: Partial<Record<Field, number>> = {}
  cols.forEach((c, i) => {
    for (const key of Object.keys(HEADER_ALIASES) as Field[]) {
      if (map[key]) continue
      if (HEADER_ALIASES[key].some((re) => re.test(c))) map[key] = i
    }
  })
  return map
}

export function parseTds26ASText(bytes: Buffer): ParsedTds26AS {
  const text = bytes.toString('utf8')
  const lines = text.split(/\r?\n/)
  const entries: NormalizedTdsEntry[] = []

  let pan: string | undefined
  let assessmentYear: number | undefined
  let generatedAt: string | undefined
  let currentPart: string | null = null
  let currentHeader: Partial<Record<Field, number>> | null = null

  // Header block scan — first 30 lines.
  for (const line of lines.slice(0, 30)) {
    const panMatch = /([A-Z]{5}\d{4}[A-Z])\b/.exec(line)
    if (panMatch && !pan) pan = panMatch[1]
    // AY like "Assessment Year : 2027-28" or "AY 2026-27"
    const ayMatch = /assessment\s*year[^\d]*(\d{4})/i.exec(line)
    if (ayMatch && !assessmentYear) assessmentYear = Number(ayMatch[1])
    const gen = /(?:generated\s+on|view\s+as\s+on|as\s+on)\s*[:\-]?\s*([\d\-\/\.]+)/i.exec(line)
    if (gen && !generatedAt) generatedAt = toIsoDate(gen[1])
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()
    if (!line) { currentHeader = null; continue }

    // Detect PART header
    for (const [re, key] of PART_MARKERS) {
      if (re.test(line)) {
        currentPart = key
        currentHeader = null
        break
      }
    }

    if (!currentPart) continue

    // Detect column header inside current PART
    if (!currentHeader) {
      const cols = splitRow(line)
      const map = mapHeader(cols)
      if (map.tdsAmount !== undefined && (map.deductorTan !== undefined || map.section !== undefined)) {
        currentHeader = map
        continue
      }
      continue
    }

    // Detail row — read using currentHeader
    const cols = splitRow(line)
    const idx = (k: Field) => currentHeader![k] !== undefined ? cols[currentHeader![k]!] : undefined
    const tan = normalizeTan(idx('deductorTan') ?? '')
    const section = normalizeSection(idx('section') ?? '')
    const tds = idx('tdsAmount')
    if (!tan || !tds) continue

    entries.push({
      part: currentPart,
      section,
      deductorTan: tan,
      deductorName: idx('deductorName') || undefined,
      quarter: normalizeQuarter(idx('quarter') ?? idx('tdsDate') ?? ''),
      amountPaid: toPaise(idx('amountPaid') ?? 0),
      tdsAmount: toPaise(tds),
      tdsDate: toIsoDate(idx('tdsDate') ?? ''),
      status: idx('status') || undefined,
    })
  }

  return { pan, assessmentYear, generatedAt, entries }
}
