import PDFDocument from 'pdfkit'
import type { Response } from 'express'
import { resolveLogoBuffer } from '../pdf/logo.js'
import { firmCompany, type Company } from './pdf.js'

/**
 * A small companion to invoice/pdf.ts for the documents that hang off an
 * invoice — the CREDIT NOTE and the PAYMENT RECEIPT. Same letterhead, same
 * navy title on the right, same rules, panels, table header and "Rs."
 * convention, so they read as one family with the tax invoice. invoice/pdf.ts
 * itself is untouched: the printed invoice must not change.
 *
 * The company block is the INVOICE's snapshot (layoutConfig.company), so a
 * credit note prints the same letterhead the invoice it corrects did.
 */

const INK = '#111827'
const NAVY = '#1f3864'
const MUTED = '#6b7280'
const RULE = '#d4d4d8'
const PANEL = '#f8fafc'

/** Indian grouping, "Rs." rather than a missing rupee glyph — see invoice/pdf.ts. */
export function pdfMoney(paise: number): string {
  const neg = paise < 0
  const n = Math.abs(paise)
  const whole = String(Math.floor(n / 100))
  const frac = String(n % 100).padStart(2, '0')
  const last3 = whole.slice(-3)
  const rest = whole.slice(0, -3)
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3
  return `${neg ? '-' : ''}${grouped}.${frac}`
}

export const fmtDay = (iso: string | null | undefined): string => {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return y && m && d ? `${d}/${m}/${y}` : iso
}

export interface DocColumn { label: string; width: number; align: 'left' | 'right' | 'center' }

export interface DocSpec {
  title: string
  filename: string
  layoutConfig: unknown
  meta: [string, string][]
  metaRight?: [string, string][]
  party: { title: string; name: string; address?: string | null; gstin?: string | null }
  columns: DocColumn[]
  rows: string[][]
  summary: { label: string; value: string; strong?: boolean }[]
  words?: string | null
  note?: { title: string; text: string } | null
  signatory?: { name?: string | null; designation?: string | null }
}

export async function streamDocPdf(res: Response, spec: DocSpec, download = false) {
  const layout = (spec.layoutConfig ?? {}) as { company?: Company }
  const company: Company = { ...(await firmCompany()), ...(layout.company ?? {}) }

  const margin = 40
  const doc = new PDFDocument({ size: 'A4', margin })
  const left = margin
  const right = doc.page.width - margin
  const width = right - left
  const bottom = doc.page.height - margin

  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${spec.filename.replace(/[^\w.-]/g, '_')}"`)
  doc.pipe(res)

  // ── Letterhead + title ─────────────────────────────────────────────────
  const top = doc.y
  let headTop = top
  const logo = resolveLogoBuffer(company.logo)
  if (logo) {
    try { doc.image(logo, left, headTop, { height: 44 }); headTop += 50 } catch { /* skip a bad logo */ }
  }
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(16).text(company.name ?? '', left, headTop, { width: width * 0.62 })
  doc.fillColor(INK).font('Helvetica').fontSize(8.5)
  ;[
    company.addressLine1, company.addressLine2,
    [company.city, company.state, company.pin].filter(Boolean).join(' '),
    company.phone, company.email, company.website,
  ].filter((l): l is string => Boolean(l && l.trim())).forEach((l) => doc.text(l, left, doc.y, { width: width * 0.62 }))
  if (company.gstin) doc.font('Helvetica-Bold').text(`GSTIN: ${company.gstin}`, left, doc.y, { width: width * 0.62 })
  const companyBottom = doc.y
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(18).text(spec.title, left, top, { width, align: 'right' })
  doc.y = Math.max(companyBottom, doc.y) + 4
  rule(doc, left, right)

  // ── Meta ───────────────────────────────────────────────────────────────
  {
    const mTop = doc.y + 6
    const colW = width / 2
    let y = mTop
    for (const [k, v] of spec.meta) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(k, left, y, { width: 100 })
      doc.fillColor(INK).font('Helvetica-Bold').text(`: ${v}`, left + 102, y, { width: colW - 110 })
      y = Math.max(y + 14, doc.y + 2)
    }
    let ry = mTop
    for (const [k, v] of spec.metaRight ?? []) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(k, left + colW, ry, { width: 100 })
      doc.fillColor(INK).font('Helvetica-Bold').text(`: ${v}`, left + colW + 102, ry, { width: colW - 110 })
      ry = Math.max(ry + 14, doc.y + 2)
    }
    doc.y = Math.max(y, ry) + 2
    rule(doc, left, right)
  }

  // ── Party ──────────────────────────────────────────────────────────────
  {
    const boxTop = doc.y + 6
    const draw = () => {
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9.5).text(spec.party.title, left + 8, boxTop + 6, { width: width - 16 })
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5).text(spec.party.name || '-', left + 8, doc.y + 1, { width: width - 16 })
      doc.font('Helvetica').fontSize(8.5)
      ;(spec.party.address ?? '').split('\n').filter(Boolean).forEach((l) => doc.text(l, left + 8, doc.y, { width: width - 16 }))
      if (spec.party.gstin) doc.text(`GSTIN ${spec.party.gstin}`, left + 8, doc.y, { width: width - 16 })
      return doc.y + 6
    }
    const end = draw()
    doc.save().rect(left, boxTop, width, end - boxTop).fill(PANEL).restore()
    doc.save().rect(left, boxTop, width, end - boxTop).strokeColor(RULE).lineWidth(0.7).stroke().restore()
    draw()
    doc.y = end + 8
  }

  // ── Table ──────────────────────────────────────────────────────────────
  const xs: number[] = []
  let acc = left
  for (const c of spec.columns) { xs.push(acc); acc += c.width * width }
  const header = () => {
    const h = 18
    const hTop = doc.y
    doc.save().rect(left, hTop, width, h).fill(NAVY).restore()
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8)
    spec.columns.forEach((c, i) => doc.text(c.label, xs[i] + 3, hTop + 5.5, { width: c.width * width - 6, align: c.align, lineBreak: false }))
    doc.y = hTop + h
  }
  header()
  doc.font('Helvetica').fontSize(8.5).fillColor(INK)
  for (const row of spec.rows) {
    const rowH = Math.max(18, ...row.map((v, i) => doc.heightOfString(v || '-', { width: spec.columns[i].width * width - 6 }) + 8))
    if (doc.y + rowH > bottom) { doc.addPage(); doc.y = margin; header(); doc.font('Helvetica').fontSize(8.5).fillColor(INK) }
    const rTop = doc.y
    row.forEach((v, i) => doc.fillColor(INK).text(v || '-', xs[i] + 3, rTop + 4, { width: spec.columns[i].width * width - 6, align: spec.columns[i].align }))
    doc.y = rTop + rowH
    doc.save().moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(RULE).lineWidth(0.5).stroke().restore()
  }
  doc.y += 8

  // ── Words / note + summary ─────────────────────────────────────────────
  if (doc.y + 120 > bottom) { doc.addPage(); doc.y = margin }
  const bandTop = doc.y
  const colW = width * 0.55
  if (spec.words) {
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9).text('Amount In Words', left, doc.y, { width: colW })
    doc.fillColor(INK).font('Helvetica').fontSize(9).text(spec.words, left, doc.y, { width: colW })
    doc.moveDown(0.4)
  }
  if (spec.note?.text) {
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9).text(spec.note.title, left, doc.y, { width: colW })
    doc.fillColor(INK).font('Helvetica').fontSize(9).text(spec.note.text, left, doc.y, { width: colW })
  }
  const leftEnd = doc.y
  const sx = left + width * 0.58
  const sw = width * 0.42
  let y = bandTop
  for (const r of spec.summary) {
    if (r.strong) doc.save().rect(sx, y - 2, sw, 15).fill('#f1f5f9').restore()
    doc.fillColor(INK).font(r.strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
    doc.text(r.label, sx + 6, y, { width: sw * 0.55 })
    doc.text(r.value, sx, y, { width: sw - 6, align: 'right' })
    y += 15
  }
  doc.y = Math.max(leftEnd, y) + 10

  // ── Signature ──────────────────────────────────────────────────────────
  if (doc.y + 70 > bottom) { doc.addPage(); doc.y = margin }
  const sy = doc.y + 10
  doc.fillColor(INK).font('Helvetica').fontSize(9).text('Authorized Signature', left, sy, { width, align: 'right' })
  const lineY = sy + 44
  doc.save().moveTo(right - 170, lineY).lineTo(right, lineY).strokeColor(MUTED).lineWidth(0.7).stroke().restore()
  let after = lineY + 4
  if (spec.signatory?.name) { doc.font('Helvetica-Bold').fontSize(9).text(spec.signatory.name, left, after, { width, align: 'right' }); after = doc.y }
  if (spec.signatory?.designation) { doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(spec.signatory.designation, left, after, { width, align: 'right' }) }

  doc.end()
}

function rule(doc: PDFKit.PDFDocument, left: number, right: number) {
  const y = doc.y + 2
  doc.save().moveTo(left, y).lineTo(right, y).strokeColor(RULE).lineWidth(0.8).stroke().restore()
  doc.y = y + 4
}
