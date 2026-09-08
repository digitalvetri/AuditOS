import type { PrismaClient } from '@prisma/client'
import { applyBooksInvariants } from '../src/modules/books/db/invariants.js'
import { createBooksOrganisation } from '../src/modules/books/engine/organisation.js'
import type { BooksContext } from '../src/modules/books/engine/context.js'
import { Chart, Contacts, Items } from '../src/modules/books/services/masters.js'
import { Documents } from '../src/modules/books/services/documents.js'
import { Payments } from '../src/modules/books/services/payments.js'
import { Journals } from '../src/modules/books/services/journals.js'
import { Banking } from '../src/modules/books/services/banking.js'
import { FX } from '../src/modules/books/services/fx.js'
import { Recurring } from '../src/modules/books/services/recurring.js'

/**
 * DEMO BOOKS — two sets of books for the firm's own clients, each with a
 * quarter of real transactions so every screen and report has something to
 * show. Idempotent: it skips if books already exist.
 */
export async function seedBooks(prisma: PrismaClient, organisationId: string): Promise<{ organisations: number; documents: number }> {
  await applyBooksInvariants(prisma)
  const existing = await prisma.booksOrganisation.count({ where: { organisationId } })
  if (existing > 0) return { organisations: existing, documents: await prisma.booksDocument.count() }

  const md = await prisma.user.findFirst({ where: { organisationId, email: 'ravi@auditos.local' } })
  const fin = await prisma.user.findFirst({ where: { organisationId, email: 'anitha@auditos.local' } })
  const emp = await prisma.user.findFirst({ where: { organisationId, email: 'meera@auditos.local' } })
  // Each junior keeps one client's books, which is how the firm actually
  // assigns work and what makes the scoping visible in the demo.
  const articled = await prisma.user.findFirst({ where: { organisationId, email: 'karthik@auditos.local' } })
  const clients = await prisma.client.findMany({ where: { deletedAt: null }, take: 2 })

  // ── Set of books 1 — a Chennai trading company ─────────────────────────
  const org1 = await createBooksOrganisation(prisma, {
    organisationId, userId: md?.id ?? null, name: clients[0]?.companyName ?? 'Sharma Traders Pvt Ltd', legalName: clients[0]?.legalName ?? null,
    gstin: '33AAACS1234A1Z5', pan: 'AAACS1234A', stateCode: '33', stateName: 'Tamil Nadu', clientId: clients[0]?.id ?? null,
    addressLine1: '12 Mount Road', city: 'Chennai', pincode: '600002',
  })
  const ctx1: BooksContext = { booksOrgId: org1.id, organisationId, userId: md?.id ?? null, role: 'admin', baseCurrency: 'INR', stateCode: '33', tdsEnabled: true }
  for (const u of [fin, emp]) if (u) await prisma.booksMembership.create({ data: { booksOrgId: org1.id, userId: u.id, role: u === fin ? 'admin' : 'staff', createdBy: md?.id ?? null } })

  const groups = await Chart.groups(prisma, ctx1)
  const bankGroup = groups.find((g) => g.name === 'Bank Accounts')!
  const bank1 = await Chart.createLedger(prisma, ctx1, { name: 'HDFC Bank · 4521', group_id: bankGroup.id, opening_balance: 1250000_00, opening_balance_type: 'debit', opening_date: '2026-04-01', bank_name: 'HDFC Bank', bank_account_no: 'XXXX4521', bank_ifsc: 'HDFC0000123' })
  const rates = await prisma.booksTaxRate.findMany({ where: { booksOrgId: org1.id } })
  const gst18 = rates.find((r) => r.name === 'GST 18%')!
  const gst5 = rates.find((r) => r.name === 'GST 5%')!

  const cust = [
    await Contacts.create(prisma, ctx1, { type: 'customer', display_name: 'Lakshmi Textiles Pvt Ltd', company_name: 'Lakshmi Textiles Pvt Ltd', gstin: '33AABCL5678B1Z2', pan: 'AABCL5678B', email: 'accounts@lakshmitextiles.in', phone: '+91 98400 11111', payment_terms_days: 30, addresses: [{ kind: 'billing', line1: '5 Anna Salai', city: 'Chennai', state_code: '33', pincode: '600006' }] }),
    await Contacts.create(prisma, ctx1, { type: 'customer', display_name: 'Coimbatore Engineering Works', gstin: '33AAECC3456D1Z1', pan: 'AAECC3456D', payment_terms_days: 45 }),
    await Contacts.create(prisma, ctx1, { type: 'customer', display_name: 'Nila Foods (Bengaluru)', gstin: '29AAFCN7890E1Z7', pan: 'AAFCN7890E', place_of_supply_state: '29', payment_terms_days: 15 }),
    await Contacts.create(prisma, ctx1, { type: 'customer', display_name: 'Acme Inc (USA)', gst_treatment: 'overseas', currency: 'USD', payment_terms_days: 30 }),
  ]
  const vend = [
    await Contacts.create(prisma, ctx1, { type: 'vendor', display_name: 'Murugan & Co (Legal)', gstin: '33AADFM9012C1Z9', pan: 'AADFM9012C', tds_section: '194J', payment_terms_days: 15 }),
    await Contacts.create(prisma, ctx1, { type: 'vendor', display_name: 'Chennai Properties', gstin: '33AAGCP1111F1Z3', pan: 'AAGCP1111F', tds_section: '194I' }),
    await Contacts.create(prisma, ctx1, { type: 'both', display_name: 'Vetri Stationers', gstin: '33AAHCV2222G1Z4', pan: 'AAHCV2222G' }),
  ]
  const items = [
    await Items.create(prisma, ctx1, { name: 'Cotton fabric (per metre)', sku: 'FAB-100', unit: 'mtr', product_type: 'goods', item_type: 'sales_and_purchases', sell_rate: 450_00, purchase_rate: 310_00, tax_rate_id: gst5.id, hsn_sac: '5208' }),
    await Items.create(prisma, ctx1, { name: 'Machine spares kit', sku: 'SPR-22', unit: 'nos', product_type: 'goods', sell_rate: 12500_00, purchase_rate: 9000_00, tax_rate_id: gst18.id, hsn_sac: '8483' }),
    await Items.create(prisma, ctx1, { name: 'Consulting (per hour)', unit: 'hrs', product_type: 'service', sell_rate: 3500_00, tax_rate_id: gst18.id, hsn_sac: '998311' }),
  ]

  const rent = await prisma.booksLedger.findFirstOrThrow({ where: { booksOrgId: org1.id, name: 'Rent' } })
  const prof = await prisma.booksLedger.findFirstOrThrow({ where: { booksOrgId: org1.id, name: 'Professional Fees' } })
  const office = await prisma.booksLedger.findFirstOrThrow({ where: { booksOrgId: org1.id, name: 'Office Supplies' } })
  const furniture = await prisma.booksLedger.findFirstOrThrow({ where: { booksOrgId: org1.id, name: 'Furniture & Equipment' } })

  const post = async (kind: 'invoice' | 'bill' | 'credit_note' | 'retainer_invoice', input: Parameters<typeof Documents.create>[3]) =>
    Documents.post(prisma, ctx1, (await Documents.create(prisma, ctx1, kind, input)).id)

  // Sales
  const inv1 = await post('invoice', { contact_id: cust[0].id, date: '2026-04-03', lines: [{ item_id: items[0].id, quantity: 500, rate: 450_00 }, { item_id: items[2].id, quantity: 6, rate: 3500_00 }] })
  const inv2 = await post('invoice', { contact_id: cust[1].id, date: '2026-04-11', lines: [{ item_id: items[1].id, quantity: 4, rate: 12500_00 }] })
  const inv3 = await post('invoice', { contact_id: cust[2].id, date: '2026-04-18', lines: [{ item_id: items[0].id, quantity: 300, rate: 460_00 }] })   // inter-state → IGST
  const inv4 = await post('invoice', { contact_id: cust[1].id, date: '2026-05-06', lines: [{ item_id: items[2].id, quantity: 20, rate: 3500_00 }] })
  const inv5 = await post('invoice', { contact_id: cust[0].id, date: '2026-05-22', lines: [{ item_id: items[0].id, quantity: 900, rate: 450_00, discount_percent_bp: 500 }] })
  await FX.setRate(prisma, ctx1, { currency: 'USD', date: '2026-05-01', rate: 83.2 })
  const invUsd = await post('invoice', { contact_id: cust[3].id, date: '2026-05-01', currency: 'USD', exchange_rate: 83.2, lines: [{ description: 'Export consulting — May', rate: 4500_00 }] })
  const retainer = await post('retainer_invoice', { contact_id: cust[1].id, date: '2026-04-01', lines: [{ description: 'Annual retainer — advance', rate: 60000_00, tax_rate_id: gst18.id }] })
  const cn = await post('credit_note', { contact_id: cust[0].id, date: '2026-05-30', lines: [{ item_id: items[0].id, quantity: 20, rate: 450_00 }] })

  // Estimates / orders that never became invoices
  const est = await Documents.create(prisma, ctx1, 'estimate', { contact_id: cust[2].id, date: '2026-06-02', expiry_date: '2026-06-30', lines: [{ item_id: items[1].id, quantity: 10, rate: 12500_00 }] })
  await Documents.setStatus(prisma, ctx1, est.id, 'sent')
  await Documents.create(prisma, ctx1, 'sales_order', { contact_id: cust[0].id, date: '2026-06-05', lines: [{ item_id: items[0].id, quantity: 1200, rate: 445_00 }] })

  // Purchases
  const bill1 = await post('bill', { contact_id: vend[1].id, date: '2026-04-02', lines: [{ description: 'Office rent — April', rate: 85000_00, tax_rate_id: gst18.id, ledger_id: rent.id }] })
  const bill2 = await post('bill', { contact_id: vend[0].id, date: '2026-04-20', lines: [{ description: 'Legal opinion — contract review', rate: 45000_00, tax_rate_id: gst18.id, ledger_id: prof.id }] })
  const bill3 = await post('bill', { contact_id: vend[2].id, date: '2026-05-09', lines: [{ description: 'Stationery and printing', rate: 12400_00, tax_rate_id: gst18.id, ledger_id: office.id }] })
  const bill4 = await post('bill', { contact_id: vend[1].id, date: '2026-05-02', lines: [{ description: 'Office rent — May', rate: 85000_00, tax_rate_id: gst18.id, ledger_id: rent.id }] })
  await Documents.create(prisma, ctx1, 'purchase_order', { contact_id: vend[2].id, date: '2026-06-03', lines: [{ description: 'Toner cartridges', quantity: 6, rate: 4200_00, tax_rate_id: gst18.id, ledger_id: office.id }] })

  // Receipts and payments
  await Payments.create(prisma, ctx1, 'received', { contact_id: cust[0].id, date: '2026-04-25', amount: 200000_00, deposit_ledger_id: bank1.id, reference: 'NEFT 8891', allocations: [{ document_id: inv1.id, amount: 200000_00 }] })
  await Payments.create(prisma, ctx1, 'received', { contact_id: cust[1].id, date: '2026-04-15', amount: 70800_00, deposit_ledger_id: bank1.id, allocations: [{ document_id: retainer.id, amount: 70800_00 }] })
  await Documents.applyRetainer(prisma, ctx1, retainer.id, [{ document_id: inv4.id, amount: 60000_00 }], '2026-05-06')
  await Payments.create(prisma, ctx1, 'received', { contact_id: cust[2].id, date: '2026-05-04', amount: 130000_00, tds_amount: 1449_00, deposit_ledger_id: bank1.id, allocations: [{ document_id: inv3.id, amount: 131449_00 }] })
  await Documents.applyCredit(prisma, ctx1, cn.id, [{ document_id: inv5.id, amount: 9450_00 }], '2026-05-31')
  await Payments.create(prisma, ctx1, 'made', { contact_id: vend[1].id, date: '2026-04-07', amount: 91300_00, deposit_ledger_id: bank1.id, allocations: [{ document_id: bill1.id, amount: 91300_00 }] })
  await Payments.create(prisma, ctx1, 'made', { contact_id: vend[0].id, date: '2026-05-05', amount: 48600_00, deposit_ledger_id: bank1.id, allocations: [{ document_id: bill2.id, amount: 48600_00 }] })
  await Payments.create(prisma, ctx1, 'made', { contact_id: vend[2].id, date: '2026-05-20', amount: 14632_00, bank_charges: 25_00, deposit_ledger_id: bank1.id, allocations: [{ document_id: bill3.id, amount: 14632_00 }] })

  // Accountant work: depreciation, an asset purchase, a month-end revaluation
  await Journals.create(prisma, ctx1, { date: '2026-04-12', narration: 'Office chairs and desks', lines: [{ ledger_id: furniture.id, side: 'debit', amount: 78000_00 }, { ledger_id: bank1.id, side: 'credit', amount: 78000_00 }] })
  const dep = await prisma.booksLedger.findFirstOrThrow({ where: { booksOrgId: org1.id, name: 'Depreciation' } })
  await Journals.create(prisma, ctx1, { date: '2026-05-31', narration: 'Depreciation — May', lines: [{ ledger_id: dep.id, side: 'debit', amount: 1300_00 }, { ledger_id: furniture.id, side: 'credit', amount: 1300_00 }] })
  await FX.revalue(prisma, ctx1, { currency: 'USD', rate: 84.6, date: '2026-05-31' })

  // Banking: a statement to reconcile against
  await Banking.addStatementLines(prisma, ctx1, bank1.id, [
    { date: '2026-04-25', description: 'NEFT INWARD LAKSHMI TEXTILES', amount: 200000_00, reference: 'NEFT 8891' },
    { date: '2026-04-07', description: 'RTGS CHENNAI PROPERTIES', amount: -91300_00 },
    { date: '2026-05-31', description: 'BANK CHARGES', amount: -177_00 },
  ])

  await Recurring.create(prisma, ctx1, { kind: 'invoice', name: 'Lakshmi Textiles — monthly consulting', frequency: 'monthly', start_date: '2026-07-01', auto_post: false, template: { contact_id: cust[0].id, date: '2026-07-01', lines: [{ item_id: items[2].id, quantity: 10, rate: 3500_00 }] } })

  // ── Set of books 2 — a small Bengaluru services firm, less activity ─────
  const org2 = await createBooksOrganisation(prisma, {
    organisationId, userId: md?.id ?? null, name: clients[1]?.companyName ?? 'Nila Software LLP', gstin: '29AAFCN7890E1Z7', pan: 'AAFCN7890E', stateCode: '29', stateName: 'Karnataka',
    clientId: clients[1]?.id ?? null, city: 'Bengaluru',
  })
  const ctx2: BooksContext = { booksOrgId: org2.id, organisationId, userId: md?.id ?? null, role: 'admin', baseCurrency: 'INR', stateCode: '29', tdsEnabled: true }
  if (articled) await prisma.booksMembership.create({ data: { booksOrgId: org2.id, userId: articled.id, role: 'staff', createdBy: md?.id ?? null } })
  const groups2 = await Chart.groups(prisma, ctx2)
  const bank2 = await Chart.createLedger(prisma, ctx2, { name: 'ICICI Bank · 9034', group_id: groups2.find((g) => g.name === 'Bank Accounts')!.id, opening_balance: 420000_00, opening_date: '2026-04-01', bank_name: 'ICICI Bank' })
  const gst18b = (await prisma.booksTaxRate.findFirstOrThrow({ where: { booksOrgId: org2.id, name: 'GST 18%' } }))
  const c2 = await Contacts.create(prisma, ctx2, { type: 'customer', display_name: 'Bharat Systems', gstin: '29AAKCB4444H1Z8', pan: 'AAKCB4444H' })
  const v2 = await Contacts.create(prisma, ctx2, { type: 'vendor', display_name: 'Cloud Hosting Co', gstin: '29AALCC5555J1Z9', pan: 'AALCC5555J' })
  const i2 = await Items.create(prisma, ctx2, { name: 'Software licence (annual)', sell_rate: 90000_00, tax_rate_id: gst18b.id, hsn_sac: '998434' })
  const inv2a = await Documents.post(prisma, ctx2, (await Documents.create(prisma, ctx2, 'invoice', { contact_id: c2.id, date: '2026-04-08', lines: [{ item_id: i2.id, quantity: 2, rate: 90000_00 }] })).id)
  const b2a = await Documents.post(prisma, ctx2, (await Documents.create(prisma, ctx2, 'bill', { contact_id: v2.id, date: '2026-04-14', lines: [{ description: 'Cloud hosting — Q1', rate: 36000_00, tax_rate_id: gst18b.id }] })).id)
  await Payments.create(prisma, ctx2, 'received', { contact_id: c2.id, date: '2026-05-02', amount: 100000_00, deposit_ledger_id: bank2.id, allocations: [{ document_id: inv2a.id, amount: 100000_00 }] })
  await Payments.create(prisma, ctx2, 'made', { contact_id: v2.id, date: '2026-04-30', amount: 42480_00, deposit_ledger_id: bank2.id, allocations: [{ document_id: b2a.id, amount: 42480_00 }] })

  const documents = await prisma.booksDocument.count()
  console.log(`Books: 2 sets of books, ${documents} documents, ${await prisma.booksJournal.count()} journals, ${await prisma.booksAuditEvent.count()} audit events.`)
  return { organisations: 2, documents }
}

// `npm run seed:books` — seed Books alone against the dev database.
if (process.argv[1] && /seed-books\.(ts|js)$/.test(process.argv[1])) {
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()
  const org = await prisma.organisation.findFirstOrThrow({ where: { deletedAt: null } })
  await seedBooks(prisma, org.id).catch((e) => { console.error(e); process.exitCode = 1 })
  await prisma.$disconnect()
}
