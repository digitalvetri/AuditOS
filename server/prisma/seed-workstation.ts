/**
 * WORKSTATION SEED (AUDIT_OS_WORKSTATION.md §10).
 *
 * Every assignment references an employee that HRMS already seeded — there is
 * no second employee table and no new person is invented here:
 *
 *   emp-mgr        Vikram Shetty        account manager / service manager
 *   emp-exec       Meera Iyer           GST-side executive
 *   emp-articled   Karthik Subramanian  TDS / income-tax executive
 *   emp-probation  Divya Menon          bookkeeping / document collection
 *   emp-md         Ravi Krishnan        escalation
 *
 * Dates are anchored to the day the seed runs, so "Follow-ups Today",
 * "Overdue" and "Services Due Soon" are always true of the dataset rather
 * than true of the afternoon it was written.
 */
import type { PrismaClient } from '@prisma/client'

const AM = 'emp-mgr'
const GST = 'emp-exec'
const TDS = 'emp-articled'
const BOOK = 'emp-probation'
const MD = 'emp-md'

// ── date helpers (IST calendar dates as 'YYYY-MM-DD' strings) ──────────────
const DAY = 86_400_000
const now = new Date()
/** 'YYYY-MM-DD' for `offset` days from today, in IST. */
function d(offset: number): string {
  return new Date(now.getTime() + offset * DAY).toISOString().slice(0, 10)
}
/** A UTC instant at a given IST wall-clock time, `offset` days from today. */
function at(offset: number, istHour: number, istMinute = 0): Date {
  const base = new Date(now.getTime() + offset * DAY)
  const [y, m, day] = base.toISOString().slice(0, 10).split('-').map(Number)
  // IST is UTC+05:30, so subtract the offset to store the correct instant.
  return new Date(Date.UTC(y, m - 1, day, istHour - 5, istMinute - 30))
}
/** 'YYYY-MM' for `n` months before the current month. */
function period(monthsAgo: number): string {
  const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1))
  return dt.toISOString().slice(0, 7)
}

const rupees = (r: number) => r * 100

export async function seedWorkstation(prisma: PrismaClient, orgId: string) {
  // ── Service catalog (§6.3 [DECIDE], resolved to the prompt's own list) ──
  const SERVICES = [
    { id: 'svc-gst-filing', code: 'GST_FILING', name: 'GST Filing', sortOrder: 1 },
    { id: 'svc-gst-reg', code: 'GST_REGISTRATION', name: 'GST Registration', sortOrder: 2 },
    { id: 'svc-tds', code: 'TDS', name: 'TDS', sortOrder: 3 },
    { id: 'svc-tds-filing', code: 'TDS_FILING', name: 'TDS Filing', sortOrder: 4 },
    { id: 'svc-itr', code: 'INCOME_TAX_FILING', name: 'Income Tax Filing', sortOrder: 5 },
    { id: 'svc-eway', code: 'EWAY_BILL', name: 'E-way Bill', sortOrder: 6 },
    { id: 'svc-einvoice', code: 'E_INVOICE', name: 'E-invoice', sortOrder: 7 },
    { id: 'svc-book', code: 'BOOKKEEPING', name: 'Bookkeeping', sortOrder: 8 },
    { id: 'svc-inc', code: 'COMPANY_INCORPORATION', name: 'Company Incorporation', sortOrder: 9 },
    { id: 'svc-other', code: 'OTHER', name: 'Other', sortOrder: 10 },
  ]
  for (const s of SERVICES) {
    await prisma.service.upsert({
      where: { code: s.code },
      update: { name: s.name, sortOrder: s.sortOrder, isActive: true },
      create: { ...s, organisationId: orgId, isActive: true },
    })
  }

  // ── Document categories (§10.1) ────────────────────────────────────────
  const CATEGORIES = [
    { id: 'dc-gst', code: 'gst', name: 'GST', description: 'Registration, returns, certificates and supporting files', sortOrder: 1 },
    { id: 'dc-it', code: 'it_filing', name: 'IT Filing', description: 'Income tax documents, ITR, computation, supporting docs', sortOrder: 2 },
    { id: 'dc-basic', code: 'basic', name: 'Basic / Company Details', description: 'Registration, PAN, TAN, profile, address and bank proof', sortOrder: 3 },
    { id: 'dc-other', code: 'other', name: 'Other', description: 'Agreements, certificates and other client files', sortOrder: 4 },
  ]
  for (const c of CATEGORIES) {
    await prisma.documentCategory.upsert({
      where: { code: c.code },
      update: { name: c.name, description: c.description, sortOrder: c.sortOrder },
      create: { ...c, organisationId: orgId },
    })
  }

  // ── Clients (§10) — CLI-1001 … CLI-1012, ONE row per company ───────────
  const CLIENTS = [
    { id: 'cli-1001', code: 'CLI-1001', company: 'ABC Private Limited', legal: 'ABC Private Limited', type: 'Private Limited Company', person: 'Suresh Menon', phone: '9876543210', email: 'accounts@abcpl.in', gstin: '29ABCDE1234F1Z5', pan: 'ABCDE1234F', tan: 'CHEA12345B', am: AM, status: 'active', onboard: -420, addr: 'Anna Salai, Chennai 600002' },
    { id: 'cli-1002', code: 'CLI-1002', company: 'Sunrise Textiles LLP', legal: 'Sunrise Textiles LLP', type: 'LLP', person: 'Kavitha Raman', phone: '9840011223', email: 'finance@sunrisetex.in', gstin: '33SUNRI5678G1Z2', pan: 'SUNRI5678G', tan: null, am: AM, status: 'active', onboard: -365, addr: 'Tiruppur, Tamil Nadu 641604' },
    { id: 'cli-1003', code: 'CLI-1003', company: 'Meridian Logistics Pvt Ltd', legal: 'Meridian Logistics Private Limited', type: 'Private Limited Company', person: 'Arun Prakash', phone: '9791122334', email: 'ops@meridianlog.in', gstin: '33MERID9012H1Z7', pan: 'MERID9012H', tan: 'CHEM67890C', am: GST, status: 'active', onboard: -300, addr: 'Ambattur, Chennai 600058' },
    { id: 'cli-1004', code: 'CLI-1004', company: 'Nova Foods India Pvt Ltd', legal: 'Nova Foods India Private Limited', type: 'Private Limited Company', person: 'Deepa Krishnan', phone: '9500122334', email: 'deepa@novafoods.in', gstin: '33NOVAF3456J1Z9', pan: 'NOVAF3456J', tan: null, am: BOOK, status: 'pending_documents', onboard: -240, addr: 'Guindy, Chennai 600032' },
    { id: 'cli-1005', code: 'CLI-1005', company: 'Coastal Marine Exports', legal: 'Coastal Marine Exports', type: 'Partnership Firm', person: 'Jaya Kumar', phone: '9445566778', email: 'jaya@coastalmarine.in', gstin: '33COAST7890K1Z4', pan: 'COAST7890K', tan: null, am: GST, status: 'service_due', onboard: -200, addr: 'Thoothukudi, Tamil Nadu 628001' },
    { id: 'cli-1006', code: 'CLI-1006', company: 'Vertex Software Solutions', legal: 'Vertex Software Solutions Private Limited', type: 'Private Limited Company', person: 'Ramesh Iyer', phone: '9962233445', email: 'ramesh@vertexsoft.in', gstin: '33VERTE2345L1Z1', pan: 'VERTE2345L', tan: 'CHEV23456D', am: TDS, status: 'active', onboard: -180, addr: 'OMR, Chennai 600096' },
    { id: 'cli-1007', code: 'CLI-1007', company: 'Green Harvest Agro', legal: 'Green Harvest Agro Producer Company Limited', type: 'Producer Company', person: 'Muthu Selvam', phone: '9789900112', email: 'muthu@greenharvest.in', gstin: '33GREEN6789M1Z6', pan: 'GREEN6789M', tan: null, am: BOOK, status: 'inactive', onboard: -520, addr: 'Erode, Tamil Nadu 638001' },
    // Converted from leads — the five below carry sourceLeadId.
    { id: 'cli-1008', code: 'CLI-1008', company: 'Bharath Enterprises', legal: 'Bharath Enterprises', type: 'Proprietorship', person: 'Rahul Kumar', phone: '9876543211', email: 'rahul@bharathent.in', gstin: '33BHARA1122N1Z3', pan: 'BHARA1122N', tan: null, am: GST, status: 'active', onboard: -95, addr: 'Madurai, Tamil Nadu 625001', lead: 'lead-1016' },
    { id: 'cli-1009', code: 'CLI-1009', company: 'Skyline Interiors Pvt Ltd', legal: 'Skyline Interiors Private Limited', type: 'Private Limited Company', person: 'Nandhini Rao', phone: '9840099887', email: 'nandhini@skylineint.in', gstin: '33SKYLI3344P1Z8', pan: 'SKYLI3344P', tan: null, am: AM, status: 'active', onboard: -70, addr: 'Velachery, Chennai 600042', lead: 'lead-1017' },
    { id: 'cli-1010', code: 'CLI-1010', company: 'Anand Traders', legal: 'Anand Traders', type: 'Proprietorship', person: 'Anand Subramanian', phone: '9500988776', email: 'anand@anandtraders.in', gstin: '33ANAND5566Q1Z0', pan: 'ANAND5566Q', tan: null, am: BOOK, status: 'onboarding', onboard: -35, addr: 'Coimbatore, Tamil Nadu 641001', lead: 'lead-1018' },
    { id: 'cli-1011', code: 'CLI-1011', company: 'Precision Tools Manufacturing', legal: 'Precision Tools Manufacturing Private Limited', type: 'Private Limited Company', person: 'Vignesh Babu', phone: '9791877665', email: 'vignesh@precisiontools.in', gstin: '33PRECI7788R1Z5', pan: 'PRECI7788R', tan: 'CHEP34567E', am: TDS, status: 'pending_documents', onboard: -20, addr: 'Hosur, Tamil Nadu 635109', lead: 'lead-1019' },
    { id: 'cli-1012', code: 'CLI-1012', company: 'Lakshmi Jewellers', legal: 'Lakshmi Jewellers', type: 'Partnership Firm', person: 'Padma Lakshmi', phone: '9445766554', email: 'padma@lakshmijewel.in', gstin: '33LAKSH9900S1Z2', pan: 'LAKSH9900S', tan: null, am: GST, status: 'onboarding', onboard: -8, addr: 'T. Nagar, Chennai 600017', lead: 'lead-1020' },
  ]

  for (const c of CLIENTS) {
    await prisma.client.upsert({
      where: { id: c.id },
      update: {},
      create: {
        id: c.id, organisationId: orgId, clientCode: c.code,
        companyName: c.company, legalName: c.legal, businessType: c.type,
        contactPerson: c.person, contactNumber: c.phone, email: c.email, address: c.addr,
        gstin: c.gstin, pan: c.pan, tan: c.tan,
        accountManagerId: c.am, assignedTeam: 'Operations',
        status: c.status, onboardingDate: d(c.onboard),
        sourceLeadId: c.lead ?? null,
        createdAt: at(c.onboard, 10, 15),
      },
    })
    await prisma.clientContact.upsert({
      where: { id: `cc-${c.id}` },
      update: {},
      create: {
        id: `cc-${c.id}`, clientId: c.id, name: c.person,
        designation: 'Primary contact', phone: c.phone, email: c.email, isPrimary: true,
      },
    })
  }

  // ── Leads (§10) — 20, spread across every stage; 5 won AND converted ────
  const LEADS = [
    { n: 1001, name: 'Prakash Nair', phone: '9876500001', svc: 'svc-gst-reg', price: 5000, emp: GST, status: 'new', age: -2 },
    { n: 1002, name: 'Shanthi Devi', phone: '9876500002', svc: 'svc-book', price: 12000, emp: BOOK, status: 'new', age: -1 },
    { n: 1003, name: 'Imran Sheikh', phone: '9876500003', svc: 'svc-itr', price: 7500, emp: TDS, status: 'new', age: -3 },
    { n: 1004, name: 'Lalitha Ganesh', phone: '9876500004', svc: 'svc-gst-filing', price: 4000, emp: GST, status: 'new', age: 0 },
    { n: 1005, name: 'Vijay Anand', phone: '9876500005', svc: 'svc-tds-filing', price: 6000, emp: TDS, status: 'contacted', age: -6 },
    { n: 1006, name: 'Revathi Sundar', phone: '9876500006', svc: 'svc-inc', price: 25000, emp: AM, status: 'contacted', age: -8 },
    { n: 1007, name: 'Karan Malhotra', phone: '9876500007', svc: 'svc-einvoice', price: 9000, emp: GST, status: 'contacted', age: -5 },
    { n: 1008, name: 'Fathima Beevi', phone: '9876500008', svc: 'svc-book', price: 15000, emp: BOOK, status: 'requirement_identified', age: -12 },
    { n: 1009, name: 'Sridhar Rajan', phone: '9876500009', svc: 'svc-gst-filing', price: 4500, emp: GST, status: 'requirement_identified', age: -14 },
    { n: 1010, name: 'Preethi Varma', phone: '9876500010', svc: 'svc-itr', price: 8000, emp: TDS, status: 'quote_sent', age: -18 },
    { n: 1011, name: 'Gopal Krishnan', phone: '9876500011', svc: 'svc-eway', price: 3500, emp: GST, status: 'quote_sent', age: -20 },
    { n: 1012, name: 'Nithya Balan', phone: '9876500012', svc: 'svc-inc', price: 30000, emp: AM, status: 'negotiation', age: -25 },
    { n: 1013, name: 'Hari Prasad', phone: '9876500013', svc: 'svc-gst-reg', price: 5500, emp: GST, status: 'lost', age: -40, lost: 'Went with an in-house accountant.' },
    { n: 1014, name: 'Divakar Reddy', phone: '9876500014', svc: 'svc-book', price: 11000, emp: BOOK, status: 'lost', age: -50, lost: 'Quote exceeded their budget.' },
    { n: 1015, name: 'Meenakshi S', phone: '9876500015', svc: 'svc-tds', price: 6500, emp: TDS, status: 'lost', age: -60, lost: 'No response after three follow-ups.' },
    // The five converted leads — preserved, never deleted (§3).
    { n: 1016, name: 'Rahul Kumar', phone: '9876543211', svc: 'svc-gst-reg', price: 5000, emp: GST, status: 'won', age: -110, client: 'cli-1008' },
    { n: 1017, name: 'Nandhini Rao', phone: '9840099887', svc: 'svc-gst-filing', price: 18000, emp: AM, status: 'won', age: -85, client: 'cli-1009' },
    { n: 1018, name: 'Anand Subramanian', phone: '9500988776', svc: 'svc-book', price: 14000, emp: BOOK, status: 'won', age: -48, client: 'cli-1010' },
    { n: 1019, name: 'Vignesh Babu', phone: '9791877665', svc: 'svc-tds-filing', price: 9500, emp: TDS, status: 'won', age: -32, client: 'cli-1011' },
    { n: 1020, name: 'Padma Lakshmi', phone: '9445766554', svc: 'svc-gst-filing', price: 6000, emp: GST, status: 'won', age: -15, client: 'cli-1012' },
  ]

  for (const l of LEADS) {
    await prisma.lead.upsert({
      where: { id: `lead-${l.n}` },
      update: {},
      create: {
        id: `lead-${l.n}`, organisationId: orgId, leadCode: `LD-${l.n}`,
        name: l.name, contactNumber: l.phone, serviceId: l.svc,
        priceQuotedPaise: rupees(l.price), assignedEmployeeId: l.emp,
        status: l.status, lostReason: l.lost ?? null,
        convertedClientId: l.client ?? null,
        convertedAt: l.client ? at(l.age + 5, 12, 30) : null,
        notes: l.status === 'new' ? 'Enquiry received by phone.' : null,
        createdAt: at(l.age, 10, 30),
      },
    })
  }

  // ── Client services (§10) — across every status, some due, some overdue ─
  const CS = [
    ['cs-01', 'cli-1001', 'svc-gst-filing', GST, AM, 3, 'in_progress'],
    ['cs-02', 'cli-1001', 'svc-book', BOOK, AM, 12, 'in_progress'],
    ['cs-03', 'cli-1001', 'svc-tds-filing', TDS, AM, -4, 'under_review'],
    ['cs-04', 'cli-1002', 'svc-gst-filing', GST, AM, 5, 'documents_pending'],
    ['cs-05', 'cli-1002', 'svc-itr', TDS, AM, 40, 'not_started'],
    ['cs-06', 'cli-1003', 'svc-gst-filing', GST, AM, 2, 'ready'],
    ['cs-07', 'cli-1003', 'svc-eway', GST, AM, 20, 'completed'],
    ['cs-08', 'cli-1004', 'svc-book', BOOK, AM, -9, 'documents_pending'],
    ['cs-09', 'cli-1004', 'svc-gst-filing', GST, AM, 7, 'on_hold'],
    ['cs-10', 'cli-1005', 'svc-gst-filing', GST, AM, -2, 'submitted'],
    ['cs-11', 'cli-1005', 'svc-einvoice', GST, MD, 15, 'not_started'],
    ['cs-12', 'cli-1006', 'svc-tds-filing', TDS, AM, 6, 'in_progress'],
    ['cs-13', 'cli-1006', 'svc-itr', TDS, MD, 60, 'not_started'],
    ['cs-14', 'cli-1006', 'svc-book', BOOK, AM, 10, 'under_review'],
    ['cs-15', 'cli-1007', 'svc-book', BOOK, AM, -120, 'completed'],
    ['cs-16', 'cli-1008', 'svc-gst-reg', GST, AM, -80, 'completed'],
    ['cs-17', 'cli-1008', 'svc-gst-filing', GST, AM, 4, 'in_progress'],
    ['cs-18', 'cli-1009', 'svc-gst-filing', GST, AM, 1, 'under_review'],
    ['cs-19', 'cli-1009', 'svc-book', BOOK, AM, 25, 'in_progress'],
    ['cs-20', 'cli-1010', 'svc-book', BOOK, AM, 9, 'documents_pending'],
    ['cs-21', 'cli-1010', 'svc-gst-filing', GST, AM, 30, 'not_started'],
    ['cs-22', 'cli-1011', 'svc-tds-filing', TDS, AM, -1, 'documents_pending'],
    ['cs-23', 'cli-1011', 'svc-itr', TDS, MD, 45, 'not_started'],
    ['cs-24', 'cli-1012', 'svc-gst-filing', GST, AM, 6, 'in_progress'],
    ['cs-25', 'cli-1012', 'svc-gst-reg', GST, AM, -30, 'failed'],
    ['cs-26', 'cli-1003', 'svc-tds', TDS, AM, 18, 'in_progress'],
  ] as const

  for (const [id, clientId, serviceId, emp, mgr, due, status] of CS) {
    await prisma.clientService.upsert({
      where: { id },
      update: {},
      create: {
        id, clientId, serviceId,
        assignedEmployeeId: emp, managerId: mgr,
        dueDate: d(due), status,
        startedAt: status === 'not_started' ? null : at(due - 20, 11),
        completedAt: status === 'completed' ? at(due - 2, 16) : null,
        notes: status === 'failed' ? 'Rejected at the portal — re-filing required.' : null,
      },
    })
  }

  // ── Follow-ups (§10) — ONE table, leads AND clients ────────────────────
  const FU: [string, string | null, string | null, string, string, number, number, number, string, string][] = [
    // id, leadId, clientId, title, type, dayOffset, hour, minute, employee, status
    ['fu-01', null, 'cli-1001', 'GST Filing follow-up', 'call', 0, 11, 30, GST, 'pending'],
    ['fu-02', null, 'cli-1004', 'Chase pending bank statements', 'document_request', 0, 15, 0, BOOK, 'pending'],
    ['fu-03', 'lead-1004', null, 'First contact call', 'call', 0, 16, 30, GST, 'pending'],
    ['fu-04', null, 'cli-1011', 'TDS challan collection', 'whatsapp', 0, 17, 0, TDS, 'pending'],
    ['fu-05', 'lead-1010', null, 'Quote discussion', 'meeting', 1, 10, 0, TDS, 'pending'],
    ['fu-06', null, 'cli-1002', 'Confirm invoice data for the month', 'email', 2, 12, 0, GST, 'pending'],
    ['fu-07', 'lead-1012', null, 'Negotiation — revised proposal', 'meeting', 3, 14, 30, AM, 'pending'],
    ['fu-08', null, 'cli-1009', 'Review GSTR-3B before filing', 'service_followup', 4, 11, 0, AM, 'pending'],
    ['fu-09', 'lead-1011', null, 'Send e-way bill quote', 'email', 5, 9, 30, GST, 'pending'],
    ['fu-10', null, 'cli-1012', 'Onboarding kickoff', 'meeting', 6, 15, 30, GST, 'pending'],
    // Overdue
    ['fu-11', null, 'cli-1005', 'Overdue: GSTR-1 supporting data', 'document_request', -3, 11, 0, GST, 'pending'],
    ['fu-12', 'lead-1009', null, 'Overdue: requirement confirmation', 'call', -5, 10, 30, GST, 'pending'],
    ['fu-13', null, 'cli-1004', 'Overdue: bookkeeping ledger review', 'service_followup', -7, 16, 0, BOOK, 'pending'],
    ['fu-14', 'lead-1006', null, 'Overdue: incorporation documents', 'document_request', -2, 12, 30, AM, 'pending'],
    // Closed states
    ['fu-15', null, 'cli-1001', 'August GST data received', 'call', -10, 11, 0, GST, 'completed'],
    ['fu-16', 'lead-1016', null, 'Conversion confirmation call', 'call', -106, 15, 0, GST, 'completed'],
    ['fu-17', 'lead-1013', null, 'Final follow-up before closing', 'call', -42, 10, 0, GST, 'missed'],
    ['fu-18', null, 'cli-1007', 'Annual renewal discussion', 'call', -30, 14, 0, BOOK, 'cancelled'],
    ['fu-19', 'lead-1005', null, 'Rescheduled at the lead’s request', 'call', 2, 17, 30, TDS, 'rescheduled'],
    ['fu-20', null, 'cli-1006', 'TDS return walkthrough', 'meeting', 8, 11, 30, TDS, 'pending'],
  ]

  for (const [id, leadId, clientId, title, type, off, h, min, emp, status] of FU) {
    await prisma.followUp.upsert({
      where: { id },
      update: {},
      create: {
        id, organisationId: orgId, leadId, clientId,
        title, type, scheduledAt: at(off, h, min),
        assignedEmployeeId: emp, status,
        reminderMinutesBefore: 30,
        completedByEmployeeId: status === 'completed' ? emp : null,
        completedAt: status === 'completed' ? at(off, h + 1, min) : null,
        completionNotes: status === 'completed' ? 'Spoke to the client; data received.' : null,
      },
    })
  }

  // ── GST profiles + filings (§10) ───────────────────────────────────────
  const GST_CLIENTS = ['cli-1001', 'cli-1002', 'cli-1003', 'cli-1004', 'cli-1005', 'cli-1006', 'cli-1008', 'cli-1009', 'cli-1012']
  for (const clientId of GST_CLIENTS) {
    const client = CLIENTS.find((c) => c.id === clientId)!
    await prisma.gstProfile.upsert({
      where: { clientId },
      update: {},
      create: {
        id: `gstp-${clientId}`, clientId, gstin: client.gstin,
        registrationStatus: 'active', filingFrequency: 'monthly',
        registrationDate: d(client.onboard - 30),
        assignedEmployeeId: GST,
        serviceStatus: clientId === 'cli-1004' ? 'documents_pending' : 'data_preparation',
        lastFiledAt: at(-26, 12), nextDueDate: d(13),
      },
    })
    // Three periods each: two filed, the current one still open.
    const rows = [
      { p: period(2), type: 'GSTR-3B', status: 'filed', filed: -56 },
      { p: period(2), type: 'GSTR-1', status: 'filed', filed: -60 },
      { p: period(1), type: 'GSTR-3B', status: 'filed', filed: -26 },
      { p: period(1), type: 'GSTR-1', status: 'filed', filed: -30 },
      { p: period(0), type: 'GSTR-3B', status: clientId === 'cli-1004' ? 'documents_pending' : 'data_preparation', filed: null as number | null },
    ]
    for (const r of rows) {
      await prisma.gstFiling.upsert({
        where: { gstProfileId_period_returnType: { gstProfileId: `gstp-${clientId}`, period: r.p, returnType: r.type } },
        update: {},
        create: {
          gstProfileId: `gstp-${clientId}`, period: r.p, returnType: r.type,
          status: r.status, filedAt: r.filed === null ? null : at(r.filed, 12),
          dueDate: d(13), assignedEmployeeId: GST,
          arn: r.filed === null ? null : `AA33${r.p.replace('-', '')}${Math.abs(r.filed)}X`,
          remarks: r.filed === null ? 'Awaiting client data.' : 'Filed on time.',
        },
      })
    }
  }

  // ── E-way bills — SIMULATED, and flagged as such on every row ──────────
  const EWB = [
    ['cli-1003', 'EWB-100234', 'active', 145000, -2],
    ['cli-1003', 'EWB-100235', 'active', 88000, -1],
    ['cli-1003', 'EWB-100236', 'generated', 234500, 0],
    ['cli-1005', 'EWB-100237', 'active', 512000, -3],
    ['cli-1005', 'EWB-100238', 'cancelled', 67000, -6],
    ['cli-1001', 'EWB-100239', 'active', 199000, -4],
    ['cli-1001', 'EWB-100240', 'expired', 45000, -25],
    ['cli-1002', 'EWB-100241', 'active', 310000, -2],
    ['cli-1006', 'EWB-100242', 'generated', 76500, 0],
    ['cli-1008', 'EWB-100243', 'active', 128000, -5],
    ['cli-1009', 'EWB-100244', 'active', 92000, -1],
    ['cli-1012', 'EWB-100245', 'generated', 154000, 0],
  ] as const

  for (const [clientId, ewbNo, status, value, off] of EWB) {
    const client = CLIENTS.find((c) => c.id === clientId)!
    await prisma.ewayBill.upsert({
      where: { ewbNo },
      update: {},
      create: {
        id: `ewb-${ewbNo}`, clientId, ewbNo,
        documentNo: `INV-${ewbNo.slice(-4)}`, documentDate: d(off),
        fromGstin: client.gstin, toGstin: '33RECIP1234Z1Z9', toPartyName: 'Consignee Enterprises',
        valuePaise: rupees(value), status,
        generatedAt: at(off, 9, 45), validUntil: d(off + 15),
        expiresAt: at(off + 15, 23, 59),
        originalEwbNo: ewbNo,
        extensionCount: 0,
        cancelledAt: status === 'cancelled' ? at(off + 1, 10) : null,
        cancelReason: status === 'cancelled' ? 'Consignment cancelled by the buyer.' : null,
        generatedByEmployeeId: GST,
        isSimulated: true,
      },
    })
  }

  // ── E-Way Bill demo rows that FIRE the monitoring alerts ────────────────
  // Two active EWBs where the expiry lands in the next 24 hours (the
  // "expiring within 24 hours" bucket), and one whose original generation
  // is a few days shy of the 360-day extension cap (the "approaching cap"
  // bucket). All flagged isSimulated: true.
  const ALERT_EWB = [
    // ewbNo, status, valuePaise, generatedOffset, expiryOffsetHours, originalOffsetDays, extensions
    ['EWB-200001', 'active', rupees(215_000),  -14,   +18,   -14,  0], // expires in ~18h
    ['EWB-200002', 'active', rupees(48_000),   -6,    +6,    -6,   0], // expires in ~6h
    ['EWB-200003', 'active', rupees(180_000),  -8,    +72,   -352, 3], // 8 days short of 360-day cap
  ] as const
  for (const [ewbNo, status, valuePaise, genOff, expiryHours, origOff, exts] of ALERT_EWB) {
    const client = CLIENTS.find((c) => c.id === 'cli-1001')!
    await prisma.ewayBill.upsert({
      where: { ewbNo },
      update: {},
      create: {
        id: `ewb-${ewbNo}`, clientId: client.id, ewbNo,
        documentNo: `INV-${ewbNo.slice(-4)}`, documentDate: d(origOff),
        fromGstin: client.gstin, toGstin: '33RECIP9999Z1Z9', toPartyName: 'Kovai Warehouses',
        valuePaise, status,
        generatedAt: at(genOff, 10, 15),
        validUntil: d(genOff + Math.ceil(expiryHours / 24)),
        expiresAt: new Date(now.getTime() + expiryHours * 3_600_000),
        originalEwbNo: exts > 0 ? `EWB-ORIG-${ewbNo.slice(-4)}` : ewbNo,
        originalGeneratedAt: at(origOff, 10, 15),
        extensionCount: exts,
        generatedByEmployeeId: GST,
        isSimulated: true,
      },
    })
  }

  // ── E-Invoice & E-Way Bill profile (spec §1) — cli-1001 is the demo. ────
  // Kovai Textiles crosses the ₹5 Cr threshold and stays crossed. The
  // ₹10 Cr AATO in FY 2024-25 makes the 30-day reporting rule apply too.
  await prisma.eInvoiceEwbProfile.upsert({
    where: { clientId: 'cli-1001' },
    update: {},
    create: {
      clientId: 'cli-1001',
      aatoByYearJson: JSON.stringify([
        { fy: '2020-21', aatoPaise: '32000000000' },   // ₹3.2 Cr
        { fy: '2021-22', aatoPaise: '48000000000' },   // ₹4.8 Cr
        { fy: '2022-23', aatoPaise: '61000000000' },   // ₹6.1 Cr — first crossing
        { fy: '2023-24', aatoPaise: '92000000000' },   // ₹9.2 Cr
        { fy: '2024-25', aatoPaise: '184000000000' },  // ₹18.4 Cr — 30-day rule applies
      ]),
      irp: 'einvoice1',
      irpRegisteredOn: '2023-08-04',
      einvoiceApiRoute: 'gsp',
      ewbApiEnabled: true,
      ewbApiUsername: 'kovai_gsp_1',
      ewbGsp: 'ClearGSP',
      ewbVerifiedAt: d(-9),
      mfaActive: true,
      reconciledThrough: period(1),
    },
  })

  // ── IRNs — three PENDING documents inside the 30-day countdown window ──
  // and a batch of already-REPORTED IRNs so the reference counters have a
  // non-zero 'reported this month'.
  const IRN_ROWS = [
    // documentNo, offsetDays, valueRupees, status, buyerGstin
    ['INV-8811', -27, 245_000, 'pending', '33ABCDE1234F1Z1'], // 3 days left
    ['INV-8812', -26, 68_000,  'pending', '29BUYER0001Z1Z0'], // 4 days left
    ['INV-8813', -25, 132_000, 'pending', '07BUYER0002Z1Z0'], // 5 days left
    ['INV-8814', -14, 189_000, 'reported', '33ABCDE1234F1Z1'],
    ['INV-8815', -10, 47_500,  'reported', '29BUYER0001Z1Z0'],
    ['INV-8816', -8,  91_000,  'reported', '07BUYER0002Z1Z0'],
    ['INV-8817', -7,  156_000, 'reported', '33ABCDE1234F1Z1'],
    ['INV-8818', -5,  22_500,  'reported', '29BUYER0001Z1Z0'],
    ['INV-8819', -3,  310_000, 'reported', '07BUYER0002Z1Z0'],
    ['INV-8820', -2,  71_000,  'reported', '33ABCDE1234F1Z1'],
    ['INV-8821', -1,  84_500,  'reported', '29BUYER0001Z1Z0'],
    ['INV-8822', -35, 55_000,  'cancelled', '07BUYER0002Z1Z0'], // outside window, cancelled
  ] as const
  let irnSeq = 0
  for (const [docNo, off, val, status, buyerGstin] of IRN_ROWS) {
    irnSeq += 1
    const reported = status !== 'pending'
    await prisma.eInvoiceIrn.upsert({
      where: { clientId_documentNo: { clientId: 'cli-1001', documentNo: docNo } },
      update: {},
      create: {
        clientId: 'cli-1001',
        documentNo: docNo, documentDate: d(off), documentType: 'INV',
        buyerGstin, buyerName: 'B2B Buyer',
        placeOfSupply: 'TN',
        totalValuePaise: rupees(val),
        status,
        irn: reported ? `IRN-${String(3800000 + irnSeq).padStart(10, '0')}` : null,
        reportedAt: reported ? at(off + 1, 11) : null,
        cancelledAt: status === 'cancelled' ? at(off + 1, 14) : null,
        cancelReason: status === 'cancelled' ? 'Wrong tax rate applied.' : null,
        isSimulated: true,
      },
    })
  }

  // ── Pull runs — 12 monthly rows per kind, so a 7-month-old month is
  // present in our store (spec acceptance). Both 'einvoice' and 'ewb'.
  for (const kind of ['einvoice', 'ewb'] as const) {
    for (let monthsAgo = 0; monthsAgo < 12; monthsAgo += 1) {
      const periodMonth = period(monthsAgo)
      const existing = await prisma.eInvoiceEwbPullRun.findFirst({
        where: { clientId: 'cli-1001', kind, periodMonth, source: 'scheduled' },
      })
      if (existing) continue
      await prisma.eInvoiceEwbPullRun.create({
        data: {
          clientId: 'cli-1001', kind, periodMonth,
          source: 'scheduled', status: 'ok',
          recordCount: monthsAgo < 3 ? 20 + monthsAgo * 4 : 30 + monthsAgo * 2,
          notes: 'Seed pull row (simulated).',
        },
      })
    }
  }

  // ── Documents (§10) — client-centric, versioned, mixed statuses ────────
  type DocSpec = [string, string, string, string, string, number, string | null]
  const DOCS: DocSpec[] = [
    // id, clientId, categoryId, name, status, versions, uploadedByOverride
    ['doc-01', 'cli-1001', 'dc-gst', 'GSTR-3B August 2026.pdf', 'verified', 1, null],
    ['doc-02', 'cli-1001', 'dc-gst', 'GST Registration Certificate.pdf', 'verified', 1, null],
    ['doc-03', 'cli-1001', 'dc-gst', 'Sales Register FY 2026-27.xlsx', 'uploaded', 3, null],
    ['doc-04', 'cli-1001', 'dc-basic', 'PAN Card.pdf', 'verified', 1, null],
    ['doc-05', 'cli-1001', 'dc-basic', 'Certificate of Incorporation.pdf', 'verified', 1, null],
    ['doc-06', 'cli-1001', 'dc-it', 'ITR-6 AY 2026-27.pdf', 'under_review', 1, null],
    ['doc-07', 'cli-1001', 'dc-other', 'Engagement Letter.pdf', 'verified', 1, null],
    ['doc-08', 'cli-1001', 'dc-basic', 'Bank Statement — April 2026.pdf', 'requested', 0, null],
    ['doc-09', 'cli-1002', 'dc-gst', 'GSTR-1 July 2026.pdf', 'verified', 1, null],
    ['doc-10', 'cli-1002', 'dc-gst', 'Purchase Register.xlsx', 'requested', 0, null],
    ['doc-11', 'cli-1002', 'dc-basic', 'LLP Agreement.pdf', 'verified', 1, null],
    ['doc-12', 'cli-1003', 'dc-gst', 'E-way Bill Register.xlsx', 'uploaded', 1, null],
    ['doc-13', 'cli-1003', 'dc-basic', 'PAN Card.pdf', 'verified', 1, null],
    ['doc-14', 'cli-1003', 'dc-it', 'Tax Computation FY 2025-26.pdf', 'verified', 1, null],
    ['doc-15', 'cli-1004', 'dc-basic', 'Bank Statement — August 2026.pdf', 'requested', 0, null],
    ['doc-16', 'cli-1004', 'dc-basic', 'Address Proof.pdf', 'rejected', 1, null],
    ['doc-17', 'cli-1004', 'dc-gst', 'Sales Invoices August.zip', 'pending', 0, null],
    // Uploaded through the future Client Portal — the receiving path, exercised.
    ['doc-18', 'cli-1005', 'dc-gst', 'GST Supporting Documents.zip', 'uploaded', 1, 'portal'],
    ['doc-19', 'cli-1005', 'dc-gst', 'GSTR-3B July 2026.pdf', 'verified', 1, null],
    ['doc-20', 'cli-1005', 'dc-other', 'Export Licence.pdf', 'expired', 1, null],
    ['doc-21', 'cli-1006', 'dc-it', 'Form 16 Bundle.zip', 'verified', 1, null],
    ['doc-22', 'cli-1006', 'dc-it', 'TDS Challans Q1.pdf', 'uploaded', 2, null],
    ['doc-23', 'cli-1006', 'dc-basic', 'TAN Allotment Letter.pdf', 'verified', 1, null],
    ['doc-24', 'cli-1006', 'dc-other', 'Board Resolution.pdf', 'under_review', 1, null],
    ['doc-25', 'cli-1007', 'dc-basic', 'PAN Card.pdf', 'verified', 1, null],
    ['doc-26', 'cli-1007', 'dc-other', 'Closure Letter.pdf', 'verified', 1, null],
    ['doc-27', 'cli-1008', 'dc-gst', 'GST Registration Certificate.pdf', 'verified', 1, null],
    ['doc-28', 'cli-1008', 'dc-gst', 'GSTR-3B August 2026.pdf', 'under_review', 1, null],
    ['doc-29', 'cli-1008', 'dc-basic', 'Aadhaar — Proprietor.pdf', 'verified', 1, null],
    ['doc-30', 'cli-1009', 'dc-gst', 'Sales Register August.xlsx', 'uploaded', 1, null],
    ['doc-31', 'cli-1009', 'dc-basic', 'Certificate of Incorporation.pdf', 'verified', 1, null],
    ['doc-32', 'cli-1009', 'dc-other', 'Engagement Letter.pdf', 'verified', 1, null],
    ['doc-33', 'cli-1010', 'dc-basic', 'Bank Details.pdf', 'requested', 0, null],
    ['doc-34', 'cli-1010', 'dc-basic', 'PAN Card.pdf', 'uploaded', 1, null],
    ['doc-35', 'cli-1010', 'dc-other', 'Books of Account 2025-26.zip', 'pending', 0, null],
    ['doc-36', 'cli-1011', 'dc-it', 'TDS Challans Q2.pdf', 'requested', 0, null],
    ['doc-37', 'cli-1011', 'dc-basic', 'TAN Allotment Letter.pdf', 'verified', 1, null],
    ['doc-38', 'cli-1012', 'dc-gst', 'GST Registration Application.pdf', 'under_review', 1, null],
    ['doc-39', 'cli-1012', 'dc-basic', 'Partnership Deed.pdf', 'verified', 1, null],
    ['doc-40', 'cli-1012', 'dc-basic', 'Address Proof.pdf', 'requested', 0, null],
  ]

  let vSeq = 0
  for (const [id, clientId, categoryId, name, status, versions, uploader] of DOCS) {
    const requested = status === 'requested' || status === 'pending'
    await prisma.clientDocument.upsert({
      where: { id },
      update: {},
      create: {
        id, clientId, categoryId, name,
        financialYear: '2026-27', status, currentVersion: versions,
        requestedByEmployeeId: requested ? BOOK : null,
        requestedAt: requested ? at(-6, 11) : null,
        verifiedByEmployeeId: status === 'verified' ? AM : null,
        verifiedAt: status === 'verified' ? at(-14, 15) : null,
        rejectionReason: status === 'rejected' ? 'Document is illegible — please re-upload a clear scan.' : null,
        expiryDate: status === 'expired' ? d(-12) : null,
        createdAt: at(-30, 10),
      },
    })
    let previousVersionId: string | null = null
    for (let v = 1; v <= versions; v++) {
      const vid = `dv-${id}-v${v}`
      await prisma.clientDocumentVersion.upsert({
        where: { documentId_version: { documentId: id, version: v } },
        update: {},
        create: {
          id: vid, documentId: id, version: v,
          fileKey: `workstation/${clientId}/${id}/v${v}`,
          uploadedBy: uploader ?? (v === 1 ? BOOK : GST),
          uploadedAt: at(-30 + v * 4, 12),
          sizeBytes: 48_000 + (vSeq++ % 7) * 15_000,
          notes: v > 1 ? `Revision ${v} — corrected figures.` : null,
          previousVersionId,
        },
      })
      previousVersionId = vid
    }
  }

  // ── Activity timelines (§11) — reconciled with everything above ────────
  const acts: {
    subjectType: string; subjectId: string; action: string; description: string
    employeeId: string; off: number; hour: number
  }[] = []

  for (const l of LEADS) {
    acts.push({ subjectType: 'lead', subjectId: `lead-${l.n}`, action: 'lead.created', description: `Lead ${'LD-' + l.n} created for ${l.name}.`, employeeId: l.emp, off: l.age, hour: 10 })
    if (l.status !== 'new') {
      acts.push({ subjectType: 'lead', subjectId: `lead-${l.n}`, action: 'lead.contacted', description: 'Lead contacted by phone.', employeeId: l.emp, off: l.age + 1, hour: 11 })
    }
    if (l.client) {
      acts.push({ subjectType: 'lead', subjectId: `lead-${l.n}`, action: 'lead.quote_sent', description: `Quote sent — ₹${l.price.toLocaleString('en-IN')}.`, employeeId: l.emp, off: l.age + 3, hour: 12 })
      acts.push({ subjectType: 'lead', subjectId: `lead-${l.n}`, action: 'lead.converted', description: `Lead converted to client ${CLIENTS.find((c) => c.id === l.client)!.code}.`, employeeId: l.emp, off: l.age + 5, hour: 12 })
      acts.push({ subjectType: 'client', subjectId: l.client, action: 'client.created', description: `Client created from lead LD-${l.n}.`, employeeId: l.emp, off: l.age + 5, hour: 12 })
    }
    if (l.status === 'lost') {
      acts.push({ subjectType: 'lead', subjectId: `lead-${l.n}`, action: 'lead.lost', description: l.lost ?? 'Lead marked lost.', employeeId: l.emp, off: l.age + 8, hour: 16 })
    }
  }
  for (const [id, clientId, serviceId, emp] of CS) {
    const svc = SERVICES.find((s) => s.id === serviceId)!
    acts.push({ subjectType: 'client', subjectId: clientId, action: 'client.service_assigned', description: `${svc.name} assigned.`, employeeId: emp, off: -40, hour: 10 })
    void id
  }
  for (const [id, clientId, , name, status] of DOCS) {
    if (status === 'verified') {
      acts.push({ subjectType: 'client', subjectId: clientId, action: 'document.verified', description: `${name} verified.`, employeeId: AM, off: -14, hour: 15 })
    }
    void id
  }

  let i = 0
  for (const a of acts) {
    await prisma.activity.upsert({
      where: { id: `act-${i}` },
      update: {},
      create: {
        id: `act-${i}`, organisationId: orgId,
        subjectType: a.subjectType, subjectId: a.subjectId,
        action: a.action, description: a.description,
        actorUserId: null, actorEmployeeId: a.employeeId,
        createdAt: at(a.off, a.hour, 0),
      },
    })
    i++
  }

  return {
    services: await prisma.service.count(),
    leads: await prisma.lead.count(),
    clients: await prisma.client.count(),
    clientServices: await prisma.clientService.count(),
    followUps: await prisma.followUp.count(),
    documents: await prisma.clientDocument.count(),
    documentVersions: await prisma.clientDocumentVersion.count(),
    gstFilings: await prisma.gstFiling.count(),
    ewayBills: await prisma.ewayBill.count(),
    activities: await prisma.activity.count(),
  }
}
