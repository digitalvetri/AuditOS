/**
 * WORKSTATION REFERENCE SEED (AUDIT_OS_WORKSTATION.md §10): the service
 * catalog and the client-document categories. Clients, leads, filings and
 * documents are entered by the firm — none are seeded.
 */
import type { PrismaClient } from '@prisma/client'

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

  return {
    services: await prisma.service.count(),
    documentCategories: await prisma.documentCategory.count(),
  }
}
