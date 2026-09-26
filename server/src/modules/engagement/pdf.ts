import PDFDocument from 'pdfkit'
import type { Response } from 'express'
import type { Row } from './service.js'
import { resolveLogoBuffer } from '../pdf/logo.js'

/**
 * ENGAGEMENT LETTER PDF.
 *
 * Walks the same ordered `blockConfig` the builder edits and the browser
 * preview renders, with the same block kinds, the same placeholder
 * substitution and the same list styles — so the letter a client receives is
 * the letter that was composed. Sections the user disabled are absent here
 * too. Normal vertical flow throughout: every draw returns the cursor to the
 * left margin (see `home`), which is what keeps a section from inheriting the
 * x of whatever column was written last and wrapping into a narrow strip.
 */

interface Block {
  id?: string
  key: string
  enabled?: boolean
  title?: string
  body?: string
  listStyle?: 'none' | 'bullet' | 'number'
  lines?: Line[]
  heightPx?: number
}

/** One paragraph or list item — the same shape the builder edits. */
interface Line {
  id?: string
  kind?: 'p' | 'bullet' | 'number'
  align?: 'left' | 'center' | 'right' | 'justify'
  indent?: number
  html?: string
}

interface Run { text: string; b: boolean; i: boolean; u: boolean }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }
const decode = (t: string) => t
  .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
  .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)

/**
 * The stored inline HTML (b, i, u, br only — the browser whitelists it) into
 * styled text runs. Tolerant by design: an unknown tag is skipped, never
 * printed, so a malformed line degrades to plain text instead of failing.
 */
function parseInline(html: string, vars: Record<string, string>): Run[] {
  const runs: Run[] = []
  let b = 0, i = 0, u = 0
  const re = /<\s*(\/)?\s*([a-zA-Z]+)[^>]*>|([^<]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (m[3] !== undefined) {
      const t = fill(decode(m[3]), vars)
      if (t) runs.push({ text: t, b: b > 0, i: i > 0, u: u > 0 })
      continue
    }
    const tag = m[2].toLowerCase()
    if (tag === 'br') { runs.push({ text: '\n', b: b > 0, i: i > 0, u: u > 0 }); continue }
    const d = m[1] ? -1 : 1
    if (tag === 'b' || tag === 'strong') b = Math.max(0, b + d)
    else if (tag === 'i' || tag === 'em') i = Math.max(0, i + d)
    else if (tag === 'u') u = Math.max(0, u + d)
  }
  return runs
}

interface Fonts { regular: string; bold: string; italic: string; boldItalic: string }
const SANS: Fonts = { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique' }
const SERIF: Fonts = { regular: 'Times-Roman', bold: 'Times-Bold', italic: 'Times-Italic', boldItalic: 'Times-BoldItalic' }

const fontOf = (r: Run, F: Fonts) =>
  r.b && r.i ? F.boldItalic : r.b ? F.bold : r.i ? F.italic : F.regular

/**
 * The letter's Layout tab, read with the same defaults the screen uses, so a
 * letter saved before Layout existed prints exactly as it always did.
 */
interface Layout {
  pageSize: 'A4' | 'Letter'
  orientation: 'portrait' | 'landscape'
  margin: 'narrow' | 'normal' | 'wide'
  font: 'sans' | 'serif'
  fontSize: number
  lineHeight: 'tight' | 'normal' | 'relaxed'
  headingSize: 'compact' | 'normal' | 'large'
  headerStyle: 'rule' | 'bar' | 'plain'
  footerStyle: 'page-numbers' | 'company' | 'none'
  logoPosition: 'left' | 'center' | 'right'
}
const DEFAULT_LAYOUT: Layout = {
  pageSize: 'A4', orientation: 'portrait', margin: 'normal', font: 'sans', fontSize: 10.5,
  lineHeight: 'normal', headingSize: 'normal', headerStyle: 'rule', footerStyle: 'page-numbers', logoPosition: 'center',
}
const MARGIN_MM = { narrow: 12, normal: 18, wide: 25 }
const LINE_HEIGHT = { tight: 1.35, normal: 1.55, relaxed: 1.8 }
const HEADING = { compact: 1.0, normal: 1.08, large: 1.25 }

const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A block's lines — or, for a letter saved before lines existed, its plain body. */
function linesOf(b: Block): Line[] {
  if (Array.isArray(b.lines)) return b.lines
  const t = (b.body ?? '').trim()
  if (!t) return []
  if (b.listStyle === 'bullet' || b.listStyle === 'number') {
    return t.split('\n').map((x) => x.trim()).filter(Boolean)
      .map((x) => ({ kind: b.listStyle as 'bullet' | 'number', align: 'left' as const, indent: 0, html: escapeHtml(x) }))
  }
  return t.split(/\n\s*\n/).map((p) => ({ kind: 'p' as const, align: 'justify' as const, indent: 0, html: escapeHtml(p.trim()).replace(/\n/g, '<br>') }))
}

interface Recipient {
  name?: string
  designation?: string
  companyName?: string
  address?: string
  city?: string
  state?: string
  pincode?: string
  email?: string
  phone?: string
}

const INK = '#111827'
const MUTED = '#4b5563'
const RULE = '#9ca3af'
const PX_TO_PT = 72 / 96

/**
 * 'Rs. 2,000' — the reference letter's own style, and exactly what the
 * browser preview prints. pdfkit's Helvetica has no rupee glyph (it would
 * come out as '¹'), so the word is spelt, not the symbol.
 */
const money = (paise: number): string =>
  `Rs. ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

const fmtLong = (iso: string | null | undefined): string => {
  if (!iso) return ''
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/** The same substitution the browser applies; unknown names are left visible. */
function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (k in vars && vars[k] ? vars[k] : m))
}

export function streamEngagementPdf(res: Response, l: Row) {
  const L: Layout = { ...DEFAULT_LAYOUT, ...((l.layoutConfig ?? {}) as Partial<Layout>) }
  const F = L.font === 'serif' ? SERIF : SANS
  const B = Math.min(14, Math.max(8, Number(L.fontSize) || 10.5))
  // pdfkit sets lines at ~1.15em; the gap makes up the rest of the chosen spacing.
  const GAP = Math.max(0, ((LINE_HEIGHT[L.lineHeight] ?? 1.55) - 1.15) * B)
  const HS = HEADING[L.headingSize] ?? 1.08
  const HEAD_ALIGN = L.logoPosition === 'left' ? 'left' : L.logoPosition === 'right' ? 'right' : 'center'
  const doc = new PDFDocument({
    size: L.pageSize === 'Letter' ? 'LETTER' : 'A4',
    layout: L.orientation === 'landscape' ? 'landscape' : 'portrait',
    margin: ((MARGIN_MM[L.margin] ?? 18) * 72) / 25.4,
    bufferPages: true,
  })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${l.letterCode}.pdf"`)
  doc.pipe(res)

  const layout = (l.layoutConfig ?? {}) as { company?: Record<string, string> }
  const company = layout.company ?? {}
  const rcp = ((l.recipientSnapshot ?? {}) as Recipient)
  const companyName = rcp.companyName || l.client?.companyName || l.lead?.name || ''

  const vars: Record<string, string> = {
    client_name: rcp.name ?? '',
    contact_person: rcp.name ?? '',
    designation: rcp.designation ?? '',
    company_name: companyName,
    financial_year: l.financialYear ?? '',
    effective_from: fmtLong(l.effectiveFrom),
    effective_until: fmtLong(l.effectiveUntil),
    firm_name: company.name ?? '',
  }

  const left = doc.page.margins.left
  const width = doc.page.width - left - doc.page.margins.right
  const bottom = doc.page.height - doc.page.margins.bottom

  const home = () => { doc.x = left }
  const ensure = (needed: number) => {
    if (doc.y + needed > bottom) { doc.addPage(); home() }
  }
  const text = (s: string, o: { size?: number; font?: string; color?: string; align?: 'left' | 'right' | 'center' | 'justify'; indent?: number } = {}) => {
    home()
    const indent = o.indent ?? 0
    doc.font(o.font ?? F.regular).fontSize(o.size ?? B).fillColor(o.color ?? INK)
    doc.text(s, left + indent, doc.y, { width: width - indent, align: o.align ?? 'left', lineGap: GAP })
    home()
  }

  const pageRoom = () => bottom - doc.page.margins.top

  /** Everything a line needs to be drawn, measured before drawing. */
  const layoutLine = (l: Line) => {
    const runs = parseInline(l.html ?? '', vars)
    const plain = runs.map((r) => r.text).join('')
    const ind = Math.min(4, Math.max(0, Number(l.indent) || 0)) * 18
    const mw = l.kind === 'bullet' || l.kind === 'number' ? 18 : 0
    const w = width - ind - mw
    doc.font(F.regular).fontSize(B)
    const h = plain.trim() ? doc.heightOfString(plain, { width: w, lineGap: GAP }) : 0
    return { runs, plain, ind, mw, w, h }
  }

  /**
   * One paragraph or list item. Kept whole when it can fit on a page — the
   * rule the on-screen pages use — so the PDF breaks where the preview does.
   */
  const drawLine = (l: Line, num: number) => {
    const { runs, plain, ind, mw, w, h } = layoutLine(l)
    if (!plain.trim()) return
    if (h <= pageRoom()) ensure(h)
    const y = doc.y
    if (mw) {
      doc.font(F.regular).fontSize(B).fillColor(INK)
        .text(l.kind === 'bullet' ? '•' : `${num}.`, left + ind, y, { width: 16 })
    }
    runs.forEach((r, k) => {
      doc.font(fontOf(r, F)).fontSize(B).fillColor(INK)
      const o = { width: w, align: l.align ?? 'left', lineGap: GAP, underline: r.u, continued: k < runs.length - 1 }
      if (k === 0) doc.text(r.text, left + ind + mw, y, o)
      else doc.text(r.text, o)
    })
    home()
    doc.moveDown(l.kind === 'bullet' || l.kind === 'number' ? 0.2 : 0.55)
  }

  /** A block's lines, numbered where they are consecutive numbered items. */
  const drawLines = (lines: Line[]) => {
    let n = 0
    for (const l of lines) {
      n = l.kind === 'number' ? n + 1 : 0
      drawLine(l, n)
    }
  }

  /** Height of the first non-empty line — what a heading must keep with it. */
  const firstLineHeight = (lines: Line[]) => {
    const l = lines.find((x) => parseInline(x.html ?? '', vars).some((r) => r.text.trim()))
    return l ? Math.min(layoutLine(l).h, pageRoom()) : 0
  }

  /** A titled section; reserves the heading PLUS a first line so it never strands. */
  const heading = (title: string) => {
    ensure(44)
    doc.moveDown(0.35)
    text(fill(title, vars), { font: F.bold, size: B * HS })
    doc.moveDown(0.25)
  }

  for (const b of ((l.blockConfig as Block[] | null) ?? []).filter((x) => x && x.enabled !== false)) {
    switch (b.key) {
      case 'letterhead': {
        // Logo at the letterhead's alignment (left / center / right) —
        // mirrors the on-screen preview. Silent skip on missing / bad url.
        const logoBuffer = resolveLogoBuffer((company as { logo?: string }).logo)
        if (logoBuffer) {
          try {
            const logoH = 48
            const logoW = logoH * 3 // approximate max; pdfkit honours whichever it hits first
            const logoX = HEAD_ALIGN === 'left' ? left
              : HEAD_ALIGN === 'right' ? left + width - logoW
              : left + (width - logoW) / 2
            doc.image(logoBuffer, logoX, doc.y, { height: logoH })
            doc.y += logoH + 6
            home()
          } catch { /* invalid image bytes — skip */ }
        }
        text((company.name ?? '').toUpperCase(), { font: F.bold, size: B * 1.43, align: HEAD_ALIGN })
        const addr = [company.addressLine1, company.addressLine2, company.city, company.state]
          .filter(Boolean).join(', ') + (company.pin ? ` – ${company.pin}` : '')
        if (addr.trim()) text(addr, { size: B * 0.9, color: MUTED, align: HEAD_ALIGN })
        const contact = [company.phone, company.email].filter(Boolean).join('   |   ')
        if (contact) text(contact, { size: B * 0.9, color: MUTED, align: HEAD_ALIGN })
        doc.moveDown(0.4)
        home()
        if (L.headerStyle !== 'plain') {
          doc.moveTo(left, doc.y).lineTo(left + width, doc.y)
            .strokeColor(L.headerStyle === 'bar' ? INK : RULE).lineWidth(L.headerStyle === 'bar' ? 2.5 : 0.8).stroke()
        }
        doc.moveDown(1)
        break
      }

      case 'date':
        text(fmtLong(l.letterDate), { align: 'right' })
        doc.moveDown(0.8)
        break

      case 'recipient': {
        ensure(80)
        text(fill(b.body || 'To', vars))
        doc.moveDown(0.2)
        const lines = [
          rcp.name, rcp.designation, companyName, rcp.address,
          [rcp.city, rcp.state].filter(Boolean).join(', ') + (rcp.pincode ? ` – ${rcp.pincode}` : ''),
        ].map((s) => (s ?? '').trim()).filter(Boolean)
        lines.forEach((ln, i) => text(ln, { font: i === 2 ? F.bold : F.regular }))
        doc.moveDown(0.8)
        break
      }

      case 'subject':
        ensure(30)
        home()
        doc.font(F.bold).fontSize(B).fillColor(INK)
          .text(`${fill(b.body || 'Sub:', vars)} `, left, doc.y, { continued: true, width })
          .font(F.regular).text(fill(l.subject, vars), { width })
        home()
        doc.moveDown(0.8)
        break

      case 'salutation':
        text(fill(b.body || 'Dear Sir,', vars))
        doc.moveDown(0.6)
        break

      case 'paragraph':
        drawLines(linesOf(b))
        break

      case 'section': {
        const lines = linesOf(b)
        if (b.title?.trim()) {
          ensure(30 + firstLineHeight(lines))
          heading(b.title)
        }
        drawLines(lines)
        break
      }

      case 'fees': {
        if (!l.feeItems.length) break
        heading(b.title?.trim() || 'Fees')
        for (const f of l.feeItems) {
          const line = `${f.service}${f.description ? ` — ${f.description}` : ''}`
          const amt = `${money(f.amountPaise)}${f.frequency ? ` ${f.frequency}` : ''}`
            + (f.billingBasis ? ` [${f.billingBasis}]` : '')
          doc.font(F.regular).fontSize(B)
          const wAmt = 190
          const h = Math.max(
            doc.heightOfString(line, { width: width - 18 - wAmt - 8, lineGap: GAP }),
            doc.heightOfString(amt, { width: wAmt, lineGap: GAP }),
          )
          ensure(h)
          const y = doc.y
          doc.fillColor(INK).text('•', left, y, { width: 16 })
          doc.text(line, left + 18, y, { width: width - 18 - wAmt - 8, lineGap: GAP })
          doc.font(F.bold).text(amt, left + width - wAmt, y, { width: wAmt, align: 'right', lineGap: GAP })
          doc.y = y + h
          home()
          if (f.notes) text(f.notes, { size: B * 0.9, color: MUTED, indent: 18 })
          doc.moveDown(0.25)
        }
        const note = linesOf(b)
        if (note.length) { doc.moveDown(0.3); drawLines(note) }
        break
      }

      case 'closing':
        doc.moveDown(0.3)
        drawLines(linesOf(b))
        break

      case 'signature': {
        // Keep the whole sign-off together; a signature split across pages
        // reads as two documents.
        ensure(110)
        doc.moveDown(0.6)
        text(fill(b.body || 'Yours truly,', vars))
        doc.moveDown(2.6)
        if (l.signatoryName) text(l.signatoryName, { font: F.bold })
        if (l.signatoryDesignation) text(l.signatoryDesignation)
        if (company.name) text(company.name)
        doc.moveDown(0.8)
        break
      }

      case 'confirmation': {
        ensure(120)
        doc.moveDown(0.8)
        text(fill(b.body || 'The above terms and conditions are agreed and confirmed by;', vars))
        doc.moveDown(2.6)
        home()
        doc.moveTo(left, doc.y).lineTo(left + 190, doc.y).strokeColor(INK).lineWidth(0.7).stroke()
        doc.moveDown(0.4)
        const who = l.clientSignatoryName || rcp.name
        const role = l.clientSignatoryDesignation || rcp.designation
        if (who) text(who, { font: F.bold })
        if (role) text(role)
        if (companyName) text(companyName)
        break
      }

      case 'spacer': {
        const h = (typeof b.heightPx === 'number' && Number.isFinite(b.heightPx) ? b.heightPx : 24) * PX_TO_PT
        if (doc.y + h > bottom) doc.addPage()
        else doc.y += h
        home()
        break
      }

      default:
        break
    }
  }

  // Page numbers, drawn after layout so the total is known. The bottom margin
  // is lifted while writing: text placed below it would otherwise make pdfkit
  // start a fresh page for every footer.
  const range = doc.bufferedPageRange()
  for (let i = range.start; L.footerStyle !== 'none' && i < range.start + range.count; i++) {
    doc.switchToPage(i)
    const saved = doc.page.margins.bottom
    doc.page.margins.bottom = 0
    doc.font(F.regular).fontSize(B * 0.8).fillColor(MUTED)
      .text(L.footerStyle === 'company' ? (company.name ?? '') : `Page ${i + 1} of ${range.count}`, left, doc.page.height - 36, { width, align: 'center' })
    doc.page.margins.bottom = saved
  }

  doc.end()
}
