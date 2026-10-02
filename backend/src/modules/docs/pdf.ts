import PDFDocument from 'pdfkit'
import type { Response } from 'express'
import type { Row } from './service.js'

/**
 * WORKSTATION DOC PDF.
 *
 * Walks the same ordered `blockConfig` the Doc editor composes and the
 * browser paints, with the same block kinds, the same {{placeholder}}
 * substitution from the same `fieldValues`, and the same alignment and list
 * rules — so the paper is the document that was edited, not a second
 * rendering of it that can drift.
 *
 * Thirteen document types share this one renderer because they share one
 * block vocabulary; what differs between them is their template, which is
 * data. Nothing here knows what a consent letter is.
 *
 * Normal vertical flow throughout: every draw returns the cursor to the left
 * margin (`home`), which is what stops a block from inheriting the x of
 * whatever column was written last and wrapping into a narrow strip.
 */

interface Line {
  id?: string
  kind?: 'p' | 'bullet' | 'number'
  align?: 'left' | 'center' | 'right' | 'justify'
  indent?: number
  html?: string
}

interface KVRow { id?: string; label?: string; value?: string }
interface Person { id?: string; name?: string; role?: string; din?: string; note?: string; sign?: string; rule?: boolean }

interface Block {
  id?: string
  key: string
  enabled?: boolean
  title?: string
  align?: 'left' | 'center' | 'right' | 'justify'
  variant?: string
  lines?: Line[]
  rows?: KVRow[]
  people?: Person[]
  columns?: number
  heightPx?: number
}

interface Run { text: string; b: boolean; i: boolean; u: boolean }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decode = (t: string) => t
  .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
  .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)

/** Stored inline HTML (b, i, u, br only) into styled runs. Tolerant by design. */
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
const fontOf = (r: Run, F: Fonts) => (r.b && r.i ? F.boldItalic : r.b ? F.bold : r.i ? F.italic : F.regular)

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
  pageSize: 'A4', orientation: 'portrait', margin: 'normal', font: 'sans', fontSize: 11,
  lineHeight: 'normal', headingSize: 'normal', headerStyle: 'plain', footerStyle: 'none', logoPosition: 'center',
}
const MARGIN_MM = { narrow: 12, normal: 18, wide: 25 }
const LINE_HEIGHT = { tight: 1.35, normal: 1.55, relaxed: 1.8 }
const HEADING = { compact: 1.0, normal: 1.08, large: 1.25 }

const INK = '#111827'
const MUTED = '#4b5563'
const RULE = '#9ca3af'
const PX_TO_PT = 72 / 96

const fmtLong = (iso: string | null | undefined): string => {
  if (!iso) return ''
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/** The same substitution the browser applies; an unfilled name stays visible. */
function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (k in vars && vars[k] ? vars[k] : m))
}

export function streamDocPdf(res: Response, d: Row) {
  const L: Layout = { ...DEFAULT_LAYOUT, ...((d.layoutConfig ?? {}) as Partial<Layout>) }
  const F = L.font === 'serif' ? SERIF : SANS
  const B = Math.min(14, Math.max(8, Number(L.fontSize) || 11))
  const GAP = Math.max(0, ((LINE_HEIGHT[L.lineHeight] ?? 1.55) - 1.15) * B)
  const HS = HEADING[L.headingSize] ?? 1.08
  const doc = new PDFDocument({
    size: L.pageSize === 'Letter' ? 'LETTER' : 'A4',
    layout: L.orientation === 'landscape' ? 'landscape' : 'portrait',
    margin: ((MARGIN_MM[L.margin] ?? 18) * 72) / 25.4,
    bufferPages: true,
  })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${d.docCode}.pdf"`)
  doc.pipe(res)

  const fv = (d.fieldValues ?? {}) as Record<string, unknown>
  const vars: Record<string, string> = { doc_date: fmtLong(d.docDate) }
  for (const [k, v] of Object.entries(fv)) {
    vars[k] = typeof v === 'string' ? v : v == null ? '' : String(v)
  }
  // A date-shaped field also answers in its long form, as the page shows it.
  for (const [k, v] of Object.entries(vars)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) vars[k] = fmtLong(v)
  }
  if (!vars.company_name) vars.company_name = d.client?.companyName ?? d.lead?.name ?? ''

  const left = doc.page.margins.left
  const width = doc.page.width - left - doc.page.margins.right
  const bottom = doc.page.height - doc.page.margins.bottom

  const home = () => { doc.x = left }
  const ensure = (needed: number) => { if (doc.y + needed > bottom) { doc.addPage(); home() } }
  const pageRoom = () => bottom - doc.page.margins.top

  const text = (s: string, o: { size?: number; font?: string; color?: string; align?: 'left' | 'right' | 'center' | 'justify'; indent?: number; width?: number } = {}) => {
    home()
    const indent = o.indent ?? 0
    doc.font(o.font ?? F.regular).fontSize(o.size ?? B).fillColor(o.color ?? INK)
    doc.text(s, left + indent, doc.y, { width: (o.width ?? width) - indent, align: o.align ?? 'left', lineGap: GAP })
    home()
  }

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

  /** One paragraph or list item, kept whole when it can fit on a page. */
  const drawLine = (l: Line, num: number, tight = false) => {
    const { runs, plain, ind, mw, w, h } = layoutLine(l)
    if (!plain.trim()) { doc.moveDown(tight ? 0.4 : 0.55); return }
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
    doc.moveDown(tight ? 0.12 : l.kind === 'p' ? 0.55 : 0.2)
  }

  const drawLines = (lines: Line[], tight = false) => {
    let n = 0
    for (const l of lines) {
      n = l.kind === 'number' ? n + 1 : 0
      drawLine(l, n, tight)
    }
  }

  const firstLineHeight = (lines: Line[]) => {
    const l = lines.find((x) => parseInline(x.html ?? '', vars).some((r) => r.text.trim()))
    return l ? Math.min(layoutLine(l).h, pageRoom()) : 0
  }

  /** A signatory: name in bold, then role and DIN under it. */
  const drawPerson = (p: Person, x: number, w: number, y: number, align: 'left' | 'right' | 'center' | 'justify' = 'left', labelled = false): number => {
    let cy = y
    const put = (s: string, font: string) => {
      if (!s?.trim()) return
      doc.font(font).fontSize(B).fillColor(INK).text(fill(s, vars), x, cy, { width: w, lineGap: GAP, align })
      cy = doc.y
    }
    // The uploaded signature, above the name, exactly as the page shows it.
    const data = /^data:image\/(png|jpeg|jpg);base64,(.+)$/.exec(p.sign ?? '')
    if (data) {
      try {
        doc.image(Buffer.from(data[2], 'base64'), x, cy, { fit: [w, 40], align: align === 'right' ? 'right' : undefined })
        cy += 44
      } catch { /* an unreadable image must not stop the document printing */ }
    }
    if (labelled) {
      put(`Name: ${fill(p.name ?? '', vars)}`, F.bold)
      put(p.din ? `DIN: ${p.din}` : '', F.regular)
      return cy
    }
    put(p.note ?? '', F.bold)
    if (p.rule) {
      cy += 22
      doc.moveTo(x, cy).lineTo(x + w * 0.62, cy).strokeColor(INK).lineWidth(0.7).stroke()
      cy += 6
    }
    put(p.name ?? '', F.bold)
    put(p.role ?? '', F.regular)
    put(p.din ? `DIN: ${p.din}` : '', F.regular)
    return cy
  }

  // Optional company header (layout_config.companyHeader, set per document in
  // the builder's Details tab): centred, above the letter, ruled off. Same
  // visible-line rule as the browser (docs/model.ts companyHeaderLines) — a
  // field that is off or empty prints nothing, not a blank line.
  const ch = (d.layoutConfig as { companyHeader?: Record<string, unknown> } | null)?.companyHeader
  if (ch && ch.enabled === true) {
    const show = (ch.show ?? {}) as Record<string, boolean>
    const val = (k: string) => (show[k] !== false && typeof ch[k] === 'string' ? (ch[k] as string).trim() : '')
    const name = val('name')
    const lines = [
      ...val('address').split('\n').map((l) => l.trim()).filter(Boolean),
      ...(val('email') ? [`Mail – ${val('email')}`] : []),
      ...(val('phone') ? [`Phone – ${val('phone')}`] : []),
      ...(val('gstin') ? [`GSTIN – ${val('gstin')}`] : []),
    ]
    if (name || lines.length) {
      if (name) text(name, { font: F.bold, size: B * 1.35, align: 'center' })
      for (const l of lines) text(l, { size: B * 0.95, align: 'center' })
      doc.moveDown(0.3)
      home()
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(RULE).lineWidth(0.8).stroke()
      doc.moveDown(1)
      home()
    }
  }

  const blocks = ((d.blockConfig as Block[] | null) ?? []).filter((x) => x && x.enabled !== false)

  for (const b of blocks) {
    switch (b.key) {
      case 'heading': {
        const size = B * (b.variant === 'subtitle' ? HS : HS * 1.2)
        ensure(size * 2.4)
        doc.moveDown(0.3)
        text(fill(b.title ?? '', vars), { font: F.bold, size, align: b.align ?? 'center' })
        if (b.variant === 'rule') {
          doc.moveDown(0.25)
          home()
          doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(RULE).lineWidth(0.8).stroke()
        }
        doc.moveDown(0.6)
        break
      }

      case 'date':
        text(`${b.title ? `${fill(b.title, vars)} ` : ''}${fmtLong(d.docDate)}`, { align: b.align ?? 'left', font: F.bold })
        doc.moveDown(0.7)
        break

      /** To, / From, — an address, set tight, never justified. */
      case 'address': {
        const lines = b.lines ?? []
        ensure(30 + firstLineHeight(lines))
        if (b.title?.trim()) text(fill(b.title, vars), { align: b.align ?? 'left' })
        drawLines(lines, true)
        doc.moveDown(0.7)
        break
      }

      case 'subject': {
        ensure(30)
        const body = fill(b.title ?? '', vars)
        text(body, { font: F.bold, align: b.align ?? 'left' })
        doc.moveDown(0.7)
        break
      }

      case 'paragraph':
        drawLines(b.lines ?? [])
        break

      case 'section': {
        const lines = b.lines ?? []
        if (b.title?.trim()) {
          ensure(30 + firstLineHeight(lines))
          doc.moveDown(0.35)
          text(fill(b.title, vars), { font: F.bold, size: B * HS, align: b.align ?? 'left' })
          doc.moveDown(0.25)
        }
        drawLines(lines)
        break
      }

      /** 'Name of the concern – …' — label and value on one line. */
      case 'keyvalue': {
        const rows = b.rows ?? []
        if (b.title?.trim()) {
          ensure(40)
          doc.moveDown(0.3)
          text(fill(b.title, vars), { font: F.bold, size: B * HS, align: b.align ?? 'left' })
          doc.moveDown(0.6)
        }
        for (const r of rows) {
          const label = fill(r.label ?? '', vars)
          const value = fill(r.value ?? '', vars)
          if (!label.trim() && !value.trim()) continue
          ensure(B * 2)
          home()
          doc.font(F.regular).fontSize(B).fillColor(INK)
            .text(`${label}${label.trim() ? ' – ' : ''}`, left, doc.y, { continued: true, width })
            .font(F.bold).text(value, { width })
          home()
          doc.moveDown(0.25)
        }
        doc.moveDown(0.4)
        break
      }

      /**
       * The sign-off. One column or two, laid side by side as on the page —
       * the whole block is kept together, because a signature split across
       * pages reads as two documents.
       */
      case 'signature': {
        const people = b.people ?? []
        const cols = Math.max(1, Math.min(2, b.columns ?? 1))
        // Signature / Name / Date / Place, one signatory under the next —
        // the no-objection certificates' own sign-off.
        if (b.variant === 'stacked') {
          doc.moveDown(0.8)
          for (const person of people) {
            ensure(90)
            text('Signature')
            doc.moveDown(1.8)
            home()
            doc.font(F.regular).fontSize(B).fillColor(INK)
              .text('Name: ', left, doc.y, { continued: true, width })
              .font(F.bold).text(fill(person.name ?? '', vars), { width })
            home()
            text(`Date: ${fmtLong(d.docDate)}`)
            text(`Place: ${fill(person.role ?? '', vars)}`)
            doc.moveDown(1.2)
          }
          break
        }
        ensure(120)
        doc.moveDown(0.6)
        if (b.title?.trim()) { text(fill(b.title, vars), { align: b.align ?? 'left' }); doc.moveDown(2.2) }
        else doc.moveDown(1.6)
        const colW = (width - 24) / cols
        for (let i = 0; i < people.length; i += cols) {
          const y = doc.y
          let maxY = y
          for (let c = 0; c < cols && i + c < people.length; c++) {
            const x = left + c * (colW + 24)
            const endY = drawPerson(people[i + c], x, colW, y, (b.align ?? 'left') as 'left' | 'right' | 'center' | 'justify', b.variant === 'named')
            if (endY > maxY) maxY = endY
          }
          doc.y = maxY
          home()
          doc.moveDown(1.2)
        }
        break
      }

      /** Two witnesses, side by side, with their blank fields. */
      case 'witness': {
        const people = b.people ?? []
        ensure(110)
        doc.moveDown(1)
        const colW = (width - 24) / 2
        const y = doc.y
        let maxY = y
        people.slice(0, 2).forEach((p, i) => {
          const x = left + i * (colW + 24)
          let cy = y
          const put = (s: string, font = F.regular) => {
            doc.font(font).fontSize(B).fillColor(INK).text(s, x, cy, { width: colW, lineGap: GAP })
            cy = doc.y
          }
          put(fill(p.note || `Witness ${i + 1}:`, vars), F.bold)
          put(`${p.din ? `${p.din} ` : ''}Name: ${fill(p.name ?? '', vars)}`)
          put(`Address: ${fill(p.role ?? '', vars)}`)
          put('Signature:')
          if (cy > maxY) maxY = cy
        })
        doc.y = maxY
        home()
        doc.moveDown(0.8)
        break
      }

      /** 'Date: … / Place: …' under a signature. */
      case 'placedate': {
        ensure(50)
        text(`Date: ${fmtLong(d.docDate)}`, { align: b.align ?? 'left' })
        text(`Place: ${fill((b.title ?? '').trim() || '{{place}}', vars)}`, { align: b.align ?? 'left' })
        doc.moveDown(0.6)
        break
      }

      case 'spacer': {
        const h = (typeof b.heightPx === 'number' && Number.isFinite(b.heightPx) ? b.heightPx : 24) * PX_TO_PT
        if (doc.y + h > bottom) doc.addPage()
        else doc.y += h
        home()
        break
      }

      case 'pagebreak':
        doc.addPage()
        home()
        break

      default:
        break
    }
  }

  // Page numbers, drawn after layout so the total is known.
  const range = doc.bufferedPageRange()
  for (let i = range.start; L.footerStyle !== 'none' && i < range.start + range.count; i++) {
    doc.switchToPage(i)
    const saved = doc.page.margins.bottom
    doc.page.margins.bottom = 0
    doc.font(F.regular).fontSize(B * 0.8).fillColor(MUTED)
      .text(
        L.footerStyle === 'company' ? String(vars.company_name ?? '') : `Page ${i + 1} of ${range.count}`,
        left, doc.page.height - 36, { width, align: 'center' },
      )
    doc.page.margins.bottom = saved
  }

  doc.end()
}
