/**
 * Transit-document PDF extractor (POST-DELIVERY-CHANGES §F2).
 *
 * The client's "transit" means lorry receipts and delivery challans — paper
 * (now PDF) documents produced by transporters and sellers to accompany
 * goods, not the government e-way-bill portal. Same contract as the
 * invoice extractor (§F1): PURE, DETERMINISTIC, returns a per-field
 * confidence so the reviewer can light up the uncertain ones.
 *
 * Fields on a typical LR / delivery challan:
 *   LR / Challan No        'LR No', 'Consignment No', 'GC No', 'Challan No'
 *   Date                   DD/MM/YYYY
 *   Consignor              sender (name, sometimes GSTIN)
 *   Consignee              receiver (name, sometimes GSTIN)
 *   Vehicle No             Indian plate (MH 04 AB 1234 / TN01AB1234)
 *   From                   origin city/station
 *   To                     destination city/station
 *   Goods description      free text
 *   Quantity               '50 bundles', '12 cartons', '250 kgs' — stored as a string
 *   Value                  invoice value in paise (nullable; many LRs omit it)
 *
 * The reviewer types goods & quantity when the extractor can't read them;
 * we return 'low' confidence so the UI will prompt a look.
 */
import type { ExtractedPage, ExtractedTextItem } from '../lib/pdfInspect.js'
import { toIsoDate, toPaise } from './invoicePdf.js'
import { checkDate, checkDistinct, checkGstin } from './extractChecks.js'

export type Confidence = 'high' | 'medium' | 'low'

export interface ExtractedField<T> {
  value: T | null
  confidence: Confidence
  source: string | null
}

export interface ExtractedTransit {
  /** Lorry Receipt / Challan / GC / Consignment number. */
  docNumber: ExtractedField<string>
  /** 'lorry_receipt' | 'delivery_challan' — guessed from the document header. */
  docType: 'lorry_receipt' | 'delivery_challan' | 'unknown'
  docDate: ExtractedField<string>
  consignor: ExtractedField<string>
  consignorGstin: ExtractedField<string>
  consignee: ExtractedField<string>
  consigneeGstin: ExtractedField<string>
  vehicleNumber: ExtractedField<string>
  fromPlace: ExtractedField<string>
  toPlace: ExtractedField<string>
  goodsDescription: ExtractedField<string>
  /** Free-form quantity string — '50 bundles', '12 cartons', '250 kgs'. */
  quantity: ExtractedField<string>
  valuePaise: ExtractedField<number>
  /** Candidate dates on the page in encounter order. */
  dateCandidates: string[]
  /** First page's text, trimmed; capped 20 KB. */
  rawText: string
  /** Checks that failed (GSTIN check digit, same GSTIN twice, date). */
  warnings: string[]
}

const GSTIN_RE = /\b[0-3]\d[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][Z1-9A-Z][0-9A-Z]\b/g
const DATE_RE = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})\b/g

// Indian vehicle plate. The RTO code (TN, MH, KA, …) is two letters; the
// serial district is 1-2 digits; the alphabet code is 1-3 letters; the
// four-digit serial finishes it. Separators are optional. Case-insensitive
// — the parser uppercases the final value.
const VEHICLE_RE = /\b([A-Z]{2})\s*-?\s*(\d{1,2})\s*-?\s*([A-Z]{1,3})?\s*-?\s*(\d{4})\b/i

// LR/Challan/GC number. Labels first; the value is the first token on the
// same line that looks like an identifier (alphanumeric, length 3-20).
const DOC_NO_LABEL = /\b(?:lorry\s*receipt(?:\s*no\.?)?|lr\s*no\.?|l\s*\.?\s*r\s*\.?\s*no\.?|consignment\s*(?:note\s*)?no\.?|cn\s*no\.?|gc\s*no\.?|delivery\s*challan(?:\s*no\.?)?|dc\s*no\.?|challan\s*no\.?)\b\s*[:#]?\s*/i
const DOC_NO_VALUE = /[A-Z0-9][A-Z0-9\/\-_.]{2,19}/i

// Amount: Indian-grouped or plain decimal, with the same bias as the
// invoice extractor — grouped (comma or period) wins over a bare integer.
const AMOUNT_RE = /(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{1,2}|\d{4,})/

function text(item: ExtractedTextItem): string { return item.str.replace(/\s+/g, ' ').trim() }

/** Flatten the first page into a top-to-bottom, left-to-right text stream. */
function page1Text(pages: ExtractedPage[]): string {
  const p1 = pages[0]
  if (!p1) return ''
  const items = [...p1.items].map((it, i) => ({ it, i }))
  items.sort((a, b) => (b.it.y - a.it.y) || (a.it.x - b.it.x) || (a.i - b.i))
  const out: string[] = []
  let curY = Number.POSITIVE_INFINITY
  let line: string[] = []
  const flush = () => { if (line.length) { out.push(line.join(' ')); line = [] } }
  for (const { it } of items) {
    if (Math.abs(curY - it.y) > 2) { flush(); curY = it.y }
    const s = text(it)
    if (s) line.push(s)
  }
  flush()
  return out.join('\n').slice(0, 20_000)
}

function typeFromText(raw: string): ExtractedTransit['docType'] {
  // Order matters: a transporter's LR sometimes also carries the words
  // 'delivery' or 'challan' incidentally, so look for the LR/GC/CN markers
  // first and fall back to the challan markers.
  const lower = raw.slice(0, 1_000).toLowerCase()
  if (/\b(?:lorry\s*receipt|consignment\s*(?:note|no)|gc\s*no|cn\s*no|lr\s*no|l\.?r\.?\s*no)\b/.test(lower)) return 'lorry_receipt'
  if (/\b(?:delivery\s*challan|dc\s*no|challan\s*no)\b/.test(lower)) return 'delivery_challan'
  return 'unknown'
}

function partyContext(raw: string, idx: number): 'consignor' | 'consignee' | 'unknown' {
  // Look back 160 chars for the party label — the sender/receiver blocks
  // usually span a few lines, so the GSTIN or name sits well below the
  // header word.
  const window = raw.slice(Math.max(0, idx - 160), idx).toLowerCase()
  if (/(?:consignee|ship\s*to|delivered\s*to|to\s*:|receiver)/.test(window)) return 'consignee'
  if (/(?:consignor|shipper|sender|from\s*:|billed\s*from)/.test(window)) return 'consignor'
  return 'unknown'
}

function nameNear(raw: string, labelRe: RegExp, within = 200): ExtractedField<string> {
  const m = labelRe.exec(raw)
  if (!m) return { value: null, confidence: 'low', source: null }
  const after = raw.slice(m.index + m[0].length, m.index + m[0].length + within)
  // Skip the inline separator and read the first non-empty line that doesn't
  // look like a label (prevents 'Consignor: Address:' bleed).
  const lines = after.split('\n').map((l) => l.trim()).filter(Boolean)
  const isLabel = (l: string) => /^(address|gstin|pan|phone|email|date|invoice|vehicle)/i.test(l)
  for (const l of lines) {
    if (l.length < 2 || l.length > 80) continue
    if (isLabel(l)) continue
    // Strip trailing GSTIN if present (common on single-line layouts).
    const cleaned = l.replace(GSTIN_RE, '').replace(/[,;:]\s*$/, '').trim()
    if (cleaned.length < 2) continue
    return { value: cleaned, confidence: 'medium', source: `${m[0]}${l}` }
  }
  return { value: null, confidence: 'low', source: null }
}

/** FROM / TO places — short tokens on the same line as the label. */
function placeNear(raw: string, labelRe: RegExp): ExtractedField<string> {
  const m = labelRe.exec(raw)
  if (!m) return { value: null, confidence: 'low', source: null }
  const after = raw.slice(m.index + m[0].length, m.index + m[0].length + 120)
  // First line only — places are single words or 'City, State'.
  const firstLine = after.split('\n')[0].trim()
  if (!firstLine) return { value: null, confidence: 'low', source: null }
  // Strip leading separator chars; stop at the next ':' label.
  const cleaned = firstLine.replace(/^[:#\s]+/, '').split(/\s{2,}|\b(?=To\b|TO\b|Date\b|Vehicle\b)/)[0].trim()
  if (cleaned.length < 2 || cleaned.length > 60) return { value: null, confidence: 'low', source: null }
  return { value: cleaned, confidence: 'medium', source: `${m[0]}${firstLine}` }
}

/** Quantity — the first token after a 'quantity', 'packages', 'no of pkgs' label. */
function quantityNear(raw: string): ExtractedField<string> {
  const m = /\b(?:quantity|qty\.?|no\.?\s*of\s*(?:packages|pkgs|bundles|cartons)|number\s*of\s*packages|packages|articles)\b\s*[:#]?\s*/i.exec(raw)
  if (!m) return { value: null, confidence: 'low', source: null }
  const after = raw.slice(m.index + m[0].length, m.index + m[0].length + 60)
  // Capture a number + unit pair (e.g. '50 bundles', '12 cartons', '250 kgs')
  // or just a bare number. Stop at newline.
  const line = after.split('\n')[0].trim()
  const hit = /^(\d+(?:\.\d+)?\s*[A-Za-z][A-Za-z\s]{0,20}|\d+(?:\.\d+)?)/i.exec(line)
  if (!hit) return { value: null, confidence: 'low', source: null }
  return { value: hit[0].trim(), confidence: 'medium', source: `${m[0]}${hit[0]}` }
}

/** Extract LR / delivery challan fields. Pure. */
export function extractTransit(pages: ExtractedPage[]): ExtractedTransit {
  const raw = page1Text(pages)
  const docType = typeFromText(raw)

  // ── GSTINs ─────────────────────────────────────────────────────────────
  const gstins: Array<{ value: string; idx: number; context: ReturnType<typeof partyContext> }> = []
  for (const m of raw.matchAll(GSTIN_RE)) {
    const idx = m.index ?? 0
    gstins.push({ value: m[0], idx, context: partyContext(raw, idx) })
  }
  const explicitConsignor = gstins.find((g) => g.context === 'consignor')
  const explicitConsignee = gstins.find((g) => g.context === 'consignee')
  const first = gstins[0] ?? null
  const second = gstins[1] ?? null
  const consignor = explicitConsignor ?? first
  const consignee = explicitConsignee ?? (consignor && consignor === first ? second : first)

  // ── Doc number ─────────────────────────────────────────────────────────
  let docNumber: ExtractedField<string> = { value: null, confidence: 'low', source: null }
  const docLabel = DOC_NO_LABEL.exec(raw)
  if (docLabel) {
    const after = raw.slice(docLabel.index + docLabel[0].length, docLabel.index + docLabel[0].length + 40)
    const val = DOC_NO_VALUE.exec(after)
    if (val) docNumber = { value: val[0].toUpperCase(), confidence: 'high', source: `${docLabel[0]}${val[0]}` }
  }

  // ── Dates ─────────────────────────────────────────────────────────────
  const dateCandidates: string[] = []
  const dateMatches: Array<{ iso: string; index: number }> = []
  for (const m of raw.matchAll(DATE_RE)) {
    const iso = toIsoDate(m[1], m[2], m[3])
    if (iso) { dateCandidates.push(iso); dateMatches.push({ iso, index: m.index ?? 0 }) }
  }
  let docDate: ExtractedField<string> = { value: null, confidence: 'low', source: null }
  const dateLabel = /\b(?:date|dated|lr\s*date|challan\s*date)\b/i.exec(raw)
  const nearLabel = dateLabel ? dateMatches.find((d) => d.index >= dateLabel.index && d.index < dateLabel.index + 60) : null
  const picked = nearLabel ?? dateMatches[0]
  if (picked) {
    docDate = {
      value: picked.iso,
      confidence: nearLabel ? 'high' : (dateMatches.length === 1 ? 'medium' : 'low'),
      source: picked.iso,
    }
  }

  // ── Consignor / consignee names ────────────────────────────────────────
  const consignorName = nameNear(raw, /\b(?:consignor|shipper|sender|from)\s*[:#]\s*/i)
  const consigneeName = nameNear(raw, /\b(?:consignee|receiver|to)\s*[:#]\s*/i)

  // ── Vehicle number ────────────────────────────────────────────────────
  let vehicleNumber: ExtractedField<string> = { value: null, confidence: 'low', source: null }
  const vLabel = /\b(?:vehicle\s*(?:no\.?|number|#)|lorry\s*no\.?|truck\s*no\.?|vehicle)\b\s*[:#]?\s*/i.exec(raw)
  const scanFrom = vLabel ? raw.slice(vLabel.index, vLabel.index + 60) : raw
  const vMatch = VEHICLE_RE.exec(scanFrom)
  if (vMatch) {
    // Normalise: strip hyphens & interior spaces, uppercase.
    const compact = vMatch[0].replace(/\s+|-/g, '').toUpperCase()
    vehicleNumber = {
      value: compact,
      confidence: vLabel ? 'high' : 'medium',
      source: vMatch[0],
    }
  }

  // ── From / To ─────────────────────────────────────────────────────────
  const fromPlace = placeNear(raw, /\bfrom\s*[:#]\s*/i)
  const toPlace = placeNear(raw, /\bto\s*[:#]\s*/i)

  // ── Goods description ─────────────────────────────────────────────────
  let goodsDescription: ExtractedField<string> = { value: null, confidence: 'low', source: null }
  const goodsLabel = /\b(?:description\s*of\s*goods|nature\s*of\s*goods|goods|particulars|description)\b\s*[:#]?\s*/i.exec(raw)
  if (goodsLabel) {
    const after = raw.slice(goodsLabel.index + goodsLabel[0].length, goodsLabel.index + goodsLabel[0].length + 200)
    const line = after.split('\n').find((l) => l.trim().length > 2)
    if (line) {
      const cleaned = line.replace(/^[:#\s]+/, '').trim().slice(0, 200)
      if (cleaned.length >= 2) goodsDescription = { value: cleaned, confidence: 'medium', source: `${goodsLabel[0]}${cleaned}` }
    }
  }

  // ── Quantity ──────────────────────────────────────────────────────────
  const quantity = quantityNear(raw)

  // ── Value ─────────────────────────────────────────────────────────────
  let valuePaise: ExtractedField<number> = { value: null, confidence: 'low', source: null }
  const valueLabel = /\b(?:invoice\s*value|value\s*of\s*goods|declared\s*value|total\s*value|value)\b\s*[:#]?\s*(?:rs\.?|₹|inr)?\s*/i.exec(raw)
  if (valueLabel) {
    const tail = raw.slice(valueLabel.index + valueLabel[0].length, valueLabel.index + valueLabel[0].length + 60)
    const m = AMOUNT_RE.exec(tail)
    if (m) {
      const paise = toPaise(m[0])
      if (paise !== null) valuePaise = { value: paise, confidence: 'medium', source: `${valueLabel[0]}${m[0]}` }
    }
  }

  const warnings: string[] = []
  const consignorGstin = checkGstin({
    value: consignor?.value ?? null,
    confidence: consignor ? (consignor.context === 'consignor' ? 'high' : 'medium') : 'low',
    source: consignor?.value ?? null,
  }, 'Consignor GSTIN', warnings)
  const consigneeGstin = checkDistinct(consignorGstin, checkGstin({
    value: consignee?.value ?? null,
    confidence: consignee ? (consignee.context === 'consignee' ? 'high' : 'medium') : 'low',
    source: consignee?.value ?? null,
  }, 'Consignee GSTIN', warnings), 'consignee', warnings)

  return {
    docNumber,
    docType,
    docDate: checkDate(docDate, 'document date', warnings),
    consignor: consignorName,
    consignorGstin,
    consignee: consigneeName,
    consigneeGstin,
    vehicleNumber,
    fromPlace,
    toPlace,
    goodsDescription,
    quantity,
    valuePaise,
    dateCandidates,
    rawText: raw,
    warnings,
  }
}
