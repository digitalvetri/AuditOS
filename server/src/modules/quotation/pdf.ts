import PDFDocument from 'pdfkit'
import type { Response } from 'express'
import type { Prisma } from '@prisma/client'
import { formatINR } from '../../lib/money.js'

/**
 * QUOTATION PDF.
 *
 * The file a client actually receives on WhatsApp or by email. A browser
 * print can only ever reach the operator's own printer dialog, and neither
 * wa.me nor mailto: can carry an attachment, so the bytes have to exist
 * server-side before a quotation can be sent as a document.
 *
 * Deliberately paper-first rather than a screenshot of the editor: the
 * sections follow `blockConfig` — the same order and the same on/off switches
 * the builder shows — so what is sent matches what was composed. A block the
 * user disabled is absent here too.
 *
 * Money is never recomputed. Every figure is read from the row the totals
 * engine already wrote, because a PDF that disagreed with the record would be
 * the one copy nobody could correct.
 */

const INCLUDE = {
  items: { orderBy: { sortOrder: 'asc' } },
  workSections: {
    orderBy: { sortOrder: 'asc' },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  },
  client: { select: { companyName: true, gstin: true, address: true, email: true, contactNumber: true } },
  lead: { select: { name: true, email: true, contactNumber: true } },
} satisfies Prisma.QuotationInclude

export type QuotationPdfRow = Prisma.QuotationGetPayload<{ include: typeof INCLUDE }>

/**
 * Money for the page. pdfkit's built-in Helvetica is WinAnsi-encoded and has
 * no glyph for the rupee sign, which renders as a stray superscript one — so
 * the PDF says "Rs." rather than printing a wrong character on a document a
 * client receives. Embedding a rupee-bearing font is the alternative, and
 * would mean shipping a TTF for one glyph.
 */
const money = (paise: number): string => formatINR(paise).replace(/\u20B9\s?/g, 'Rs. ')

const INK = '#111827'
const MUTED = '#6b7280'
const RULE = '#d4d4d8'

/** Millimetres of blank paper a spacer block asks for, as CSS pixels → points. */
const PX_TO_PT = 72 / 96

interface BlockSpec {
  key: string
  enabled?: boolean
  title?: string
  body?: string
  heightPx?: number
  heightMm?: number
}

/** Same fallback order the browser renderer uses, so a gap is the same gap. */
function spacerPoints(b: BlockSpec): number {
  if (typeof b.heightPx === 'number' && Number.isFinite(b.heightPx)) return b.heightPx * PX_TO_PT
  if (typeof b.heightMm === 'number' && Number.isFinite(b.heightMm)) return (b.heightMm * 96) / 25.4 * PX_TO_PT
  return 24 * PX_TO_PT
}

const DEFAULT_BLOCKS: BlockSpec[] = [
  { key: 'company_header' }, { key: 'quotation_title' }, { key: 'quotation_meta' },
  { key: 'subject' }, { key: 'introduction' }, { key: 'client_information' },
  { key: 'fee_table' }, { key: 'nature_of_work' }, { key: 'closing' },
]

function readBlocks(raw: unknown): BlockSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_BLOCKS
  return (raw as BlockSpec[]).filter((b) => b && typeof b.key === 'string' && b.enabled !== false)
}

const fmtDay = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export function streamQuotationPdf(res: Response, q: QuotationPdfRow) {
  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${q.quotationCode}.pdf"`)
  doc.pipe(res)

  const cfg = (q.layoutConfig ?? {}) as { company?: Record<string, string> }
  const company = cfg.company ?? {}
  const party = q.client ?? q.lead
  const partyName = q.client?.companyName ?? q.lead?.name ?? '—'

  const left = doc.page.margins.left
  const width = doc.page.width - left - doc.page.margins.right
  const bottom = doc.page.height - doc.page.margins.bottom

  /**
   * Put the cursor back at the left margin.
   *
   * THE bug this file had: pdfkit's `text(str, x, y)` does not merely draw at
   * x, it MOVES the cursor there. The fee column is written last in every
   * table row, so every section after the table inherited that x and wrapped
   * inside the width of the fee column — Nature of Work arrived as a narrow
   * strip down the right-hand edge. Nothing positioned may be left dangling.
   */
  const home = () => { doc.x = left }

  /** Start a new page when the next thing would not fit on this one. */
  const ensure = (needed: number) => {
    if (doc.y + needed > bottom) { doc.addPage(); home() }
  }

  /** Flowing text at full content width, always from the left margin. */
  const body = (text: string, opts: { size?: number; color?: string; font?: string; indent?: number } = {}) => {
    home()
    doc.font(opts.font ?? 'Helvetica').fontSize(opts.size ?? 9.5).fillColor(opts.color ?? INK)
    doc.text(text, left + (opts.indent ?? 0), doc.y, { width: width - (opts.indent ?? 0) })
    home()
  }

  const rule = (gapAfter = 0.6) => {
    home()
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(RULE).lineWidth(0.7).stroke()
    doc.moveDown(gapAfter)
  }

  /**
   * A section heading. Reserves room for the heading PLUS a first line of its
   * content, so a heading is never left stranded at the foot of a page.
   */
  const heading = (text: string) => {
    ensure(46)
    doc.moveDown(0.6)
    home()
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK)
      .text(text.toUpperCase(), left, doc.y, { width })
    doc.moveDown(0.2)
    rule(0.4)
  }

  for (const b of readBlocks(q.blockConfig)) {
    switch (b.key) {
      case 'company_header': {
        home()
        doc.font('Helvetica-Bold').fontSize(15).fillColor(INK)
          .text(company.name ?? 'Quotation', left, doc.y, { width })
        const addr = [company.addressLine1, company.addressLine2, company.city, company.state, company.pin]
          .filter(Boolean).join(', ')
        const contact = [company.phone, company.email, company.gstin ? `GSTIN ${company.gstin}` : '']
          .filter(Boolean).join('  ·  ')
        if (addr) body(addr, { size: 9, color: MUTED })
        if (contact) body(contact, { size: 9, color: MUTED })
        doc.moveDown(0.4)
        rule()
        break
      }

      case 'quotation_title':
        ensure(40)
        doc.moveDown(0.2)
        home()
        doc.font('Helvetica-Bold').fontSize(13).fillColor(INK)
          .text('QUOTATION', left, doc.y, { width, align: 'center' })
        doc.moveDown(0.4)
        home()
        break

      case 'quotation_meta': {
        ensure(40)
        home()
        const y = doc.y
        doc.font('Helvetica').fontSize(9.5).fillColor(INK)
        doc.text(`No: ${q.quotationCode}`, left, y, { width: width / 2 })
        doc.text(`Date: ${fmtDay(q.quoteDate)}`, left + width / 2, y, { width: width / 2, align: 'right' })
        home()
        doc.text(`Valid until: ${fmtDay(q.validUntil)}`, left, doc.y, { width })
        doc.moveDown(0.3)
        home()
        break
      }

      case 'client_information': {
        heading('Client')
        body(partyName, { font: 'Helvetica-Bold' })
        if (q.client?.address) body(q.client.address, { size: 9, color: MUTED })
        if (q.client?.gstin) body(`GSTIN ${q.client.gstin}`, { size: 9, color: MUTED })
        if (party?.email) body(party.email, { size: 9, color: MUTED })
        if (party?.contactNumber) body(party.contactNumber, { size: 9, color: MUTED })
        break
      }

      case 'subject':
        if (q.subject) {
          ensure(34)
          doc.moveDown(0.3)
          body(`Subject: ${q.subject}`, { font: 'Helvetica-Bold' })
        }
        break

      case 'introduction':
        if (q.introduction?.trim()) { doc.moveDown(0.4); body(q.introduction.trim()) }
        break

      case 'fee_table': {
        if (!q.items.length) break
        heading('Services')

        const wSl = 30
        const wFee = 95
        const wFreq = 110
        const wDesc = width - wSl - wFee - wFreq
        const xSl = left
        const xDesc = left + wSl
        const xFreq = xDesc + wDesc
        const xFee = xFreq + wFreq

        /**
         * One row, measured before it is drawn. Every cell is written at the
         * SAME y, and the row advances by the tallest cell, so a long
         * particular wraps inside its own column instead of dragging the
         * others down with it.
         */
        const row = (sl: string, desc: string, freq: string, fee: string, bold = false) => {
          const font = bold ? 'Helvetica-Bold' : 'Helvetica'
          doc.font(font).fontSize(9)
          const h = Math.max(
            doc.heightOfString(desc, { width: wDesc }),
            doc.heightOfString(freq, { width: wFreq }),
            doc.heightOfString(fee, { width: wFee }),
          )
          // A row that will not fit starts the next page, with the header
          // repeated so the columns stay readable.
          if (doc.y + h > bottom) { doc.addPage(); home(); header() }
          const y = doc.y
          doc.fillColor(INK)
          doc.text(sl, xSl, y, { width: wSl })
          doc.text(desc, xDesc, y, { width: wDesc })
          doc.text(freq, xFreq, y, { width: wFreq })
          doc.text(fee, xFee, y, { width: wFee, align: 'right' })
          doc.y = y + h
          doc.moveDown(0.35)
          home()
        }

        const header = () => {
          row('#', 'Particulars', 'Frequency of filing / payment', 'Professional fees', true)
          rule(0.4)
        }

        header()
        for (const [i, it] of q.items.entries()) {
          row(String(i + 1), it.description, it.frequency ?? '', money(it.amountPaise))
          if (it.detail) {
            doc.font('Helvetica').fontSize(8).fillColor(MUTED)
            const h = doc.heightOfString(it.detail, { width: wDesc })
            if (doc.y + h > bottom) { doc.addPage(); home() }
            doc.text(it.detail, xDesc, doc.y, { width: wDesc })
            doc.moveDown(0.2)
            home()
          }
        }
        rule(0.3)

        const totalRow = (label: string, value: number, bold = false) => {
          ensure(20)
          const y = doc.y
          doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(INK)
          doc.text(label, xDesc, y, { width: wDesc + wFreq, align: 'right' })
          doc.text(money(value), xFee, y, { width: wFee, align: 'right' })
          doc.y = y + doc.heightOfString(label, { width: wDesc })
          doc.moveDown(0.25)
          home()
        }

        totalRow('Subtotal', q.subtotalPaise)
        if (q.discountPaise) totalRow('Discount', -q.discountPaise)
        if (q.isInterState) {
          if (q.igstPaise) totalRow('IGST', q.igstPaise)
        } else {
          if (q.cgstPaise) totalRow('CGST', q.cgstPaise)
          if (q.sgstPaise) totalRow('SGST', q.sgstPaise)
        }
        rule(0.3)
        totalRow('Total professional fees', q.totalPaise, true)
        home()
        break
      }

      case 'nature_of_work': {
        if (!q.workSections.length) break
        heading('Nature of work')
        for (const w of q.workSections) {
          // Keep a section title with its first bullet.
          ensure(40)
          body(w.title, { font: 'Helvetica-Bold' })
          if (w.description) body(w.description, { size: 9, color: MUTED })
          for (const it of w.items) {
            doc.font('Helvetica').fontSize(9)
            const h = doc.heightOfString(it.content, { width: width - 14 })
            if (doc.y + h > bottom) { doc.addPage(); home() }
            const y = doc.y
            doc.fillColor(INK).text('•', left, y, { width: 10 })
            doc.text(it.content, left + 14, y, { width: width - 14 })
            doc.y = y + h
            doc.moveDown(0.15)
            home()
          }
          doc.moveDown(0.45)
          home()
        }
        break
      }

      case 'terms':
        if (q.terms?.trim()) { heading('Terms & conditions'); body(q.terms.trim()) }
        break

      case 'payment_details':
        break

      case 'notes':
        if (q.notes?.trim()) { heading('Notes'); body(q.notes.trim()) }
        break

      case 'closing': {
        ensure(80)
        doc.moveDown(0.8)
        if (q.closingText?.trim()) body(q.closingText.trim())
        doc.moveDown(1.2)
        if (q.preparedByName) {
          body(q.preparedByName, { font: 'Helvetica-Bold' })
          if (q.preparedByDesignation) body(q.preparedByDesignation, { size: 9, color: MUTED })
        }
        break
      }

      case 'custom':
        if (b.title) heading(b.title)
        if (b.body) body(b.body)
        break

      /**
       * Blank paper, exactly as composed in the builder. Advancing the cursor
       * keeps it real vertical space in normal flow; if the gap would run off
       * the page the next block simply starts the next one, which is what a
       * space before a section is usually for.
       */
      case 'spacer': {
        const h = spacerPoints(b)
        if (doc.y + h > bottom) { doc.addPage() } else { doc.y += h }
        home()
        break
      }

      default:
        break
    }
  }

  doc.end()
}

export const QUOTATION_PDF_INCLUDE = INCLUDE
