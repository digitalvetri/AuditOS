import type { Response } from 'express'
import { ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { invoiceAmountInWords } from './totals.js'
import { fmtDay, pdfMoney, streamDocPdf } from './doc-pdf.js'
import { receiptNumberFor } from './payments.js'

const MODE_LABEL: Record<string, string> = {
  bank_transfer: 'Bank transfer', upi: 'UPI', cash: 'Cash', cheque: 'Cheque', card: 'Card', other: 'Other',
}

/** PAYMENT RECEIPT for one InvoicePayment row: cash, TDS and what it settled. */
export async function streamReceiptPdf(res: Response, paymentId: string) {
  const p = await prisma.invoicePayment.findFirst({
    where: { id: paymentId, deletedAt: null },
    include: { invoice: { include: { client: { select: { companyName: true, address: true, gstin: true } } } } },
  })
  if (!p) throw ApiError.notFound('Payment not found.')
  const inv = p.invoice
  const number = await receiptNumberFor(p)
  const settled = p.amountPaise + p.tdsPaise
  const summary = [
    { label: 'Amount Received', value: `Rs. ${pdfMoney(p.amountPaise)}`, strong: true },
    ...(p.tdsPaise > 0 ? [{ label: `TDS Deducted (${p.tdsSection ?? '194J'})`, value: pdfMoney(p.tdsPaise) }] : []),
    ...(p.tdsPaise > 0 ? [{ label: 'Total Settled', value: `Rs. ${pdfMoney(settled)}`, strong: true }] : []),
    { label: 'Invoice Total', value: pdfMoney(inv.totalPaise) },
    { label: 'Balance Due', value: `Rs. ${pdfMoney(inv.balanceDuePaise)}`, strong: true },
  ]
  await streamDocPdf(res, {
    title: 'PAYMENT RECEIPT',
    filename: `${number}.pdf`,
    layoutConfig: inv.layoutConfig,
    meta: [
      ['Receipt #', number],
      ['Receipt Date', fmtDay(p.paidOn)],
      ['Mode', MODE_LABEL[p.mode] ?? p.mode],
      ...(p.reference ? [['Reference', p.reference] as [string, string]] : []),
    ],
    metaRight: [
      ['Against Invoice', inv.invoiceNumber ?? 'Draft'],
      ['Invoice Date', fmtDay(inv.invoiceDate)],
    ],
    party: {
      title: 'Received From',
      name: inv.billingName ?? inv.client.companyName,
      address: inv.billingAddress,
      gstin: inv.customerGstin,
    },
    columns: [
      { label: '#', width: 0.06, align: 'center' },
      { label: 'Particulars', width: 0.54, align: 'left' },
      { label: 'Amount (Rs.)', width: 0.4, align: 'right' },
    ],
    rows: [
      ['1', `Received against invoice ${inv.invoiceNumber ?? ''} by ${MODE_LABEL[p.mode] ?? p.mode}`, pdfMoney(p.amountPaise)],
      ...(p.tdsPaise > 0
        ? [['2', `Tax deducted at source u/s ${p.tdsSection ?? '194J'}${p.tdsCertificateReceived ? ' (Form 16A received)' : ''}`, pdfMoney(p.tdsPaise)]]
        : []),
    ],
    summary,
    words: invoiceAmountInWords(p.amountPaise),
    note: p.note ? { title: 'Note', text: p.note } : null,
    signatory: { name: inv.signatoryName, designation: inv.signatoryDesignation },
  })
}

/** REFUND VOUCHER for one InvoiceRefund row: money paid back against an invoice. */
export async function streamRefundVoucherPdf(res: Response, refundId: string) {
  const r = await prisma.invoiceRefund.findFirst({
    where: { id: refundId, deletedAt: null },
    include: { invoice: { include: { client: { select: { companyName: true } } } } },
  })
  if (!r) throw ApiError.notFound('Refund not found.')
  const inv = r.invoice
  const number = r.refundNumber ?? 'Refund'
  const cn = r.creditNoteId
    ? await prisma.creditNote.findUnique({ where: { id: r.creditNoteId }, select: { creditNoteNumber: true } })
    : null
  await streamDocPdf(res, {
    title: 'REFUND VOUCHER',
    filename: `${number}.pdf`,
    layoutConfig: inv.layoutConfig,
    meta: [
      ['Voucher #', number],
      ['Refund Date', fmtDay(r.refundedOn)],
      ['Mode', MODE_LABEL[r.mode] ?? r.mode],
      ...(r.reference ? [['Reference', r.reference] as [string, string]] : []),
    ],
    metaRight: [
      ['Against Invoice', inv.invoiceNumber ?? 'Draft'],
      ['Invoice Date', fmtDay(inv.invoiceDate)],
      ...(cn?.creditNoteNumber ? [['Credit Note', cn.creditNoteNumber] as [string, string]] : []),
    ],
    party: {
      title: 'Paid To',
      name: inv.billingName ?? inv.client.companyName,
      address: inv.billingAddress,
      gstin: inv.customerGstin,
    },
    columns: [
      { label: '#', width: 0.06, align: 'center' },
      { label: 'Particulars', width: 0.54, align: 'left' },
      { label: 'Amount (Rs.)', width: 0.4, align: 'right' },
    ],
    rows: [
      ['1', `Refunded against invoice ${inv.invoiceNumber ?? ''}${cn?.creditNoteNumber ? ` (credit note ${cn.creditNoteNumber})` : ''} by ${MODE_LABEL[r.mode] ?? r.mode}`, pdfMoney(r.amountPaise)],
    ],
    summary: [
      { label: 'Amount Refunded', value: `Rs. ${pdfMoney(r.amountPaise)}`, strong: true },
      { label: 'Invoice Total', value: pdfMoney(inv.totalPaise) },
      { label: 'Balance Due', value: `Rs. ${pdfMoney(inv.balanceDuePaise)}`, strong: true },
    ],
    words: invoiceAmountInWords(r.amountPaise),
    note: r.note ? { title: 'Note', text: r.note } : null,
    signatory: { name: inv.signatoryName, designation: inv.signatoryDesignation },
  })
}
