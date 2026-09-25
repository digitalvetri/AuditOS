/**
 * SAMPLE WORKSTATION DOCUMENTS — invoices, quotations, engagement letters
 * and statutory docs, for development.
 *
 * Opt-in only — `npm --prefix server run seed:documents`. It is NOT part of
 * the main seed and never runs at start-up, so sample paperwork can never
 * appear in a production database by accident. The same rule seed-tasks.ts
 * follows, for the same reason.
 *
 * Re-running it is safe: every row it writes carries a fixed `*-sample-NN`
 * id, and the run begins by deleting exactly those ids. Items cascade, so a
 * second run replaces the set rather than doubling it.
 *
 * MONEY IS NEVER COMPUTED HERE. The totals come from the same modules the
 * service layer uses — invoice/totals.ts and quotation/totals.ts — because a
 * seed that does its own arithmetic is a second source of truth that drifts
 * the moment a rounding rule changes. Document codes come from the same
 * allocators the routes use, so INV-/QT-/EL-/DOC- numbering is continuous
 * with anything already in the database.
 *
 * Statuses are anchored to the day the seed runs: the overdue invoices are
 * overdue this afternoon, not on the afternoon this file was written.
 */
import '../src/lib/env.js'
import { PrismaClient } from '@prisma/client'
import { computeTotals as invoiceTotals } from '../src/modules/invoice/totals.js'
import { computeTotals as quotationTotals } from '../src/modules/quotation/totals.js'
import {
  nextInvoiceNumber,
  nextQuotationCode,
  nextEngagementCode,
  nextWorkstationDocCode,
} from '../src/platform/workstation/codes.js'

const prisma = new PrismaClient()

const ORG = 'org-audit-os'

// ── date helpers (IST calendar dates as 'YYYY-MM-DD'), matching
//    seed-workstation.ts so the two datasets read as one firm's year. ──────
const DAY = 86_400_000
const now = new Date()
/** 'YYYY-MM-DD' for `offset` days from today. */
function d(offset: number): string {
  return new Date(now.getTime() + offset * DAY).toISOString().slice(0, 10)
}
/** An instant `offset` days from today, for sentAt / paidAt columns. */
function ts(offset: number, istHour = 11): Date {
  const base = new Date(now.getTime() + offset * DAY)
  const [y, m, day] = base.toISOString().slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, day, istHour - 5, -30))
}

const rupees = (r: number) => r * 100

/**
 * The due date a term implies. Mirrors invoice/service.ts#dueDateFor — copied
 * rather than imported because that module pulls in the Prisma singleton and
 * the RBAC scope helpers, which a seed has no business booting. Date-only
 * arithmetic in UTC, so a timezone cannot shift a due date a day either way.
 */
const TERM_DAYS: Record<string, number> = {
  due_on_receipt: 0, net_7: 7, net_15: 15, net_30: 30, net_45: 45,
}
function dueDateFor(invoiceDate: string, term: string): string {
  const dt = new Date(`${invoiceDate}T00:00:00Z`)
  dt.setUTCDate(dt.getUTCDate() + (TERM_DAYS[term] ?? 0))
  return dt.toISOString().slice(0, 10)
}

const TN = 'Tamil Nadu (33)'
const KA = 'Karnataka (29)'

// ═══════════════════════════════════════════════════════════════════════════
// INVOICES
//
// Ten tax invoices spread across the seeded clients and over the last quarter,
// chosen so every branch of the list view has something in it: three paid,
// one part-paid, two genuinely overdue (due date already behind today), two
// sent and still inside their terms, one draft, one cancelled.
//
// cli-1001 carries a 29 (Karnataka) GSTIN against a Tamil Nadu firm, so its
// invoice is the INTER-state one and prints IGST; everything else is 33 and
// splits CGST+SGST. That single row is what makes the tax-split branch of the
// document engine visible without editing anything.
// ═══════════════════════════════════════════════════════════════════════════

interface ItemSeed {
  serviceId?: string | null
  itemName: string
  description?: string
  hsnSac?: string
  quantityCenti?: number
  unit?: string
  ratePaise: number
  discountPercent?: number
  gstRatePercent?: number
}

interface InvoiceSeed {
  n: string
  clientId: string
  /** Days from today. */
  date: number
  terms: string
  status: 'draft' | 'sent' | 'partially_paid' | 'paid' | 'overdue' | 'cancelled'
  interState?: boolean
  /** Fraction of the total already received, 0–1. */
  paid?: number
  discountPaise?: number
  notes?: string
  items: ItemSeed[]
}

const INVOICES: InvoiceSeed[] = [
  {
    n: '01', clientId: 'cli-1001', date: -75, terms: 'net_30', status: 'paid',
    interState: true, paid: 1,
    notes: 'Retainer for the July–September quarter.',
    items: [
      { serviceId: 'svc-gst-filing', itemName: 'GST Filing Retainer', description: 'GSTR-1 and GSTR-3B, July to September', hsnSac: '998222', quantityCenti: 300, unit: 'Month', ratePaise: rupees(6_000) },
      { serviceId: 'svc-tds-filing', itemName: 'TDS Return — Q2', description: 'Form 26Q preparation and filing', hsnSac: '998222', ratePaise: rupees(4_500) },
    ],
  },
  {
    n: '02', clientId: 'cli-1002', date: -60, terms: 'net_15', status: 'paid', paid: 1,
    notes: 'Includes the ROC filing fee recovered at cost.',
    items: [
      { serviceId: 'svc-book', itemName: 'Bookkeeping', description: 'Monthly books write-up and reconciliation', hsnSac: '998222', quantityCenti: 200, unit: 'Month', ratePaise: rupees(8_000) },
      // A 0% line: a fee paid on the client's behalf is a reimbursement, not a
      // service, so it carries no GST. It is here to keep the mixed-slab path
      // of the totals module exercised by the sample data.
      { itemName: 'MCA filing fee (reimbursement)', description: 'Paid to MCA on your behalf — receipt attached', hsnSac: '998222', ratePaise: rupees(1_200), gstRatePercent: 0 },
    ],
  },
  {
    n: '03', clientId: 'cli-1003', date: -45, terms: 'net_30', status: 'partially_paid', paid: 0.5,
    notes: 'Part payment received; balance on completion of the audit.',
    items: [
      { serviceId: 'svc-itr', itemName: 'Income Tax Return — AY 2025-26', description: 'Computation, filing and acknowledgement', hsnSac: '998231', ratePaise: rupees(18_000) },
      { serviceId: 'svc-book', itemName: 'Ledger Scrutiny', description: 'Pre-audit scrutiny of the trial balance', hsnSac: '998222', quantityCenti: 1_200, unit: 'Hours', ratePaise: rupees(900) },
    ],
  },
  {
    n: '04', clientId: 'cli-1005', date: -60, terms: 'net_30', status: 'overdue',
    notes: 'Second reminder sent. Due date has passed.',
    items: [
      { serviceId: 'svc-gst-filing', itemName: 'GST Filing Retainer', description: 'GSTR-1 and GSTR-3B', hsnSac: '998222', quantityCenti: 200, unit: 'Month', ratePaise: rupees(5_500) },
      { serviceId: 'svc-eway', itemName: 'E-way Bill Support', description: 'Bulk generation and reconciliation', hsnSac: '998222', ratePaise: rupees(3_000) },
    ],
  },
  {
    n: '05', clientId: 'cli-1006', date: -10, terms: 'net_30', status: 'sent',
    items: [
      { serviceId: 'svc-einvoice', itemName: 'E-invoicing Setup', description: 'IRP registration and ERP integration', hsnSac: '998313', ratePaise: rupees(25_000) },
      // 12% slab — the sample set covers 0, 5, 12 and 18 between them.
      { itemName: 'Software Licence — Annual', description: 'Third-party e-invoice connector, 1 year', hsnSac: '997331', ratePaise: rupees(12_000), gstRatePercent: 12 },
    ],
  },
  {
    n: '06', clientId: 'cli-1008', date: -22, terms: 'due_on_receipt', status: 'paid', paid: 1,
    items: [
      { serviceId: 'svc-gst-reg', itemName: 'GST Registration', description: 'Application, clarification and certificate', hsnSac: '998231', ratePaise: rupees(7_500) },
    ],
  },
  {
    n: '07', clientId: 'cli-1009', date: -25, terms: 'net_15', status: 'overdue',
    notes: 'Awaiting confirmation from the client’s accounts team.',
    items: [
      { serviceId: 'svc-book', itemName: 'Bookkeeping', description: 'Monthly books write-up', hsnSac: '998222', quantityCenti: 300, unit: 'Month', ratePaise: rupees(7_000) },
      { serviceId: 'svc-tds', itemName: 'TDS Advisory', description: 'Section 194Q applicability review', hsnSac: '998231', quantityCenti: 450, unit: 'Hours', ratePaise: rupees(1_200) },
    ],
  },
  {
    n: '08', clientId: 'cli-1011', date: -8, terms: 'net_30', status: 'sent',
    // A whole-invoice discount, spread pro rata across the lines by the
    // totals module — the one figure here that is not simply qty x rate.
    discountPaise: rupees(2_000),
    notes: 'Long-standing client discount applied.',
    items: [
      { serviceId: 'svc-itr', itemName: 'Income Tax Return — Company', description: 'ITR-6 preparation and filing', hsnSac: '998231', ratePaise: rupees(22_000) },
      { itemName: 'Out-of-pocket expenses (reimbursement)', description: 'Travel to the Coimbatore plant', hsnSac: '998222', ratePaise: rupees(3_400), gstRatePercent: 0 },
    ],
  },
  {
    n: '09', clientId: 'cli-1012', date: -3, terms: 'net_7', status: 'cancelled',
    notes: 'Raised in error — superseded by a revised invoice.',
    items: [
      { serviceId: 'svc-gst-filing', itemName: 'GST Filing Retainer', description: 'GSTR-1 and GSTR-3B', hsnSac: '998222', ratePaise: rupees(5_000) },
    ],
  },
  {
    n: '10', clientId: 'cli-1004', date: -1, terms: 'net_30', status: 'draft',
    items: [
      { serviceId: 'svc-inc', itemName: 'Company Incorporation — Professional Fee', description: 'SPICe+ Part A and Part B, AGILE-PRO', hsnSac: '998231', ratePaise: rupees(32_000) },
      { itemName: 'Stamp duty and name reservation (reimbursement)', description: 'Paid to MCA at actuals', hsnSac: '998231', ratePaise: rupees(4_800), gstRatePercent: 0 },
      // 5% is the slab whose intra-state half is 2.5% — not a whole percent,
      // which is exactly the case HALF_RATE_BPS exists to get right.
      { itemName: 'Courier and printing', description: 'Certified copies dispatched to the registered office', hsnSac: '996812', ratePaise: rupees(950), gstRatePercent: 5 },
    ],
  },
]

async function seedInvoices(): Promise<number> {
  const bank = await prisma.firmBankAccount.findFirst({
    where: { organisationId: ORG, isActive: true, isDefault: true },
  })
  const preparer = await prisma.employee.findUnique({ where: { id: 'emp-mgr' } })
  const clients = await prisma.client.findMany({
    where: { id: { in: INVOICES.map((i) => i.clientId) } },
    select: { id: true, companyName: true, address: true, gstin: true },
  })
  const byId = new Map(clients.map((c) => [c.id, c]))

  for (const s of INVOICES) {
    const client = byId.get(s.clientId)
    if (!client) {
      console.warn(`  ! ${s.clientId} not found — skipping invoice ${s.n}`)
      continue
    }

    const lines = s.items.map((i) => ({
      quantityCenti: i.quantityCenti ?? 100,
      ratePaise: i.ratePaise,
      discountPercent: i.discountPercent ?? 0,
      gstRatePercent: i.gstRatePercent ?? 18,
    }))

    // Two passes: the first gets the total so the paid fraction can be turned
    // into a whole-rupee figure, the second records the balance that follows
    // from it. Asking for "half paid" and storing an exact half-paisa would
    // be a payment no bank could have made.
    const gross = invoiceTotals(lines, {
      invoiceDiscountPaise: s.discountPaise,
      isInterState: s.interState,
    })
    const paidPaise = s.paid ? Math.round((gross.totalPaise * s.paid) / 100) * 100 : 0
    const t = invoiceTotals(lines, {
      invoiceDiscountPaise: s.discountPaise,
      isInterState: s.interState,
      amountPaidPaise: paidPaise,
    })

    const invoiceDate = d(s.date)
    const sent = s.status !== 'draft'

    await prisma.$transaction(async (tx) => {
      const invoiceNumber = await nextInvoiceNumber(tx)
      await tx.invoice.create({
        data: {
          id: `inv-sample-${s.n}`,
          organisationId: ORG,
          invoiceNumber,
          clientId: s.clientId,
          invoiceDate,
          terms: s.terms,
          dueDate: dueDateFor(invoiceDate, s.terms),
          placeOfSupply: s.interState ? KA : TN,
          isInterState: s.interState ?? false,
          status: s.status,
          // §39 — the party AS AT ISSUE, so editing a client master later
          // cannot rewrite an invoice that has already gone out.
          billingName: client.companyName,
          billingAddress: client.address,
          shipSameAsBill: true,
          shippingName: client.companyName,
          shippingAddress: client.address,
          customerGstin: client.gstin,
          subtotalPaise: t.subtotalPaise,
          discountPaise: t.discountPaise,
          taxablePaise: t.taxablePaise,
          cgstPaise: t.cgstPaise,
          sgstPaise: t.sgstPaise,
          igstPaise: t.igstPaise,
          roundOffPaise: t.roundOffPaise,
          totalPaise: t.totalPaise,
          amountPaidPaise: paidPaise,
          balanceDuePaise: t.balanceDuePaise,
          notes: s.notes ?? null,
          templateId: 'tax-invoice',
          bankAccountId: bank?.id ?? null,
          bankSnapshot: bank
            ? {
                id: bank.id,
                label: bank.label,
                account_number: bank.accountNumber,
                account_type: bank.accountType,
                account_holder: bank.accountHolder,
                bank_name: bank.bankName,
                branch_name: bank.branchName,
                ifsc_code: bank.ifscCode,
                upi_id: bank.upiId,
              }
            : undefined,
          signatoryName: preparer?.fullName ?? 'Vikram Shetty',
          signatoryDesignation: 'Partner',
          qrMode: 'upi_amount',
          preparedById: preparer?.id ?? null,
          sentAt: sent ? ts(s.date + 1) : null,
          paidAt: s.status === 'paid' ? ts(s.date + (TERM_DAYS[s.terms] ?? 0)) : null,
          cancelledAt: s.status === 'cancelled' ? ts(s.date + 1, 16) : null,
          items: {
            create: s.items.map((i, idx) => ({
              serviceId: i.serviceId ?? null,
              sortOrder: idx,
              itemName: i.itemName,
              description: i.description ?? null,
              hsnSac: i.hsnSac ?? null,
              quantityCenti: i.quantityCenti ?? 100,
              unit: i.unit ?? 'Nos',
              ratePaise: i.ratePaise,
              discountPercent: i.discountPercent ?? 0,
              gstRatePercent: i.gstRatePercent ?? 18,
              taxableAmountPaise: t.lines[idx].taxableAmountPaise,
              cgstAmountPaise: t.lines[idx].cgstAmountPaise,
              sgstAmountPaise: t.lines[idx].sgstAmountPaise,
              igstAmountPaise: t.lines[idx].igstAmountPaise,
              totalAmountPaise: t.lines[idx].totalAmountPaise,
            })),
          },
        },
      })
      console.log(`  + ${invoiceNumber}  ${client.companyName.padEnd(30)} ${(t.totalPaise / 100).toFixed(2).padStart(12)}  ${s.status}`)
    })
  }
  return INVOICES.length
}

// ═══════════════════════════════════════════════════════════════════════════
// QUOTATIONS
//
// Ten proposals, eight against clients and two against open leads, covering
// every status the list view filters on. The win-rate statistic is only
// meaningful with both accepted and rejected rows present, so both are here.
// ═══════════════════════════════════════════════════════════════════════════

interface QuoteItemSeed {
  serviceId?: string
  description: string
  detail?: string
  quantityCenti?: number
  unitRatePaise: number
  gstRatePercent?: number
  frequency?: string
  category?: string
}

interface QuotationSeed {
  n: string
  clientId?: string
  leadId?: string
  subject: string
  date: number
  validDays: number
  status: 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired'
  interState?: boolean
  discountPaise?: number
  rejectionReason?: string
  items: QuoteItemSeed[]
}

const QUOTATIONS: QuotationSeed[] = [
  {
    n: '01', clientId: 'cli-1003', subject: 'Annual compliance retainer — FY 2026-27',
    date: -50, validDays: 30, status: 'accepted',
    items: [
      { serviceId: 'svc-gst-filing', description: 'GST Filing', detail: 'GSTR-1 and GSTR-3B, monthly', unitRatePaise: rupees(6_000), frequency: 'Monthly', category: 'Compliance' },
      { serviceId: 'svc-tds-filing', description: 'TDS Returns', detail: 'Form 24Q and 26Q, quarterly', unitRatePaise: rupees(4_000), frequency: 'Quarterly', category: 'Compliance' },
      { serviceId: 'svc-itr', description: 'Income Tax Return', unitRatePaise: rupees(18_000), frequency: 'Yearly', category: 'Direct tax' },
    ],
  },
  {
    n: '02', clientId: 'cli-1006', subject: 'E-invoicing rollout and ERP integration',
    date: -40, validDays: 30, status: 'accepted',
    items: [
      { serviceId: 'svc-einvoice', description: 'E-invoicing Setup', detail: 'IRP registration, ERP connector, UAT', unitRatePaise: rupees(25_000), frequency: 'One-Time' },
      { serviceId: 'svc-other', description: 'Staff training', detail: 'Two half-day sessions, on site', quantityCenti: 200, unitRatePaise: rupees(6_000), frequency: 'One-Time' },
    ],
  },
  {
    n: '03', clientId: 'cli-1002', subject: 'Bookkeeping and monthly MIS',
    date: -35, validDays: 21, status: 'rejected',
    rejectionReason: 'Client appointed an in-house accountant.',
    items: [
      { serviceId: 'svc-book', description: 'Bookkeeping', detail: 'Write-up, reconciliation and monthly MIS', unitRatePaise: rupees(9_000), frequency: 'Monthly' },
    ],
  },
  {
    n: '04', clientId: 'cli-1005', subject: 'Export documentation and GST refund support',
    date: -28, validDays: 21, status: 'expired',
    items: [
      { serviceId: 'svc-gst-filing', description: 'GST refund applications', detail: 'RFD-01 for zero-rated supplies', quantityCenti: 400, unitRatePaise: rupees(3_500), frequency: 'Quarterly' },
      { serviceId: 'svc-other', description: 'LUT filing', unitRatePaise: rupees(2_500), frequency: 'Yearly' },
    ],
  },
  {
    n: '05', clientId: 'cli-1009', subject: 'Statutory audit support — FY 2025-26',
    date: -20, validDays: 30, status: 'sent',
    items: [
      { serviceId: 'svc-other', description: 'Audit support', detail: 'Schedules, confirmations and working papers', quantityCenti: 6_000, unitRatePaise: rupees(850), frequency: 'One-Time' },
      { serviceId: 'svc-book', description: 'Ledger scrutiny', unitRatePaise: rupees(15_000), frequency: 'One-Time' },
    ],
  },
  {
    n: '06', clientId: 'cli-1011', subject: 'Transfer pricing documentation',
    date: -14, validDays: 30, status: 'sent',
    discountPaise: rupees(5_000),
    items: [
      { serviceId: 'svc-other', description: 'Transfer pricing study', detail: 'Benchmarking and Form 3CEB', unitRatePaise: rupees(85_000), frequency: 'Yearly' },
    ],
  },
  {
    n: '07', clientId: 'cli-1001', subject: 'Karnataka branch — GST registration and filings',
    date: -12, validDays: 30, status: 'sent', interState: true,
    items: [
      { serviceId: 'svc-gst-reg', description: 'GST Registration — Karnataka', unitRatePaise: rupees(7_500), frequency: 'One-Time' },
      { serviceId: 'svc-gst-filing', description: 'GST Filing — Karnataka GSTIN', unitRatePaise: rupees(5_000), frequency: 'Monthly' },
    ],
  },
  {
    n: '08', clientId: 'cli-1012', subject: 'Stock audit and valuation',
    date: -5, validDays: 30, status: 'draft',
    items: [
      { serviceId: 'svc-other', description: 'Stock audit', detail: 'Physical verification at two locations', quantityCenti: 200, unitRatePaise: rupees(18_000), frequency: 'One-Time' },
    ],
  },
  {
    n: '09', leadId: 'lead-1010', subject: 'Income tax filing — proprietorship',
    date: -18, validDays: 21, status: 'sent',
    items: [
      { serviceId: 'svc-itr', description: 'Income Tax Return — ITR-3', detail: 'Including capital gains schedule', unitRatePaise: rupees(9_500), frequency: 'Yearly' },
    ],
  },
  {
    n: '10', leadId: 'lead-1006', subject: 'Private limited company incorporation',
    date: -9, validDays: 30, status: 'sent',
    items: [
      { serviceId: 'svc-inc', description: 'Company Incorporation', detail: 'SPICe+ Part A and B, AGILE-PRO, two DSCs', unitRatePaise: rupees(32_000), frequency: 'One-Time' },
      { description: 'Government fee and stamp duty (at actuals)', unitRatePaise: rupees(6_800), gstRatePercent: 0, frequency: 'One-Time' },
    ],
  },
]

async function seedQuotations(): Promise<number> {
  const preparer = await prisma.employee.findUnique({ where: { id: 'emp-mgr' } })
  const year = new Date().getFullYear()

  for (const s of QUOTATIONS) {
    const lines = s.items.map((i) => ({
      quantityCenti: i.quantityCenti ?? 100,
      unitRatePaise: i.unitRatePaise,
      discountPercent: 0,
      gstRatePercent: i.gstRatePercent ?? 18,
    }))
    const t = quotationTotals(lines, { discountPaise: s.discountPaise, isInterState: s.interState })

    const quoteDate = d(s.date)
    const sent = s.status !== 'draft'

    await prisma.$transaction(async (tx) => {
      const quotationCode = await nextQuotationCode(tx, year)
      await tx.quotation.create({
        data: {
          id: `qt-sample-${s.n}`,
          organisationId: ORG,
          quotationCode,
          clientId: s.clientId ?? null,
          leadId: s.leadId ?? null,
          subject: s.subject,
          quoteDate,
          validUntil: d(s.date + s.validDays),
          status: s.status,
          placeOfSupply: s.interState ? KA : TN,
          isInterState: s.interState ?? false,
          subtotalPaise: t.subtotalPaise,
          discountPaise: t.discountPaise,
          taxablePaise: t.taxablePaise,
          cgstPaise: t.cgstPaise,
          sgstPaise: t.sgstPaise,
          igstPaise: t.igstPaise,
          totalPaise: t.totalPaise,
          terms: 'Fees are payable within 15 days of the invoice date. Government fees and out-of-pocket expenses are billed at actuals.',
          templateId: 'gst-line-item',
          introduction: 'Thank you for the opportunity. We are pleased to set out our proposal for the services described below.',
          closingText: 'Thanks',
          preparedByName: preparer?.fullName ?? 'Vikram Shetty',
          preparedByDesignation: 'Partner',
          preparedById: preparer?.id ?? null,
          sentAt: sent ? ts(s.date, 15) : null,
          acceptedAt: s.status === 'accepted' ? ts(s.date + 7) : null,
          rejectedAt: s.status === 'rejected' ? ts(s.date + 10) : null,
          rejectionReason: s.rejectionReason ?? null,
          items: {
            create: s.items.map((i, idx) => ({
              serviceId: i.serviceId ?? null,
              description: i.description,
              detail: i.detail ?? null,
              category: i.category ?? null,
              frequency: i.frequency ?? null,
              quantityCenti: i.quantityCenti ?? 100,
              unitRatePaise: i.unitRatePaise,
              discountPercent: 0,
              gstRatePercent: i.gstRatePercent ?? 18,
              amountPaise: t.lines[idx].amountPaise,
              taxPaise: t.lines[idx].taxPaise,
              sortOrder: idx,
            })),
          },
        },
      })
      console.log(`  + ${quotationCode}  ${s.subject.slice(0, 44).padEnd(46)} ${(t.totalPaise / 100).toFixed(2).padStart(12)}  ${s.status}`)
    })
  }
  return QUOTATIONS.length
}

// ═══════════════════════════════════════════════════════════════════════════
// ENGAGEMENT LETTERS
//
// Ten letters. The fee table deliberately mixes monthly, quarterly, yearly
// and per-return lines — the model carries no total for exactly that reason,
// and a sample set of uniformly monthly fees would hide it.
// ═══════════════════════════════════════════════════════════════════════════

interface FeeSeed {
  service: string
  description?: string
  frequency: string
  amountPaise: number
  billingBasis?: string
}

interface LetterSeed {
  n: string
  clientId?: string
  leadId?: string
  subject: string
  date: number
  status: 'draft' | 'sent' | 'accepted' | 'archived'
  fy: string
  fees: FeeSeed[]
}

/** The financial year a date falls in, as a firm writes it: April to March. */
function fyOf(offset: number): string {
  const dt = new Date(now.getTime() + offset * DAY)
  const y = dt.getUTCFullYear()
  const start = dt.getUTCMonth() >= 3 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

const LETTERS: LetterSeed[] = [
  {
    n: '01', clientId: 'cli-1003', subject: 'Engagement for accounting and compliance services',
    date: -50, status: 'accepted', fy: fyOf(-50),
    fees: [
      { service: 'Bookkeeping and accounting', description: 'Monthly write-up, bank and vendor reconciliation', frequency: 'per month', amountPaise: rupees(8_000), billingBasis: 'Billed monthly in arrears' },
      { service: 'GST returns', description: 'GSTR-1 and GSTR-3B', frequency: 'per month', amountPaise: rupees(6_000) },
      { service: 'TDS returns', description: 'Form 24Q and 26Q', frequency: 'per quarter', amountPaise: rupees(4_000) },
      { service: 'Income tax return', frequency: 'per year', amountPaise: rupees(18_000) },
    ],
  },
  {
    n: '02', clientId: 'cli-1006', subject: 'Engagement for e-invoicing implementation and support',
    date: -40, status: 'accepted', fy: fyOf(-40),
    fees: [
      { service: 'E-invoicing implementation', description: 'IRP registration, ERP connector and UAT', frequency: 'one time', amountPaise: rupees(25_000), billingBasis: '50% on signing, 50% on go-live' },
      { service: 'Post go-live support', frequency: 'per month', amountPaise: rupees(4_000) },
    ],
  },
  {
    n: '03', clientId: 'cli-1002', subject: 'Engagement for bookkeeping services',
    date: -34, status: 'sent', fy: fyOf(-34),
    fees: [
      { service: 'Bookkeeping', description: 'Write-up, reconciliation and monthly MIS', frequency: 'per month', amountPaise: rupees(9_000) },
      { service: 'Annual accounts preparation', frequency: 'per year', amountPaise: rupees(15_000) },
    ],
  },
  {
    n: '04', clientId: 'cli-1005', subject: 'Engagement for GST refund and export documentation',
    date: -30, status: 'sent', fy: fyOf(-30),
    fees: [
      { service: 'GST refund applications', description: 'RFD-01 for zero-rated supplies', frequency: 'per return', amountPaise: rupees(3_500) },
      { service: 'Letter of Undertaking', frequency: 'per year', amountPaise: rupees(2_500) },
    ],
  },
  {
    n: '05', clientId: 'cli-1008', subject: 'Engagement for GST registration and monthly filings',
    date: -24, status: 'accepted', fy: fyOf(-24),
    fees: [
      { service: 'GST registration', frequency: 'one time', amountPaise: rupees(7_500) },
      { service: 'GST returns', frequency: 'per month', amountPaise: rupees(3_500) },
    ],
  },
  {
    n: '06', clientId: 'cli-1009', subject: 'Engagement for statutory audit support — FY 2025-26',
    date: -20, status: 'sent', fy: fyOf(-20),
    fees: [
      { service: 'Audit support', description: 'Schedules, confirmations and working papers', frequency: 'per hour', amountPaise: rupees(850), billingBasis: 'Billed monthly against a time sheet' },
      { service: 'Ledger scrutiny', frequency: 'one time', amountPaise: rupees(15_000) },
    ],
  },
  {
    n: '07', clientId: 'cli-1011', subject: 'Engagement for transfer pricing documentation',
    date: -14, status: 'sent', fy: fyOf(-14),
    fees: [
      { service: 'Transfer pricing study', description: 'Benchmarking analysis and Form 3CEB', frequency: 'per year', amountPaise: rupees(85_000), billingBasis: '50% on commencement, 50% on issue of the report' },
    ],
  },
  {
    n: '08', clientId: 'cli-1001', subject: 'Engagement for Karnataka branch compliance',
    date: -11, status: 'draft', fy: fyOf(-11),
    fees: [
      { service: 'GST registration — Karnataka', frequency: 'one time', amountPaise: rupees(7_500) },
      { service: 'GST returns — Karnataka GSTIN', frequency: 'per month', amountPaise: rupees(5_000) },
    ],
  },
  {
    n: '09', clientId: 'cli-1007', subject: 'Engagement for accounting services — FY 2024-25',
    date: -400, status: 'archived', fy: fyOf(-400),
    fees: [
      { service: 'Bookkeeping', frequency: 'per month', amountPaise: rupees(6_500) },
      { service: 'Income tax return', frequency: 'per year', amountPaise: rupees(12_000) },
    ],
  },
  {
    n: '10', leadId: 'lead-1006', subject: 'Engagement for company incorporation',
    date: -8, status: 'draft', fy: fyOf(-8),
    fees: [
      { service: 'Incorporation — professional fee', description: 'SPICe+ Part A and B, AGILE-PRO, two DSCs', frequency: 'one time', amountPaise: rupees(32_000) },
      { service: 'Government fee and stamp duty', description: 'Recovered at actuals', frequency: 'at actuals', amountPaise: rupees(6_800) },
    ],
  },
]

async function seedLetters(): Promise<number> {
  const preparer = await prisma.employee.findUnique({ where: { id: 'emp-mgr' } })
  const year = new Date().getFullYear()

  const clients = await prisma.client.findMany({
    select: { id: true, companyName: true, address: true, contactPerson: true },
  })
  const byClient = new Map(clients.map((c) => [c.id, c]))
  const leads = await prisma.lead.findMany({ select: { id: true, name: true } })
  const byLead = new Map(leads.map((l) => [l.id, l]))

  for (const s of LETTERS) {
    const c = s.clientId ? byClient.get(s.clientId) : undefined
    const l = s.leadId ? byLead.get(s.leadId) : undefined
    if (!c && !l) {
      console.warn(`  ! party missing — skipping letter ${s.n}`)
      continue
    }

    const letterDate = d(s.date)
    const sent = s.status !== 'draft'

    await prisma.$transaction(async (tx) => {
      const letterCode = await nextEngagementCode(tx, year)
      await tx.engagementLetter.create({
        data: {
          id: `el-sample-${s.n}`,
          organisationId: ORG,
          letterCode,
          clientId: s.clientId ?? null,
          leadId: s.leadId ?? null,
          subject: s.subject,
          letterDate,
          effectiveFrom: letterDate,
          // The engagement runs to 31 March of the financial year it opens in.
          effectiveUntil: `${Number(s.fy.slice(0, 4)) + 1}-03-31`,
          financialYear: s.fy,
          status: s.status,
          // §39 again — the recipient as at sending, not the live master row.
          recipientSnapshot: {
            name: c?.contactPerson ?? l?.name ?? null,
            company: c?.companyName ?? null,
            address: c?.address ?? null,
          },
          templateId: 'jns-accounting',
          signatoryName: preparer?.fullName ?? 'Vikram Shetty',
          signatoryDesignation: 'Partner',
          clientSignatoryName: c?.contactPerson ?? l?.name ?? null,
          clientSignatoryDesignation: 'Authorised Signatory',
          preparedById: preparer?.id ?? null,
          sentAt: sent ? ts(s.date, 12) : null,
          acceptedAt: s.status === 'accepted' ? ts(s.date + 5) : null,
          feeItems: {
            create: s.fees.map((f, idx) => ({
              sortOrder: idx,
              service: f.service,
              description: f.description ?? null,
              frequency: f.frequency,
              amountPaise: f.amountPaise,
              billingBasis: f.billingBasis ?? null,
            })),
          },
        },
      })
      console.log(`  + ${letterCode}  ${(c?.companyName ?? l?.name ?? '').padEnd(30)} ${String(s.fees.length).padStart(2)} fee line(s)  ${s.status}`)
    })
  }
  return LETTERS.length
}

// ═══════════════════════════════════════════════════════════════════════════
// WORKSTATION DOCS
//
// Ten of the sixteen statutory types, one each, so the Doc list has every
// category represented — Director, Company law, GST & registration and
// Agreement. `blockConfig` is left null on purpose: a null means the editor
// composes the type's own template on open, which is exactly what a document
// created through the UI and not yet edited looks like. Writing blocks here
// would freeze a copy of the template that stops tracking registry.ts.
// ═══════════════════════════════════════════════════════════════════════════

interface DocSeed {
  n: string
  docType: string
  title: string
  clientId?: string
  leadId?: string
  date: number
  status: 'draft' | 'final' | 'archived'
  fieldValues: Record<string, string>
}

const DOCS: DocSeed[] = [
  {
    n: '01', docType: 'consent-letter', title: 'Consent to act as Director — S. Ramanathan',
    clientId: 'cli-1001', date: -42, status: 'final',
    fieldValues: {
      company_name: 'ABC Private Limited',
      registered_office: 'No. 14, 2nd Main Road, Indiranagar, Bengaluru 560038',
      director_name: 'S. Ramanathan', father_name: 'Sundaram', din: '09876543',
      director_address: 'Flat 4B, Lake View Apartments, Bengaluru 560038',
      email: 'ramanathan@abcpvt.in', mobile: '+91 98860 11223',
    },
  },
  {
    n: '02', docType: 'appointment-letter', title: 'Appointment of Additional Director',
    clientId: 'cli-1003', date: -38, status: 'final',
    fieldValues: {
      company_name: 'Meridian Logistics Pvt Ltd',
      director_name: 'Anitha Raghavan', din: '08123456', director_place: 'Chennai',
      board_meeting_date: d(-40),
      signatory_name: 'K. Meridian', signatory_designation: 'Director', signatory_din: '07112233',
    },
  },
  {
    n: '03', docType: 'board-resolution-appointment', title: 'Board Resolution — Appointment of Director',
    clientId: 'cli-1006', date: -30, status: 'final',
    fieldValues: {
      company_name: 'Vertex Software Solutions',
      registered_office: 'Module 7, TIDEL Park, Taramani, Chennai 600113',
      cin: 'U72900TN2019PTC131456',
      appointee_name: 'Dinesh Kumar', authorised_director: 'Lakshmi Narayanan',
      meeting_date: d(-30), meeting_time: '11:00', meeting_place: 'Registered office',
      signatory1_name: 'Lakshmi Narayanan', signatory1_din: '06998877',
      signatory2_name: 'Dinesh Kumar', signatory2_din: '09445566',
    },
  },
  {
    n: '04', docType: 'board-resolution-authorised-signatory', title: 'Board Resolution — Authorised Signatory for GST',
    clientId: 'cli-1009', date: -25, status: 'final',
    fieldValues: {
      company_name: 'Skyline Interiors Pvt Ltd',
      registered_office: 'No. 8, Cathedral Road, Chennai 600086',
      meeting_date: d(-25), meeting_time: '15:30', meeting_place: 'Registered office',
      director_name: 'Praveen Shankar', purpose: 'GST registration and filings',
      signatory1_name: 'Praveen Shankar', signatory1_designation: 'Managing Director',
      signatory1_din: '07334455', place: 'Chennai',
    },
  },
  {
    n: '05', docType: 'noc-gst', title: 'NOC from premises owner — GST registration',
    clientId: 'cli-1008', date: -20, status: 'final',
    fieldValues: {
      owner_name: 'R. Bharathi', owner_relation: 'Proprietor’s mother',
      property_address: 'No. 23, Bazaar Street, Salem 636001',
      concern_name: 'Bharath Enterprises', proprietor_name: 'Bharath Kumar',
      pan: 'ABCPB1234K', nature_of_business: 'Trading in hardware and tools',
      place: 'Salem',
    },
  },
  {
    n: '06', docType: 'noc-incorporation', title: 'NOC from premises owner — incorporation',
    leadId: 'lead-1006', date: -16, status: 'draft',
    fieldValues: {
      owner_names: 'Revathi Sundar and S. Sundar',
      property_address: 'Plot 12, Sector 3, Ambattur Industrial Estate, Chennai 600058',
      directors: 'Revathi Sundar', directors2: 'S. Sundar',
      owner1_name: 'Revathi Sundar', owner2_name: 'S. Sundar', place: 'Chennai',
    },
  },
  {
    n: '07', docType: 'llp-agreement', title: 'LLP Agreement — Sunrise Textiles LLP',
    clientId: 'cli-1002', date: -60, status: 'final',
    fieldValues: {
      llp_name: 'Sunrise Textiles LLP',
      registered_office: 'No. 55, Mill Road, Tiruppur 641604',
      place: 'Tiruppur', agreement_date: d(-60),
      contribution: '10,00,000', business_activity: 'Manufacture and export of knitted garments',
      partner1_name: 'M. Sundararajan', partner1_details: 'S/o Murugan, aged 48, Tiruppur', partner1_din: '05667788',
      partner2_name: 'P. Kalaiselvi', partner2_details: 'W/o Sundararajan, aged 44, Tiruppur', partner2_din: '05667799',
    },
  },
  {
    n: '08', docType: 'partnership-agreement', title: 'Partnership Deed — Coastal Marine Exports',
    clientId: 'cli-1005', date: -90, status: 'final',
    fieldValues: {
      firm_name: 'Coastal Marine Exports',
      business_address: 'No. 3, Harbour Road, Thoothukudi 628001',
      nature_of_business: 'Processing and export of marine products',
      place: 'Thoothukudi', agreement_date: d(-90), capital_each: '5,00,000',
      partner1_name: 'A. Fernando', partner1_aadhaar: '2345 6789 0123', partner1_details: 'S/o Anthony, aged 51, Thoothukudi',
      partner2_name: 'J. Maria Selvam', partner2_aadhaar: '3456 7890 1234', partner2_details: 'S/o Selvam, aged 46, Thoothukudi',
    },
  },
  {
    n: '09', docType: 'epf-letter', title: 'EPF registration covering letter',
    clientId: 'cli-1011', date: -12, status: 'draft',
    fieldValues: {
      company_name: 'Precision Tools Manufacturing',
      registered_office: 'SF No. 210, Avinashi Road, Coimbatore 641014',
      cin: 'U29100TN2021PTC142789', incorporation_date: d(-500),
      epf_code: 'TNCBE2145678', epfo_office: 'Regional Office, Coimbatore',
      director_count: '3', signatory_name: 'V. Manikandan', signatory_din: '09223344',
    },
  },
  {
    n: '10', docType: 'lease-deed', title: 'Lease Deed — showroom premises',
    clientId: 'cli-1012', date: -6, status: 'draft',
    fieldValues: {
      place: 'Madurai', execution_day: '6th', execution_date: d(-6),
      lessor_name: 'S. Meenakshi Sundaram', lessor_aadhaar: '4567 8901 2345',
      lessor_address: 'No. 9, West Masi Street, Madurai 625001',
      lessee_name: 'Lakshmi Jewellers', lessee_address: 'No. 41, Town Hall Road, Madurai 625001',
      lessee_represented_by: 'L. Kasthuri, Partner',
      property_address: 'Ground floor, No. 41, Town Hall Road, Madurai 625001',
      lease_period: '5 years', lease_from: d(0), lease_to: d(1825),
      notice_period: '3 months', monthly_rent: '85,000', security_deposit: '10,00,000',
      rent_due_day: '5th',
      witness1_name: 'R. Chandran', witness1_address: 'Madurai', witness1_phone: '+91 94430 55667', witness1_aadhaar: '5678 9012 3456',
      witness2_name: 'T. Vasanthi', witness2_address: 'Madurai', witness2_phone: '+91 94430 55668', witness2_aadhaar: '6789 0123 4567',
    },
  },
]

async function seedDocs(): Promise<number> {
  const preparer = await prisma.employee.findUnique({ where: { id: 'emp-mgr' } })
  const year = new Date().getFullYear()

  for (const s of DOCS) {
    await prisma.$transaction(async (tx) => {
      const docCode = await nextWorkstationDocCode(tx, year)
      await tx.workstationDoc.create({
        data: {
          id: `doc-sample-${s.n}`,
          organisationId: ORG,
          docCode,
          docType: s.docType,
          title: s.title,
          clientId: s.clientId ?? null,
          leadId: s.leadId ?? null,
          docDate: d(s.date),
          status: s.status,
          fieldValues: s.fieldValues,
          preparedById: preparer?.id ?? null,
          finalisedAt: s.status === 'final' ? ts(s.date, 17) : null,
        },
      })
      console.log(`  + ${docCode}  ${s.docType.padEnd(38)} ${s.status}`)
    })
  }
  return DOCS.length
}

// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const org = await prisma.organisation.findUnique({ where: { id: ORG } })
  if (!org) {
    console.error(`Organisation '${ORG}' not found — run the main seed first (npm run db:setup).`)
    process.exit(1)
  }

  // Idempotency: drop only the rows this script owns. Items, fee lines and
  // quotation lines cascade from their parents, so nothing is orphaned.
  const removed = {
    invoices: (await prisma.invoice.deleteMany({ where: { id: { startsWith: 'inv-sample-' } } })).count,
    quotations: (await prisma.quotation.deleteMany({ where: { id: { startsWith: 'qt-sample-' } } })).count,
    letters: (await prisma.engagementLetter.deleteMany({ where: { id: { startsWith: 'el-sample-' } } })).count,
    docs: (await prisma.workstationDoc.deleteMany({ where: { id: { startsWith: 'doc-sample-' } } })).count,
  }
  const total = removed.invoices + removed.quotations + removed.letters + removed.docs
  if (total) console.log(`Replacing ${total} existing sample document(s).\n`)

  console.log('Invoices')
  const invoices = await seedInvoices()
  console.log('\nQuotations')
  const quotations = await seedQuotations()
  console.log('\nEngagement letters')
  const letters = await seedLetters()
  console.log('\nStatutory documents')
  const docs = await seedDocs()

  console.log(`\nSeeded ${invoices} invoices, ${quotations} quotations, ${letters} engagement letters, ${docs} statutory documents.`)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
