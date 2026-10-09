import type { Response } from 'express'
import { ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { invoiceAmountInWords } from '../invoice/totals.js'
import { fmtDay, pdfMoney, streamDocPdf } from '../invoice/doc-pdf.js'

const REASON_LABEL: Record<string, string> = {
  rate_change: 'Change in rate', deficiency: 'Deficiency in service', discount: 'Post-supply discount',
  return: 'Return / withdrawal of service', fee_reduction: 'Fee reduction', other: 'Other',
}

interface Line { description: string; sac_code: string | null; taxable_paise: number; gst_rate: number; cgst_paise: number; sgst_paise: number; igst_paise: number; total_paise: number }

/** The CREDIT NOTE document — the invoice renderer's style, titled CREDIT NOTE. */
export async function streamCreditNotePdf(res: Response, id: string) {
  const n = await prisma.creditNote.findFirst({
    where: { id, deletedAt: null },
    include: { invoice: { include: { client: { select: { companyName: true } } } } },
  })
  if (!n) throw ApiError.notFound('Credit note not found.')
  const inv = n.invoice
  const lines = (Array.isArray(n.linesJson) ? n.linesJson : []) as unknown as Line[]
  const inter = n.isInterState
  const exact = n.taxablePaise + n.cgstPaise + n.sgstPaise + n.igstPaise
  const roundOff = n.totalPaise - exact

  const columns = inter
    ? [
        { label: '#', width: 0.06, align: 'center' as const },
        { label: 'Particulars', width: 0.42, align: 'left' as const },
        { label: 'SAC', width: 0.12, align: 'center' as const },
        { label: 'Taxable', width: 0.14, align: 'right' as const },
        { label: 'IGST', width: 0.12, align: 'right' as const },
        { label: 'Amount', width: 0.14, align: 'right' as const },
      ]
    : [
        { label: '#', width: 0.05, align: 'center' as const },
        { label: 'Particulars', width: 0.33, align: 'left' as const },
        { label: 'SAC', width: 0.1, align: 'center' as const },
        { label: 'Taxable', width: 0.13, align: 'right' as const },
        { label: 'CGST', width: 0.12, align: 'right' as const },
        { label: 'SGST', width: 0.12, align: 'right' as const },
        { label: 'Amount', width: 0.15, align: 'right' as const },
      ]
  const rows = lines.map((l, i) => inter
    ? [String(i + 1), l.description, l.sac_code ?? '-', pdfMoney(l.taxable_paise), `${pdfMoney(l.igst_paise)} (${l.gst_rate}%)`, pdfMoney(l.total_paise)]
    : [String(i + 1), l.description, l.sac_code ?? '-', pdfMoney(l.taxable_paise), `${pdfMoney(l.cgst_paise)} (${l.gst_rate / 2}%)`, `${pdfMoney(l.sgst_paise)} (${l.gst_rate / 2}%)`, pdfMoney(l.total_paise)])

  await streamDocPdf(res, {
    title: n.status === 'cancelled' ? 'CREDIT NOTE (CANCELLED)' : 'CREDIT NOTE',
    filename: `${n.creditNoteNumber ?? 'draft-credit-note'}.pdf`,
    layoutConfig: inv.layoutConfig,
    meta: [
      ['Credit Note #', n.creditNoteNumber ?? 'DRAFT'],
      ['Date', fmtDay(n.noteDate)],
      ['Reason', REASON_LABEL[n.reason] ?? n.reason],
    ],
    metaRight: [
      ['Against Invoice', inv.invoiceNumber ?? '-'],
      ['Invoice Date', fmtDay(inv.invoiceDate)],
      ['Place Of Supply', n.placeOfSupply ?? '-'],
    ],
    party: { title: 'Issued To', name: inv.billingName ?? inv.client.companyName, address: inv.billingAddress, gstin: inv.customerGstin },
    columns,
    rows,
    summary: [
      { label: 'Taxable Value', value: pdfMoney(n.taxablePaise) },
      ...(inter
        ? [{ label: 'IGST', value: pdfMoney(n.igstPaise) }]
        : [{ label: 'CGST', value: pdfMoney(n.cgstPaise) }, { label: 'SGST', value: pdfMoney(n.sgstPaise) }]),
      ...(roundOff !== 0 ? [{ label: 'Round Off', value: pdfMoney(roundOff) }] : []),
      { label: 'Total Credit', value: `Rs. ${pdfMoney(n.totalPaise)}`, strong: true },
    ],
    words: invoiceAmountInWords(n.totalPaise),
    note: n.reasonNote ? { title: 'Notes', text: n.reasonNote } : null,
    signatory: { name: inv.signatoryName, designation: inv.signatoryDesignation },
  })
}
