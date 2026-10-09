import PDFDocument from 'pdfkit'
import type { Response } from 'express'
import type { Client, EInvoiceIrn, EwayBill, GstFiling } from '@prisma/client'
import { FALLBACK_COMPANY } from '../invoice/pdf.js'
import { resolveLogoBuffer } from '../pdf/logo.js'

/**
 * RECORD PDFs — E-Way Bills, E-Invoices and GST returns printed as documents
 * on the firm's letterhead, so a client's Documents folders open a proper
 * page for them instead of a data dump.
 *
 * These print what the record holds and nothing more. A simulated record says
 * so on the page itself: a printout must never pass for a government-issued
 * original.
 */

const INK = '#111827'
const NAVY = '#1f3864'
const MUTED = '#6b7280'
const RULE = '#d4d4d8'
const PANEL = '#f8fafc'
const RED = '#b91c1c'

/** Helvetica has no rupee glyph — see invoice/pdf.ts. Indian grouping. */
function money(paise: number): string {
  const n = Math.abs(paise)
  const whole = String(Math.floor(n / 100))
  const last3 = whole.slice(-3)
  const rest = whole.slice(0, -3)
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3
  return `${paise < 0 ? '-' : ''}Rs. ${grouped}.${String(n % 100).padStart(2, '0')}`
}

function day(v: string | Date | null | undefined): string {
  if (!v) return '—'
  const iso = typeof v === 'string' ? v : v.toISOString()
  const [y, m, d] = iso.slice(0, 10).split('-')
  return y && m && d ? `${d}/${m}/${y}` : iso
}

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

interface Section { heading: string; rows: [string, string | null | undefined][] }

interface RecordDoc {
  title: string
  number: string
  status: string
  simulated: boolean
  client: Pick<Client, 'companyName' | 'legalName' | 'clientCode' | 'gstin' | 'pan' | 'address'>
  sections: Section[]
  amount?: { label: string; paise: number }
  footnote?: string
  fileName: string
}

function render(res: Response, doc: RecordDoc, download: boolean) {
  const pdf = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `${doc.title} ${doc.number}` } })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${doc.fileName.replace(/[^\w.-]/g, '_')}"`)
  pdf.pipe(res)

  const L = 48
  const W = pdf.page.width - 96
  const firm = FALLBACK_COMPANY

  // ── Letterhead ────────────────────────────────────────────────────────
  const logo = resolveLogoBuffer(firm.logo)
  let y = 44
  if (logo) {
    try { pdf.image(logo, L, y, { fit: [120, 44] }) } catch { /* unreadable logo — letterhead text still prints */ }
  }
  pdf.font('Helvetica-Bold').fontSize(13).fillColor(NAVY).text(firm.name ?? '', L, y, { width: W, align: 'right' })
  pdf.font('Helvetica').fontSize(8.5).fillColor(MUTED)
  const addr = [firm.addressLine1, firm.addressLine2, [firm.city, firm.state, firm.pin].filter(Boolean).join(', ')]
    .filter(Boolean).join(', ')
  pdf.text(addr, L, pdf.y + 2, { width: W, align: 'right' })
  pdf.text([firm.phone, firm.email, firm.gstin ? `GSTIN ${firm.gstin}` : null].filter(Boolean).join('  ·  '), { width: W, align: 'right' })
  y = Math.max(pdf.y, 92) + 10
  pdf.moveTo(L, y).lineTo(L + W, y).lineWidth(1.5).strokeColor(NAVY).stroke()

  // ── Title band ────────────────────────────────────────────────────────
  y += 16
  pdf.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(doc.title.toUpperCase(), L, y, { width: W, align: 'center' })
  pdf.font('Helvetica').fontSize(10).fillColor(MUTED).text(`No. ${doc.number}   ·   Status: ${titleCase(doc.status)}`, L, pdf.y + 4, { width: W, align: 'center' })
  y = pdf.y + 12

  if (doc.simulated) {
    pdf.rect(L, y, W, 22).fillColor('#fef2f2').fill()
    pdf.font('Helvetica-Bold').fontSize(8.5).fillColor(RED)
      .text('SIMULATED RECORD — generated inside Audit OS, not issued by the government portal.', L, y + 7, { width: W, align: 'center' })
    y += 32
  }

  // ── Client panel ──────────────────────────────────────────────────────
  const c = doc.client
  const clientLines = [
    c.legalName && c.legalName !== c.companyName ? c.legalName : null,
    c.address,
    [c.gstin ? `GSTIN: ${c.gstin}` : null, c.pan ? `PAN: ${c.pan}` : null].filter(Boolean).join('    '),
  ].filter(Boolean) as string[]
  const panelH = 30 + clientLines.length * 12
  pdf.rect(L, y, W, panelH).fillColor(PANEL).fill()
  pdf.font('Helvetica').fontSize(7.5).fillColor(MUTED).text('CLIENT', L + 12, y + 9)
  pdf.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(`${c.companyName}  (${c.clientCode})`, L + 12, y + 19, { width: W - 24 })
  pdf.font('Helvetica').fontSize(9).fillColor(INK)
  clientLines.forEach((line, i) => pdf.text(line, L + 12, y + 34 + i * 12, { width: W - 24 }))
  y += panelH + 18

  // ── Sections: two-column label/value tables ──────────────────────────
  const labelW = 150
  for (const s of doc.sections) {
    const rows = s.rows.filter((r): r is [string, string] => r[1] != null && r[1] !== '')
    if (rows.length === 0) continue
    if (y > pdf.page.height - 140) { pdf.addPage(); y = 56 }
    pdf.font('Helvetica-Bold').fontSize(9).fillColor(NAVY).text(s.heading.toUpperCase(), L, y)
    y = pdf.y + 4
    pdf.moveTo(L, y).lineTo(L + W, y).lineWidth(0.6).strokeColor(RULE).stroke()
    y += 6
    for (const [label, value] of rows) {
      pdf.font('Helvetica').fontSize(9.5)
      const h = Math.max(pdf.heightOfString(value, { width: W - labelW }), 12)
      if (y + h > pdf.page.height - 90) { pdf.addPage(); y = 56 }
      pdf.fillColor(MUTED).text(label, L, y, { width: labelW - 10 })
      pdf.fillColor(INK).text(value, L + labelW, y, { width: W - labelW })
      y += h + 7
    }
    y += 10
  }

  if (doc.amount) {
    if (y > pdf.page.height - 120) { pdf.addPage(); y = 56 }
    pdf.rect(L, y, W, 34).lineWidth(1).strokeColor(NAVY).stroke()
    pdf.font('Helvetica').fontSize(10).fillColor(MUTED).text(doc.amount.label, L + 12, y + 12)
    pdf.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(money(doc.amount.paise), L, y + 10, { width: W - 12, align: 'right' })
    y += 50
  }

  // ── Footer ────────────────────────────────────────────────────────────
  // The footer sits inside the bottom margin; lift the margin so pdfkit does
  // not break to a blank page for it.
  pdf.page.margins.bottom = 0
  const fy = pdf.page.height - 70
  pdf.moveTo(L, fy).lineTo(L + W, fy).lineWidth(0.6).strokeColor(RULE).stroke()
  pdf.font('Helvetica').fontSize(7.5).fillColor(MUTED)
    .text(doc.footnote ?? 'Computer-generated record from Audit OS. No signature required.', L, fy + 8, { width: W, align: 'center' })
    .text(`Printed ${day(new Date())} by ${firm.name ?? ''}`, { width: W, align: 'center' })
  pdf.end()
}

export function streamEwayBillPdf(res: Response, e: EwayBill & { client: Client }, download = false) {
  render(res, {
    title: 'E-Way Bill', number: e.ewbNo, status: e.status, simulated: e.isSimulated, client: e.client,
    fileName: `${e.ewbNo}.pdf`,
    sections: [
      { heading: 'Bill details', rows: [
        ['E-way bill no.', e.ewbNo], ['Generated on', day(e.generatedAt)], ['Valid until', day(e.validUntil)],
        ['Extensions', e.extensionCount ? String(e.extensionCount) : null],
        ['Original EWB no.', e.originalEwbNo],
      ] },
      { heading: 'Document', rows: [['Document no.', e.documentNo], ['Document date', day(e.documentDate)]] },
      { heading: 'Parties', rows: [
        ['From (supplier) GSTIN', e.fromGstin ?? e.client.gstin], ['To (recipient)', e.toPartyName], ['To GSTIN', e.toGstin],
      ] },
      { heading: 'Cancellation', rows: [['Cancelled on', e.cancelledAt ? day(e.cancelledAt) : null], ['Reason', e.cancelReason]] },
    ],
    amount: { label: 'Consignment value', paise: Number(e.valuePaise) },
  }, download)
}

export function streamEInvoicePdf(res: Response, e: EInvoiceIrn & { client: Client }, download = false) {
  render(res, {
    title: 'E-Invoice', number: e.documentNo, status: e.status, simulated: e.isSimulated, client: e.client,
    fileName: `e-invoice-${e.documentNo}.pdf`,
    sections: [
      { heading: 'Invoice reference', rows: [
        ['Document no.', e.documentNo], ['Document date', day(e.documentDate)], ['Document type', e.documentType.toUpperCase()],
        ['IRN', e.irn], ['Reported to IRP on', e.reportedAt ? day(e.reportedAt) : null],
      ] },
      { heading: 'Buyer', rows: [['Name', e.buyerName], ['GSTIN', e.buyerGstin], ['Place of supply', e.placeOfSupply]] },
      { heading: 'Cancellation', rows: [['Cancelled on', e.cancelledAt ? day(e.cancelledAt) : null], ['Reason', e.cancelReason]] },
    ],
    amount: { label: 'Total invoice value', paise: Number(e.totalValuePaise) },
  }, download)
}

const bigPaise = (v: bigint | null) => (v == null ? null : money(Number(v)))

export function streamGstFilingPdf(res: Response, g: GstFiling & { gstProfile: { client: Client; gstin?: string | null } }, download = false) {
  const client = g.gstProfile.client
  const filed = g.status === 'filed' || !!g.arn
  render(res, {
    title: filed ? `${g.returnType} Filing Acknowledgement` : `${g.returnType} Return Summary`,
    number: `${g.returnType}/${g.period}`, status: g.status, simulated: false, client,
    fileName: `${g.returnType}-${g.period}.pdf`,
    sections: [
      { heading: 'Return', rows: [
        ['Return type', g.returnType], ['Tax period', g.period], ['Financial year', g.financialYear],
        ['Due date', day(g.dueDate)], ['Filed on', g.filedAt ? day(g.filedAt) : null], ['ARN', g.arn],
        ['Filed manually', g.filedManually ? 'Yes' : null],
      ] },
      { heading: 'Tax summary', rows: [
        ['Taxable value', bigPaise(g.taxableValue)], ['Tax amount', bigPaise(g.taxAmount)],
        ['Tax liability', bigPaise(g.taxLiability)], ['Eligible ITC', bigPaise(g.eligibleItc)],
        ['Net payable', bigPaise(g.netPayable)],
      ] },
      { heading: 'Payment', rows: [
        ['Payment status', titleCase(g.paymentStatus)], ['Payment date', g.paymentDate ? day(g.paymentDate) : null],
        ['Challan reference', g.challanRef],
      ] },
      { heading: 'Remarks', rows: [['Remarks', g.remarks]] },
    ],
    footnote: filed
      ? 'Summary of the return as recorded in Audit OS. The GST portal acknowledgement (ARN) is the authoritative proof of filing.'
      : 'Return not yet filed — this is a working summary, not an acknowledgement.',
  }, download)
}
