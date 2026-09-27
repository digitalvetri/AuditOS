import {
  type NormalizedTdsEntry,
  type ParsedTds26AS,
  normalizeSection,
  normalizeTan,
  normalizeQuarter,
  parseAy,
  tdsDate,
  toPaise,
  PAN_RE,
  TAN_RE,
} from './tdsTypes.js'
import type { ExtractedPage } from '../lib/pdfInspect.js'
import { pdfRows } from '../lib/statementParser.js'

/**
 * Form 26AS readers — the TRACES text download (`^`-delimited), the
 * TRACES PDF, and older pipe/tab layouts.
 *
 * The statement lists, per PART, a deductor summary row followed by that
 * deductor's transactions:
 *
 *   PART-I - Details of Tax Deducted at Source
 *   Sr. No.^Name of Deductor^TAN of Deductor^^^^^Total Amount Paid / Credited^Total Tax Deducted^Total TDS Deposited
 *   1^ACME STEEL PRIVATE LIMITED^MUMA12345B^^^^^100000.00^10000.00^10000.00
 *   ^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Remarks^Amount Paid / Credited^Tax Deducted^TDS Deposited
 *   ^1^194J^15-Jun-2025^F^20-Aug-2025^-^50000.00^5000.00^5000.00
 *
 * Transactions carry no TAN of their own — it comes from the summary row
 * above. Only the parts that are tax credits of the assessee are read:
 * I (TDS), II (15G/15H), III (194B/194R/194S proviso), IV (194IA/IB/M/S as
 * seller / landlord / payee), V (26QE) and VI (TCS). VII (refunds), VIII
 * (the assessee as deductor), IX and X are not credits and are skipped.
 */

/** Part → stored code; null = not a credit, skip it. */
const PARTS: [RegExp, string | null][] = [
  [/^PART\s*[-–]?\s*VIII\b/i, null],
  [/^PART\s*[-–]?\s*VII\b/i, null],
  [/^PART\s*[-–]?\s*VI\b/i, 'part_vi'],
  [/^PART\s*[-–]?\s*IV\b/i, 'part_iv'],
  [/^PART\s*[-–]?\s*V\b/i, 'part_v'],
  [/^PART\s*[-–]?\s*IX\b/i, null],
  [/^PART\s*[-–]?\s*X\b/i, null],
  [/^PART\s*[-–]?\s*III\b/i, 'part_iii'],
  [/^PART\s*[-–]?\s*II\b/i, 'part_ii'],
  [/^PART\s*[-–]?\s*I\b/i, 'part_i'],
  // Older 26AS layout.
  [/^PART\s*[-–]?\s*A\s*1\b/i, 'part_ii'],
  [/^PART\s*[-–]?\s*A\s*2\b/i, 'part_iv'],
  [/^PART\s*[-–]?\s*A\b/i, 'part_i'],
  [/^PART\s*[-–]?\s*B\b/i, 'part_vi'],
  [/^PART\s*[-–]?\s*[C-H]\b/i, null],
]

export const PART_LABEL: Record<string, string> = {
  part_i: 'Part I — TDS', part_ii: 'Part II — 15G/15H', part_iii: 'Part III — 194B/194R/194S proviso',
  part_iv: 'Part IV — 194IA/IB/M/S', part_v: 'Part V — 26QE', part_vi: 'Part VI — TCS',
}

function partOf(text: string): { hit: boolean; part: string | null } {
  const t = text.trim()
  for (const [re, part] of PARTS) if (re.test(t)) return { hit: true, part }
  return { hit: false, part: null }
}

type SumCol = 'name' | 'id' | 'paid'
type DetCol = 'section' | 'date' | 'status' | 'bookingDate' | 'remarks' | 'paid' | 'tax' | 'deposited'

function sumHeader(f: string[]): Partial<Record<SumCol, number>> | null {
  const m: Partial<Record<SumCol, number>> = {}
  f.forEach((c, i) => {
    if (m.name === undefined && /name\s*of\s*(the\s*)?(deductor|collector|buyer|payer)/i.test(c)) m.name = i
    else if (m.id === undefined && /\b(tan|pan)\s*of\s*(the\s*)?(deductor|collector|buyer|payer)/i.test(c)) m.id = i
    else if (m.paid === undefined && /total.*(amount|transaction)/i.test(c)) m.paid = i
  })
  return m.name !== undefined || m.id !== undefined ? m : null
}

function detHeader(f: string[]): Partial<Record<DetCol, number>> | null {
  const m: Partial<Record<DetCol, number>> = {}
  f.forEach((c, i) => {
    const t = c.toLowerCase()
    if (m.section === undefined && /^section/.test(t)) m.section = i
    else if (m.date === undefined && /(transaction|deposit|payment)\s*date|date\s*of\s*(transaction|deposit|payment)/.test(t)) m.date = i
    else if (m.status === undefined && /status\s*of\s*booking/.test(t)) m.status = i
    else if (m.bookingDate === undefined && /date\s*of\s*booking/.test(t)) m.bookingDate = i
    else if (m.remarks === undefined && /^remarks/.test(t)) m.remarks = i
    else if (m.paid === undefined && /amount\s*paid|amount\s*credited|paid\s*\/\s*(credited|debited)|transaction\s*amount/.test(t)) m.paid = i
    else if (m.tax === undefined && /(tax|tds|tcs)\s*(deducted|collected)/.test(t)) m.tax = i
    else if (m.deposited === undefined && /(tds|tcs|tax)\s*deposited/.test(t)) m.deposited = i
  })
  return m.section !== undefined && (m.tax !== undefined || m.deposited !== undefined) ? m : null
}

const money = (s: string | undefined) => toPaise(String(s ?? '').replace(/[,\s₹]/g, '') || 0)
const STATUS_RE = /^[FPUOZM]$/

/** The file header: "Permanent Account Number (PAN)^…^Financial Year^Assessment Year^Name of Assessee…" then the values. */
function readHeader(rows: string[][], out: ParsedTds26AS) {
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const f = rows[i]
    const panAt = f.findIndex((c) => /permanent\s*account\s*number/i.test(c))
    if (panAt < 0) continue
    const v = rows.slice(i + 1).find((r) => r.some((c) => c.trim())) ?? []
    const at = (re: RegExp) => { const k = f.findIndex((c) => re.test(c)); return k >= 0 ? (v[k] ?? '').trim() : '' }
    const pan = at(/permanent\s*account\s*number/i)
    if (PAN_RE.test(pan)) out.pan = pan
    out.financialYear = at(/financial\s*year/i) || undefined
    out.assessmentYear = parseAy(at(/assessment\s*year/i)) ?? (out.financialYear ? (parseAy(out.financialYear)! + 1) : undefined)
    out.assesseeName = at(/name\s*of\s*(the\s*)?assessee/i) || undefined
    const created = tdsDate(at(/file\s*creation\s*date|date\s*of\s*creation/i))
    if (created) out.generatedAt = created
    return
  }
  // Older text files: "Assessment Year : 2027-28", a PAN somewhere near the top.
  for (const f of rows.slice(0, 40)) {
    const line = f.join(' ')
    if (!out.pan) { const p = /\b([A-Z]{5}\d{4}[A-Z])\b/.exec(line); if (p) out.pan = p[1] }
    if (!out.assessmentYear) { const a = /assessment\s*year[^\d]*(\d{4})/i.exec(line); if (a) out.assessmentYear = Number(a[1]) }
    if (!out.generatedAt) { const g = /(?:generated\s+on|view\s+as\s+on|as\s+on)\s*[:\-]?\s*([\w\-\/\.]+)/i.exec(line); if (g) out.generatedAt = tdsDate(g[1]) || undefined }
  }
}

/** Walk rows (text fields or PDF cells) PART by PART, deductor by deductor. */
function readParts(rows: string[][], positional: boolean): NormalizedTdsEntry[] {
  const entries: NormalizedTdsEntry[] = []
  let part: string | null = null
  let inPart = false
  let sh: Partial<Record<SumCol, number>> | null = null
  let dh: Partial<Record<DetCol, number>> | null = null
  let deductor: { id: string; name?: string } | null = null
  // PDF: a long deductor name wraps onto the lines above and below its row.
  let loose: string[] = []
  let justRead = false

  for (const raw of rows) {
    // PDF cells run together ("HYDN12345C 80000.00"); read them word by word.
    const f = positional ? raw.flatMap((c) => c.trim().split(/\s+/)).filter(Boolean) : raw.map((c) => c.trim())
    const joined = f.filter(Boolean).join(' ')
    if (!joined) continue
    if (positional) {
      const textOnly = !/\d/.test(joined) && !partOf(joined).hit
      if (textOnly && justRead && deductor && joined.length < 80) { deductor.name = `${deductor.name ?? ''} ${joined}`.trim(); justRead = false; continue }
      justRead = false
      if (textOnly) { loose.push(joined); if (loose.length > 2) loose.shift() }
    }
    const p = partOf(joined)
    if (p.hit) { part = p.part; inPart = true; sh = null; dh = null; deductor = null; continue }
    if (!inPart || !part) continue

    if (!positional) {
      const d = detHeader(f)
      if (d) { dh = d; continue }
      const s = sumHeader(f)
      if (s && !f.some((c) => TAN_RE.test(c) || PAN_RE.test(c))) { sh = s; continue }
    }

    // Summary row: a serial number and the deductor's TAN (or PAN, in Part IV).
    const idCell = f.find((c) => TAN_RE.test(c)) ?? f.find((c) => PAN_RE.test(c))
    const serialFirst = /^\d+$/.test(f[0] ?? '')
    const hasDate = f.some((c) => Boolean(tdsDate(c)) && /[A-Za-z]{3}|[\/-]/.test(c))
    if (idCell && serialFirst && !hasDate) {
      const nameAt = sh?.name
      let name = nameAt !== undefined && !positional ? f[nameAt] : f.slice(1, f.indexOf(idCell)).join(' ')
      if (positional) {
        // The line just above belongs to this name unless it is a column header.
        const above = loose[loose.length - 1]
        if (above && !/deductor|collector|credited|name|paid/i.test(above)) name = `${above} ${name}`
        loose = []
        justRead = true
      }
      deductor = { id: normalizeTan(idCell), name: name?.trim() || undefined }
      continue
    }
    if (!deductor) continue

    // Transaction row.
    if (!positional && dh) {
      const get = (k: DetCol) => (dh![k] !== undefined ? f[dh![k]!] : undefined)
      const section = normalizeSection(get('section') ?? '')
      const date = tdsDate(get('date') ?? '')
      if (!section && !date) continue
      const tax = money(get('tax') ?? get('deposited'))
      const deposited = get('deposited') !== undefined ? money(get('deposited')) : tax
      if (!tax && !deposited) continue
      const status = (get('status') ?? '').toUpperCase()
      entries.push({
        part, section, deductorTan: deductor.id, deductorName: deductor.name,
        quarter: normalizeQuarter(date), tdsDate: date,
        amountPaid: money(get('paid')), tdsAmount: tax || deposited, tdsDeposited: deposited,
        status: STATUS_RE.test(status) ? status : undefined,
        bookingDate: tdsDate(get('bookingDate') ?? '') || undefined,
        remarks: (get('remarks') ?? '').replace(/^-$/, '') || undefined,
      })
      continue
    }

    // PDF: no reliable columns — read the row's shape.
    const section = f.map((c) => normalizeSection(c)).find((s, i) => s && /^(19[2-6][A-Z]{0,3}|206C\w*)$/.test(f[i].replace(/\s|\(.*\)/g, '').toUpperCase())) ?? ''
    const dates = f.map((c) => (/[A-Za-z]{3}|[\/-]/.test(c) ? tdsDate(c) : '')).filter(Boolean)
    if (!section || !dates.length) continue
    const amounts = f.filter((c) => /^-?[\d,]+\.\d{2}$/.test(c)).map(money)
    if (!amounts.length) continue
    const status = f.find((c) => STATUS_RE.test(c))
    // Part I/VI: paid, deducted, deposited. Part IV: deposited only (and maybe demand).
    const [paid, tax, deposited] = amounts.length >= 3 ? amounts.slice(-3) : amounts.length === 2 ? [amounts[0], amounts[1], amounts[1]] : [0, amounts[0], amounts[0]]
    entries.push({
      part, section, deductorTan: deductor.id, deductorName: deductor.name,
      quarter: normalizeQuarter(dates[0]), tdsDate: dates[0], bookingDate: dates[1],
      amountPaid: paid, tdsAmount: tax, tdsDeposited: deposited, status,
    })
  }
  return entries
}

/** Older pipe / tab / column layouts with one header per PART and a TAN on every row. */
function readLegacy(lines: string[]): NormalizedTdsEntry[] {
  const split = (line: string) => line.includes('|') ? line.split('|') : line.includes('\t') ? line.split('\t') : line.split(/\s{2,}/)
  const entries: NormalizedTdsEntry[] = []
  let part: string | null = null
  let head: Record<string, number> | null = null
  const alias: Record<string, RegExp> = {
    section: /^section/i, tan: /\btan\b/i, name: /name\s*of\s*deductor|deductor\s*name/i, quarter: /^quarter$|^qtr/i,
    paid: /amount\s*(paid|credited)/i, tax: /(tds|tax)\s*deducted/i, date: /transaction\s*date|date\s*of\s*(payment|booking)|booking\s*date/i, status: /^status/i,
  }
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) { head = null; continue }
    const p = partOf(line)
    if (p.hit) { part = p.part; head = null; continue }
    if (!part) continue
    const f = split(line).map((c) => c.trim())
    if (!head) {
      const h: Record<string, number> = {}
      f.forEach((c, i) => { for (const [k, re] of Object.entries(alias)) if (h[k] === undefined && re.test(c)) h[k] = i })
      if (h.tax !== undefined && (h.tan !== undefined || h.section !== undefined)) head = h
      continue
    }
    const g = (k: string) => (head![k] !== undefined ? f[head![k]] : undefined)
    const tan = normalizeTan(g('tan') ?? '')
    if (!tan || !g('tax')) continue
    const date = tdsDate(g('date') ?? '')
    const status = (g('status') ?? '').trim().toUpperCase().slice(0, 1)
    entries.push({
      part, section: normalizeSection(g('section') ?? ''), deductorTan: tan, deductorName: g('name') || undefined,
      quarter: normalizeQuarter(g('quarter') ?? date), amountPaid: money(g('paid')), tdsAmount: money(g('tax')),
      tdsDeposited: money(g('tax')), tdsDate: date, status: STATUS_RE.test(status) ? status : undefined,
    })
  }
  return entries
}

export function parseTds26ASText(bytes: Buffer): ParsedTds26AS {
  const text = bytes.toString('utf8').replace(/^﻿/, '')
  const lines = text.split(/\r?\n/)
  const out: ParsedTds26AS = { entries: [] }
  const caret = lines.filter((l) => l.includes('^')).length > 3
  const rows = lines.map((l) => (caret ? l.split('^') : [l]))
  readHeader(caret ? rows : lines.map((l) => [l]), out)
  out.entries = caret ? readParts(rows, false) : readLegacy(lines)
  return out
}

export function parseTds26ASPdf(pages: ExtractedPage[]): ParsedTds26AS {
  const rows = pdfRows(pages).map((r) => r.cells)
  const out: ParsedTds26AS = { entries: [] }
  // Header: PAN, FY, AY and name sit in a small table on page 1.
  const top = rows.slice(0, 40)
  const flat = top.map((r) => r.join(' ')).join('\n')
  const pan = /\b([A-Z]{5}\d{4}[A-Z])\b/.exec(flat.split(/permanent\s*account\s*number/i)[1] ?? flat)
  if (pan) out.pan = pan[1]
  for (let i = 0; i < top.length; i++) {
    const line = top[i].join(' ')
    if (/assessment\s*year/i.test(line)) {
      const years = [...(line + ' ' + (top[i + 1] ?? []).join(' ')).matchAll(/\b(20\d{2})\s*-\s*(\d{2})\b/g)].map((m) => Number(m[1]))
      if (years.length >= 2) { out.financialYear = `${years[0]}-${String((years[0] + 1) % 100).padStart(2, '0')}`; out.assessmentYear = years[1] }
      else if (years.length === 1) out.assessmentYear = years[0]
      const name = /name\s*of\s*(the\s*)?assessee\s*:?\s*(.+)$/i.exec(line)
      if (name) out.assesseeName = name[2].trim()
    }
  }
  out.entries = readParts(rows, true)
  return out
}
