import PDFDocument from 'pdfkit'
import type { Response } from 'express'
import type { Prisma } from '@prisma/client'
import QRCode from 'qrcode'
import { invoiceAmountInWords } from './totals.js'

/**
 * INVOICE PDF — the file a client actually receives.
 *
 * A browser print only ever reaches the operator's own printer dialog, and
 * neither wa.me nor mailto: can carry an attachment, so the bytes have to
 * exist server-side before an invoice can be sent as a document.
 *
 * It follows the reference TAX INVOICE block for block, and it follows
 * `blockConfig` — the same order and on/off switches the builder shows — so
 * what is sent matches what was composed. A block switched off in the builder
 * is absent here too.
 *
 * MONEY IS NEVER RECOMPUTED. Every figure is read from the row the totals
 * engine already wrote. A PDF that disagreed with the record would be the one
 * copy nobody could correct.
 *
 * MULTI-PAGE. The item table measures each row before drawing it and breaks
 * to a new page when the row would cross the bottom margin, re-drawing the
 * column header at the top — §36/§37, and the same rule the on-screen
 * document follows.
 */

const INCLUDE = {
  items: { orderBy: { sortOrder: 'asc' } },
  client: { select: { companyName: true, gstin: true, address: true, email: true, contactNumber: true } },
} satisfies Prisma.InvoiceInclude

export type InvoicePdfRow = Prisma.InvoiceGetPayload<{ include: typeof INCLUDE }>

/**
 * pdfkit's built-in Helvetica is WinAnsi-encoded and has no glyph for the
 * rupee sign, which renders as a stray superscript one — so the PDF says
 * "Rs." rather than printing a wrong character on a document a client
 * receives. Indian digit grouping is done here rather than with toLocaleString
 * so the output does not depend on the server's ICU data.
 */
function money(paise: number): string {
  const neg = paise < 0
  const n = Math.abs(paise)
  const whole = String(Math.floor(n / 100))
  const frac = String(n % 100).padStart(2, '0')
  const last3 = whole.slice(-3)
  const rest = whole.slice(0, -3)
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3
  return `${neg ? '-' : ''}${grouped}.${frac}`
}

const INK = '#111827'
const NAVY = '#1f3864'
const MUTED = '#6b7280'
const RULE = '#d4d4d8'
const PANEL = '#f8fafc'

const fmtDay = (iso: string): string => {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return y && m && d ? `${d}/${m}/${y}` : iso
}

interface BlockSpec { key: string; enabled?: boolean }

/** The reference document's order, used when an invoice carries no config. */
const DEFAULT_BLOCKS: BlockSpec[] = [
  'company_header', 'invoice_title', 'invoice_meta', 'bill_to', 'ship_to',
  'items_table', 'total_in_words', 'notes', 'tax_summary',
  'bank_details', 'signature', 'footer',
].map((key) => ({ key, enabled: true }))

function readBlocks(raw: unknown): BlockSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_BLOCKS
  return (raw as BlockSpec[]).filter((b) => b && typeof b.key === 'string')
}

interface Company {
  name?: string; addressLine1?: string; addressLine2?: string; city?: string
  state?: string; pin?: string; phone?: string; email?: string; website?: string; gstin?: string
}

/**
 * Used only when an invoice stored no company block. Not a hardcoded
 * letterhead: anything the invoice carries wins, field by field.
 */
const FALLBACK_COMPANY: Company = {
  name: 'JNS Accounting Solutions',
  addressLine1: '83 PV Krishnan Street',
  addressLine2: 'KK Pudur, Opp. to Bharathi Stores',
  city: 'Coimbatore',
  state: 'Tamil Nadu',
  pin: '641038',
  phone: '+91 93639 93765',
  email: 'jnsacctax@gmail.com',
  website: 'www.jnsacctax.in',
  gstin: '33AWHPN2628Q1Z2',
}

interface Bank {
  account_number?: string; account_type?: string; account_holder?: string
  bank_name?: string; branch_name?: string | null; ifsc_code?: string; upi_id?: string | null
}

export async function streamInvoicePdf(res: Response, inv: InvoicePdfRow) {
  const layout = (inv.layoutConfig ?? {}) as Record<string, unknown> & { company?: Company }
  /**
   * The letterhead. The builder always snapshots this onto layoutConfig, but
   * an invoice created straight through the API may carry none — and a tax
   * invoice with no issuer on it is not a document anyone can use. So the
   * firm's own details are the floor, overridden field by field by whatever
   * the invoice actually stored.
   */
  const company: Company = { ...FALLBACK_COMPANY, ...(layout.company ?? {}) }
  const bank = (inv.bankSnapshot ?? null) as Bank | null
  const blocks = readBlocks(inv.blockConfig)
  const on = (k: string) => blocks.some((b) => b.key === k && b.enabled !== false)
  const inter = inv.isInterState

  const margin = 40
  const doc = new PDFDocument({ size: 'A4', margin })
  const left = margin
  const right = doc.page.width - margin
  const width = right - left
  const bottom = doc.page.height - margin

  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="${inv.invoiceNumber}.pdf"`)
  doc.pipe(res)

  // ── Company header + TAX INVOICE ────────────────────────────────────────
  if (on('company_header') || on('invoice_title')) {
    const top = doc.y
    if (on('company_header')) {
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(16).text(company.name ?? '', left, top, { width: width * 0.62 })
      doc.fillColor(INK).font('Helvetica').fontSize(8.5)
      const lines = [
        company.addressLine1, company.addressLine2,
        [company.city, company.state, company.pin].filter(Boolean).join(' '),
        company.phone, company.email, company.website,
      ].filter((l): l is string => Boolean(l && l.trim()))
      lines.forEach((l) => doc.text(l, left, doc.y, { width: width * 0.62 }))
      if (company.gstin) {
        doc.font('Helvetica-Bold').text(`GSTIN: ${company.gstin}`, left, doc.y, { width: width * 0.62 })
      }
    }
    const companyBottom = doc.y
    if (on('invoice_title')) {
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(18)
        .text('TAX INVOICE', left, top, { width, align: 'right' })
    }
    // Two columns were drawn from the same `top`; continue below the taller.
    doc.y = Math.max(companyBottom, doc.y) + 4
    rule(doc, left, right)
  }

  // ── Invoice information ─────────────────────────────────────────────────
  if (on('invoice_meta')) {
    const top = doc.y + 6
    const colW = width / 2
    const pairs: [string, string][] = [
      ['Invoice #', inv.invoiceNumber],
      ['Invoice Date', fmtDay(inv.invoiceDate)],
      ['Terms', termLabel(inv.terms)],
      ['Due Date', fmtDay(inv.dueDate)],
    ]
    let y = top
    for (const [k, v] of pairs) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(k, left, y, { width: 90 })
      doc.fillColor(INK).font('Helvetica-Bold').text(`: ${v}`, left + 92, y, { width: colW - 100 })
      y += 14
    }
    doc.fillColor(MUTED).font('Helvetica').fontSize(9).text('Place Of Supply', left + colW, top, { width: 100 })
    doc.fillColor(INK).font('Helvetica-Bold').text(`: ${inv.placeOfSupply ?? '-'}`, left + colW + 102, top, { width: colW - 110 })
    doc.y = y + 2
    rule(doc, left, right)
  }

  // ── Bill To / Ship To ───────────────────────────────────────────────────
  if (on('bill_to') || on('ship_to')) {
    const top = doc.y + 6
    const both = on('bill_to') && on('ship_to')
    const colW = both ? width / 2 : width
    const boxTop = top
    let maxY = top

    const party = (title: string, name: string, address: string | null, x: number) => {
      let y = boxTop + 6
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9.5).text(title, x + 8, y, { width: colW - 16 })
      y = doc.y + 1
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5).text(name || '-', x + 8, y, { width: colW - 16 })
      y = doc.y
      if (address) {
        doc.font('Helvetica').fontSize(8.5).fillColor(INK)
        address.split('\n').filter(Boolean).forEach((l) => doc.text(l, x + 8, doc.y, { width: colW - 16 }))
        y = doc.y
      }
      if (inv.customerGstin) {
        doc.font('Helvetica').fontSize(8.5).text(`GSTIN ${inv.customerGstin}`, x + 8, doc.y, { width: colW - 16 })
        y = doc.y
      }
      maxY = Math.max(maxY, y + 6)
    }

    if (on('bill_to')) party('Bill To', inv.billingName ?? inv.client.companyName, inv.billingAddress, left)
    if (on('ship_to')) {
      party(
        'Ship To',
        inv.shipSameAsBill ? (inv.billingName ?? inv.client.companyName) : (inv.shippingName ?? ''),
        inv.shipSameAsBill ? inv.billingAddress : inv.shippingAddress,
        both ? left + colW : left,
      )
    }
    // The panel is drawn behind the text once its height is known.
    doc.save().rect(left, boxTop, width, maxY - boxTop).fillOpacity(1).fill(PANEL).restore()
    doc.save().rect(left, boxTop, width, maxY - boxTop).strokeColor(RULE).lineWidth(0.7).stroke().restore()
    if (both) {
      doc.save().moveTo(left + colW, boxTop).lineTo(left + colW, maxY).strokeColor(RULE).lineWidth(0.7).stroke().restore()
    }
    // Re-draw on top of the panel: pdfkit has no z-order, so the text is
    // written twice rather than the fill covering it.
    if (on('bill_to')) party('Bill To', inv.billingName ?? inv.client.companyName, inv.billingAddress, left)
    if (on('ship_to')) {
      party(
        'Ship To',
        inv.shipSameAsBill ? (inv.billingName ?? inv.client.companyName) : (inv.shippingName ?? ''),
        inv.shipSameAsBill ? inv.billingAddress : inv.shippingAddress,
        both ? left + colW : left,
      )
    }
    doc.y = maxY + 8
  }

  // ── Items ───────────────────────────────────────────────────────────────
  if (on('items_table')) {
    const cols = inter
      ? [
          { k: '#', w: 0.05, a: 'center' as const },
          { k: 'Item & Description', w: 0.36, a: 'left' as const },
          { k: 'HSN/SAC', w: 0.11, a: 'center' as const },
          { k: 'Qty', w: 0.08, a: 'right' as const },
          { k: 'Rate', w: 0.13, a: 'right' as const },
          { k: 'IGST', w: 0.09, a: 'center' as const },
          { k: 'Amt', w: 0.09, a: 'right' as const },
          { k: 'Amount', w: 0.09, a: 'right' as const },
        ]
      : [
          /* These must sum to exactly 1.0 — they are fractions of the
             printable width, so 1.04 pushes the last column off the page. */
          { k: '#', w: 0.05, a: 'center' as const },
          { k: 'Item & Description', w: 0.24, a: 'left' as const },
          { k: 'HSN/SAC', w: 0.10, a: 'center' as const },
          { k: 'Qty', w: 0.07, a: 'right' as const },
          { k: 'Rate', w: 0.11, a: 'right' as const },
          { k: 'CGST', w: 0.07, a: 'center' as const },
          { k: 'Amt', w: 0.09, a: 'right' as const },
          { k: 'SGST', w: 0.07, a: 'center' as const },
          { k: 'Amt', w: 0.09, a: 'right' as const },
          { k: 'Amount', w: 0.11, a: 'right' as const },
        ]
    const xs: number[] = []
    let acc = left
    for (const c of cols) { xs.push(acc); acc += c.w * width }

    /**
     * The column header. `headTop` is captured ONCE: every doc.text() advances
     * doc.y, so reading doc.y inside the loop walks each label further down
     * the page and only the first one lands on the bar.
     */
    const header = () => {
      const h = 18
      const headTop = doc.y
      doc.save().rect(left, headTop, width, h).fill(NAVY).restore()
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8)
      cols.forEach((c, i) => {
        doc.text(c.k, xs[i] + 3, headTop + 5.5, { width: c.w * width - 6, align: c.a, lineBreak: false })
      })
      doc.y = headTop + h
    }

    header()
    doc.font('Helvetica').fontSize(8.5).fillColor(INK)

    inv.items.forEach((it, idx) => {
      const half = it.gstRatePercent / 2
      const cells = inter
        ? [
            String(idx + 1), it.itemName, it.hsnSac ?? '-', (it.quantityCenti / 100).toFixed(2),
            money(it.ratePaise), `${it.gstRatePercent}%`, money(it.igstAmountPaise), money(it.taxableAmountPaise),
          ]
        : [
            String(idx + 1), it.itemName, it.hsnSac ?? '-', (it.quantityCenti / 100).toFixed(2),
            money(it.ratePaise), `${half}%`, money(it.cgstAmountPaise), `${half}%`,
            money(it.sgstAmountPaise), money(it.taxableAmountPaise),
          ]

      // Measure before drawing: the name column wraps, and the row's height
      // is whatever the tallest cell needs.
      const nameIdx = 1
      const nameH = doc.heightOfString(it.itemName || '-', { width: cols[nameIdx].w * width - 6 })
      const descH = it.description
        ? doc.heightOfString(it.description, { width: cols[nameIdx].w * width - 6 })
        : 0
      const rowH = Math.max(18, nameH + descH + 8)

      if (doc.y + rowH > bottom) {
        doc.addPage()
        doc.y = margin
        header()                       // §37 — the header repeats.
        doc.font('Helvetica').fontSize(8.5).fillColor(INK)
      }

      const top = doc.y
      cells.forEach((v, i) => {
        if (i === nameIdx) {
          doc.fillColor(INK).text(v || '-', xs[i] + 3, top + 4, { width: cols[i].w * width - 6 })
          if (it.description) {
            doc.fillColor(MUTED).fontSize(7.5).text(it.description, xs[i] + 3, doc.y, { width: cols[i].w * width - 6 })
            doc.fontSize(8.5).fillColor(INK)
          }
        } else {
          doc.fillColor(INK).text(v, xs[i] + 3, top + 4, { width: cols[i].w * width - 6, align: cols[i].a })
        }
      })
      doc.y = top + rowH
      doc.save().moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(RULE).lineWidth(0.5).stroke().restore()
    })
    doc.y += 8
  }

  // ── Words / Notes on the left, tax summary on the right ─────────────────
  /* What this band will ACTUALLY draw, decided before the page break is
     reserved. `notes` switched on with nothing written in it draws nothing,
     and breaking to a fresh page for it would leave that page blank. */
  const wordsOn = on('total_in_words')
  const notesText = on('notes') ? (inv.notes ?? '') : ''
  const summaryOn = on('tax_summary')
  if (wordsOn || notesText || summaryOn) {
    if (doc.y + 120 > bottom) { doc.addPage(); doc.y = margin }
    const top = doc.y
    const colW = width * 0.55

    if (wordsOn) {
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9).text('Total In Words', left, doc.y, { width: colW })
      doc.fillColor(INK).font('Helvetica').fontSize(9)
        .text(invoiceAmountInWords(inv.totalPaise), left, doc.y, { width: colW })
      doc.moveDown(0.4)
    }
    if (notesText) {
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9).text('Notes', left, doc.y, { width: colW })
      doc.fillColor(INK).font('Helvetica').fontSize(9).text(notesText, left, doc.y, { width: colW })
    }
    const leftEnd = doc.y

    if (summaryOn) {
      const sx = left + width * 0.58
      const sw = width * 0.42
      let y = top
      const row = (k: string, v: string, strong = false) => {
        if (strong) doc.save().rect(sx, y - 2, sw, 15).fill('#f1f5f9').restore()
        doc.fillColor(INK).font(strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
        doc.text(k, sx + 6, y, { width: sw * 0.55 })
        doc.text(v, sx, y, { width: sw - 6, align: 'right' })
        y += 15
      }
      row('Sub Total', money(inv.subtotalPaise))
      if (inv.discountPaise > 0) row('Discount', `- ${money(inv.discountPaise)}`)
      if (inter) {
        if (inv.igstPaise > 0) row('IGST', money(inv.igstPaise))
      } else {
        if (inv.cgstPaise > 0) row('CGST', money(inv.cgstPaise))
        if (inv.sgstPaise > 0) row('SGST', money(inv.sgstPaise))
      }
      if (inv.roundOffPaise !== 0) row('Round Off', money(inv.roundOffPaise))
      row('Total', `Rs. ${money(inv.totalPaise)}`, true)
      if (inv.amountPaidPaise > 0) row('Paid', `- ${money(inv.amountPaidPaise)}`)
      row('Balance Due', `Rs. ${money(inv.balanceDuePaise)}`, true)
      doc.y = Math.max(leftEnd, y)
    } else {
      doc.y = leftEnd
    }
    doc.y += 10
  }

  // ── Bank details ────────────────────────────────────────────────────────
  if (on('bank_details') && bank) {
    const needed = (buildQrPayload(inv, bank, company.name) || decodeDataUrl(inv.qrMode === 'image' ? inv.qrImage : null)) ? 140 : 96
    if (doc.y + needed > bottom) { doc.addPage(); doc.y = margin }
    const top = doc.y
    const fields: [string, string | null | undefined][] = [
      ['Account Number', bank.account_number],
      ['Account Type', bank.account_type],
      ['Account Holder', bank.account_holder],
      ['Bank', bank.bank_name],
      ['Branch Name', bank.branch_name],
      ['IFSC Code', bank.ifsc_code],
      ['UPI ID', bank.upi_id],
    ].filter((f): f is [string, string] => Boolean(f[1]))

    const hasQr = Boolean(buildQrPayload(inv, bank, company.name)) || Boolean(decodeDataUrl(inv.qrMode === 'image' ? inv.qrImage : null))
    const boxH = Math.max(22 + fields.length * 12 + 8, hasQr ? 130 : 0)
    doc.save().rect(left, top, width, boxH).fill(PANEL).restore()
    doc.save().rect(left, top, width, boxH).strokeColor(RULE).lineWidth(0.7).stroke().restore()

    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9.5).text('Bank Details', left + 8, top + 7)
    let y = top + 22
    for (const [k, v] of fields) {
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5).text(`${k}:`, left + 8, y, { width: 90, continued: false })
      doc.font('Helvetica').text(String(v), left + 100, y, { width: width * 0.5 })
      y += 12
    }

    /* The UPI QR panel the reference document carries on the right of the
       bank block. Rendered from the account's own UPI id, so it pays the
       account the invoice actually names — a QR hardcoded anywhere else
       would be the one field nobody proof-reads. Drawn as a PNG data URL
       because pdfkit takes a Buffer directly. */
    const qrPayload = buildQrPayload(inv, bank, company.name)
    const uploaded = inv.qrMode === 'image' ? decodeDataUrl(inv.qrImage) : null
    if (qrPayload || uploaded) {
      try {
        // An uploaded code is printed AS SUPPLIED. It is not re-encoded:
        // whatever the firm's bank handed them is what a payer scans.
        const png = uploaded ?? await QRCode.toBuffer(qrPayload!, { errorCorrectionLevel: 'M', margin: 1, width: 240 })
        const qrSize = Math.min(86, boxH - 30)
        const qrX = right - qrSize - 24
        const qrY = top + 16
        doc.fillColor(MUTED).font('Helvetica').fontSize(7).text('Pay to', qrX, top + 6, { width: qrSize, align: 'center' })
        doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(8)
          .text(bank.account_holder ?? '', qrX - 40, top + 14, { width: qrSize + 40, align: 'center' })
        doc.image(png, qrX, qrY + 8, { width: qrSize, height: qrSize })
        doc.fillColor(MUTED).font('Helvetica').fontSize(6.5)
          .text(inv.qrMode === 'custom' || inv.qrMode === 'image' ? 'Scan to pay' : `UPI ID ${bank.upi_id ?? ''}`,
                qrX - 30, qrY + qrSize + 10, { width: qrSize + 60, align: 'center' })
      } catch {
        /* A QR that will not encode must not take the invoice down with it:
           the bank details above are enough to pay by, so the panel is
           simply omitted. */
      }
    }
    doc.y = top + boxH + 10
  }

  // ── Authorized signature ────────────────────────────────────────────────
  if (on('signature')) {
    if (doc.y + 70 > bottom) { doc.addPage(); doc.y = margin }
    const y = doc.y + 10
    doc.fillColor(INK).font('Helvetica').fontSize(9)
      .text('Authorized Signature', left, y, { width, align: 'right' })
    const lineY = y + 44
    doc.save().moveTo(right - 170, lineY).lineTo(right, lineY).strokeColor(MUTED).lineWidth(0.7).stroke().restore()
    let after = lineY + 4
    if (inv.signatoryName) {
      doc.font('Helvetica-Bold').fontSize(9).text(inv.signatoryName, left, after, { width, align: 'right' })
      after = doc.y
    }
    if (inv.signatoryDesignation) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
        .text(inv.signatoryDesignation, left, after, { width, align: 'right' })
      after = doc.y
    }
    doc.y = after + 8
  }

  // ── Footer ──────────────────────────────────────────────────────────────
  if (on('footer') && inv.footerNote) {
    if (doc.y + 30 > bottom) { doc.addPage(); doc.y = margin }
    rule(doc, left, right)
    doc.fillColor(MUTED).font('Helvetica').fontSize(8)
      .text(inv.footerNote, left, doc.y + 4, { width, align: 'center' })
  }

  doc.end()
}

/**
 * What the QR should encode, or null for no QR.
 *
 * The amount is baked into the intent only in `upi_amount`: a QR carrying a
 * figure is convenient, but wrong the moment a part-payment is recorded, so
 * `upi_only` exists for anyone who would rather the payer type it.
 */
/** A `data:image/...;base64,` URL back into bytes pdfkit can draw. */
function decodeDataUrl(v: string | null | undefined): Buffer | null {
  if (!v) return null
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/.exec(v)
  if (!m) return null
  try {
    return Buffer.from(m[2], 'base64')
  } catch {
    return null
  }
}

function buildQrPayload(
  inv: InvoicePdfRow,
  bank: Bank | null,
  companyName: string | undefined,
): string | null {
  const mode = inv.qrMode ?? 'upi_amount'
  // `image` is drawn from the upload, not generated here.
  if (mode === 'none' || mode === 'image') return null
  if (mode === 'custom') return inv.qrValue?.trim() || null
  if (!bank?.upi_id) return null
  const payee = encodeURIComponent(bank.account_holder ?? companyName ?? '')
  const base = `upi://pay?pa=${bank.upi_id}&pn=${payee}&cu=INR`
  return mode === 'upi_amount' ? `${base}&am=${(inv.balanceDuePaise / 100).toFixed(2)}` : base
}

function rule(doc: PDFKit.PDFDocument, left: number, right: number) {
  const y = doc.y + 2
  doc.save().moveTo(left, y).lineTo(right, y).strokeColor(RULE).lineWidth(0.8).stroke().restore()
  doc.y = y + 4
}

function termLabel(t: string): string {
  return ({
    due_on_receipt: 'Due on Receipt',
    net_7: 'Net 7', net_15: 'Net 15', net_30: 'Net 30', net_45: 'Net 45',
    custom: 'Custom',
  } as Record<string, string>)[t] ?? t
}

export const INVOICE_PDF_INCLUDE = INCLUDE
