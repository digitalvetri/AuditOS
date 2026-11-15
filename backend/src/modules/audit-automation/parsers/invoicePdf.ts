/**
 * Purchase / sales invoice PDF extractor (POST-DELIVERY-CHANGES §F1).
 *
 * The bank-statement reader (statementParser.ts) proved the pattern: pull
 * text items from the PDF via inspectPdf, find the fields by what they are
 * (regex + keyword proximity) rather than where they sit on the page. The
 * same approach works for invoices — every Indian tax invoice must print
 * GSTIN, invoice number, date, and the CGST/SGST/IGST/total split
 * somewhere on page 1. We don't parse LINE ITEMS here: those vary enough
 * that a naïve regex on a mixed layout is worse than letting the auditor
 * key them in. We give them the field totals they can cross-check against.
 *
 * What the doc mandates and this extractor carries forward:
 *   - "Human confirms every figure." Returning `confidence` per field is
 *     the first half of that; the review UI is the second half, in a
 *     follow-up PR. Nothing is persisted here — this endpoint is pure.
 *   - "A misread 1,80,562 as 1,08,562 in a purchase register is a wrong
 *     ITC claim." The confidence hint is deliberately pessimistic — we'd
 *     rather say 'medium' and have a person look than claim 'high' on
 *     a figure that might be a tesseract comma-vs-period slip.
 *
 * The parser is DETERMINISTIC and PURE. No I/O, no state. Given the same
 * extracted text, a second run produces the same result — useful for
 * tests and for confidence calibration over a real sample.
 */
import type { ExtractedPage, ExtractedTextItem } from '../lib/pdfInspect.js'

export type Confidence = 'high' | 'medium' | 'low'

export interface ExtractedField<T> {
  value: T | null
  /** Pre-UI hint: `high` when the regex matched in the expected context; `medium` when the match was out of context; `low` on a near-miss or multiple ambiguous matches. */
  confidence: Confidence
  /** The raw text slice the field was read from, so the reviewer can audit it. */
  source: string | null
}

export interface ExtractedInvoice {
  /** The supplier's GSTIN (the invoice issuer). The FIRST GSTIN in the
   *  'FROM' / 'SUPPLIER' / 'SELLER' context — not merely the first on page. */
  supplierGstin: ExtractedField<string>
  /** The recipient's GSTIN. The GSTIN in 'BUY' / 'BILL TO' / 'CONSIGNEE' context. */
  recipientGstin: ExtractedField<string>
  /** Guessed supplier name — the first sizeable text line BEFORE the first GSTIN. */
  supplierName: ExtractedField<string>
  /** Invoice number — alphanumeric, length 1-16 by GSTN rule. */
  invoiceNumber: ExtractedField<string>
  /** YYYY-MM-DD, normalised from DD/MM/YYYY or DD-MM-YYYY. */
  invoiceDate: ExtractedField<string>
  /** Grand total in paise. */
  totalPaise: ExtractedField<number>
  /** Taxable value in paise (pre-tax). */
  taxablePaise: ExtractedField<number>
  /** CGST paise. */
  cgstPaise: ExtractedField<number>
  /** SGST paise. */
  sgstPaise: ExtractedField<number>
  /** IGST paise. */
  igstPaise: ExtractedField<number>
  /** Any HSN/SAC codes that appeared, de-duplicated — the reviewer picks the right one per line. */
  hsnCandidates: string[]
  /** Any date-like strings detected on the page, in encounter order. Useful when the primary date was medium-confidence. */
  dateCandidates: string[]
  /** The first page's raw text joined with spaces, trimmed. Capped at 20 KB. */
  rawText: string
}

const GSTIN_RE = /\b[0-3]\d[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][Z1-9A-Z][0-9A-Z]\b/g
// Invoice number — the label matches up to the colon/space/hash separator,
// then the value is read NON-GREEDILY from the char after. Earlier we
// consumed 30 chars on the label regex and then matched '26' off the tail
// of 'Invoice No: INV-2026-0042' — now the label stops at the separator
// and the value picks up 'INV-2026-0042' before it sees 'Date:'.
const INVOICE_NO_LABEL = /\b(?:invoice\s*(?:no\.?|number|#|serial)|inv\s*(?:no\.?|#)|bill\s*no\.?)\b\s*[:#]?\s*/i
// Alphanumeric with / - _ . Stops at whitespace, so a label-and-value on
// the same line as a following 'Date:' doesn't bleed into the date.
const INVOICE_NO_VALUE = /[A-Z0-9][A-Z0-9\/\-_.]{1,15}/i
// Dates — DD/MM/YYYY or DD-MM-YYYY (Indian convention), with 2- or 4-digit year.
const DATE_RE = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})\b/g
// Indian-grouped amount: 12,34,56,789.00 or plain 123456789.00. The
// alternation puts the GROUPED (contains ',' or '.') form first so a
// well-formed amount wins over an incidental '9' in '@ 9%'.
const AMOUNT_RE = /(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{1,2}|\d{4,})/
const HSN_RE = /\b(\d{4}|\d{6}|\d{8})\b/g

/** Normalise a text node — trim, collapse interior whitespace. */
function text(item: ExtractedTextItem): string { return item.str.replace(/\s+/g, ' ').trim() }

/** Build a single flat text stream for page 1, approximating the reading order. */
function page1Text(pages: ExtractedPage[]): string {
  const p1 = pages[0]
  if (!p1) return ''
  // Sort by y descending (PDF y-origin is bottom-left), then x ascending — lines
  // top-to-bottom, within a line left-to-right. Items whose y is within 2 units
  // of each other are treated as same-line.
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

/** Indian-grouped '1,80,562.50' -> 18056250 (paise). */
export function toPaise(value: string): number | null {
  const clean = value.replace(/[,\s₹Rs.]/gi, (m) => (m === '.' ? '.' : ''))
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null
  const [whole, frac = ''] = clean.split('.')
  const paiseFrac = frac.length === 1 ? Number(frac) * 10 : Number(frac || '0')
  return Number(whole) * 100 + paiseFrac
}

/** DD/MM/YYYY -> YYYY-MM-DD; returns null on an impossible date. */
export function toIsoDate(dd: string, mm: string, yy: string): string | null {
  let y = Number(yy)
  const m = Number(mm)
  const d = Number(dd)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null
  if (y < 100) y += y < 50 ? 2000 : 1900
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  // Check the date actually exists (handles Feb 29 / 30 / 31 and 30-day months).
  const t = new Date(Date.UTC(y, m - 1, d))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Score a GSTIN by whether its surrounding text is supplier-y or recipient-y. */
function gstinContext(raw: string, idx: number): 'supplier' | 'recipient' | 'unknown' {
  const window = raw.slice(Math.max(0, idx - 120), idx).toLowerCase()
  if (/(?:bill\s*to|buyer|consignee|ship\s*to|recipient|to\s*:)/.test(window)) return 'recipient'
  if (/(?:from|seller|supplier|sold\s*by|supplied\s*by|from\s*:)/.test(window)) return 'supplier'
  return 'unknown'
}

/** Extract the primary invoice fields. Pure — no I/O, same text in → same result out. */
export function extractInvoice(pages: ExtractedPage[]): ExtractedInvoice {
  const raw = page1Text(pages)

  // ── GSTINs ─────────────────────────────────────────────────────────────
  const gstins: Array<{ value: string; idx: number; context: ReturnType<typeof gstinContext> }> = []
  for (const m of raw.matchAll(GSTIN_RE)) {
    const idx = m.index ?? 0
    gstins.push({ value: m[0], idx, context: gstinContext(raw, idx) })
  }
  const explicitSupplier = gstins.find((g) => g.context === 'supplier')
  const explicitRecipient = gstins.find((g) => g.context === 'recipient')
  // Fallback: the first GSTIN is usually the supplier (invoice letterhead).
  const first = gstins[0] ?? null
  const second = gstins[1] ?? null
  const supplier = explicitSupplier ?? first
  const recipient = explicitRecipient ?? (supplier && supplier === first ? second : first)

  // ── Supplier name — the FIRST long line before supplier's GSTIN that
  // doesn't look like a label or an address. Earlier we scanned backward
  // and got the address right above the GSTIN; now we scan forward and
  // pick the invoice's letterhead, which is the firm name.
  let supplierName: ExtractedField<string> = { value: null, confidence: 'low', source: null }
  if (supplier) {
    const before = raw.slice(0, supplier.idx)
    const lines = before.split('\n').map((l) => l.trim()).filter(Boolean)
    // Skip lines that look like a field label or an address line.
    const isLabel = (l: string) => /^(gstin|pan|tan|invoice|date|address|phone|email)/i.test(l)
    // Addresses typically carry numbers + comma-separated tokens and often
    // end in a 6-digit PIN or city/state name. The rule here is simple:
    // a line with a long digit run or ≥2 commas and a digit is probably an
    // address — not a letterhead. The supplier name is normally pure text.
    const looksLikeAddress = (l: string) => (
      /\b\d{5,}\b/.test(l) // PIN code or long house/building number
      || (l.split(',').length >= 3 && /\d/.test(l))
    )
    for (const l of lines) {
      if (l.length < 4 || l.length > 80) continue
      if (isLabel(l)) continue
      if (looksLikeAddress(l)) continue
      supplierName = { value: l, confidence: 'medium', source: l }
      break
    }
  }

  // ── Invoice number ─────────────────────────────────────────────────────
  let invoiceNumber: ExtractedField<string> = { value: null, confidence: 'low', source: null }
  const labelHit = INVOICE_NO_LABEL.exec(raw)
  if (labelHit) {
    // Read the next whitespace-delimited token after the label — not an
    // arbitrary 40-char window, because the value is normally right at
    // the cursor and a wider window picks up the value AFTER the next
    // field (e.g. the year digits of a 'Date:' that follows).
    const after = raw.slice(labelHit.index + labelHit[0].length, labelHit.index + labelHit[0].length + 40)
    const val = INVOICE_NO_VALUE.exec(after)
    if (val) invoiceNumber = { value: val[0].toUpperCase(), confidence: 'high', source: labelHit[0] + val[0] }
  }

  // ── Dates — collect, then pick the primary ─────────────────────────────
  const dateCandidates: string[] = []
  const dateMatches: Array<{ iso: string; index: number }> = []
  for (const m of raw.matchAll(DATE_RE)) {
    const iso = toIsoDate(m[1], m[2], m[3])
    if (iso) {
      dateCandidates.push(iso)
      dateMatches.push({ iso, index: m.index ?? 0 })
    }
  }
  let invoiceDate: ExtractedField<string> = { value: null, confidence: 'low', source: null }
  // Prefer the date within 40 chars after a 'date' label; fall back to first.
  const dateLabel = /\b(?:invoice\s*date|date\s*of\s*invoice|dated|date)\b/i.exec(raw)
  const nearLabel = dateLabel
    ? dateMatches.find((d) => d.index >= dateLabel.index && d.index < dateLabel.index + 60)
    : null
  const picked = nearLabel ?? dateMatches[0]
  if (picked) {
    invoiceDate = {
      value: picked.iso,
      confidence: nearLabel ? 'high' : (dateMatches.length === 1 ? 'medium' : 'low'),
      source: picked.iso,
    }
  }

  // ── Amounts — per-label keyword search ─────────────────────────────────
  function amountNear(keyword: RegExp): ExtractedField<number> {
    const hit = keyword.exec(raw)
    if (!hit) return { value: null, confidence: 'low', source: null }
    const tail = raw.slice(hit.index + hit[0].length, hit.index + hit[0].length + 80)
    const m = AMOUNT_RE.exec(tail)
    if (!m) return { value: null, confidence: 'low', source: null }
    const paise = toPaise(m[0])
    return paise === null
      ? { value: null, confidence: 'low', source: m[0] }
      : { value: paise, confidence: 'medium', source: `${hit[0]} ${m[0]}` }
  }
  const total = amountNear(/\b(?:grand\s*total|total\s*amount|invoice\s*total|total\s*payable|amount\s*payable)\b/i)
  const taxable = amountNear(/\b(?:taxable\s*(?:value|amount)|net\s*amount|sub\s*total)\b/i)
  const cgst = amountNear(/\bCGST\b/i)
  const sgst = amountNear(/\bSGST\b/i)
  const igst = amountNear(/\bIGST\b/i)

  // ── HSN candidates ─────────────────────────────────────────────────────
  const hsnSet = new Set<string>()
  for (const m of raw.matchAll(HSN_RE)) {
    // Ignore years (2000-2099) that match \d{4} — a cheap but effective filter.
    const n = Number(m[0])
    if (m[0].length === 4 && n >= 2000 && n <= 2099) continue
    hsnSet.add(m[0])
  }

  return {
    supplierGstin: {
      value: supplier?.value ?? null,
      confidence: supplier ? (supplier.context === 'supplier' ? 'high' : 'medium') : 'low',
      source: supplier?.value ?? null,
    },
    recipientGstin: {
      value: recipient?.value ?? null,
      confidence: recipient ? (recipient.context === 'recipient' ? 'high' : 'medium') : 'low',
      source: recipient?.value ?? null,
    },
    supplierName,
    invoiceNumber,
    invoiceDate,
    totalPaise: total,
    taxablePaise: taxable,
    cgstPaise: cgst,
    sgstPaise: sgst,
    igstPaise: igst,
    hsnCandidates: [...hsnSet],
    dateCandidates,
    rawText: raw,
  }
}
