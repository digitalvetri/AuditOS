/**
 * Readable labels for audit-log entities ("Invoice INV-000012 · Acme Ltd")
 * instead of raw ids. One query per entity TYPE on the page — never per row —
 * and deleted rows are included on purpose: history often points at records
 * that have since been removed. Types without a resolver (or ids that no
 * longer exist) simply get no label and the page falls back to the id.
 */
import { prisma } from '../lib/prisma.js'
import { USER_LABEL_SELECT, userLabel } from './userLabel.js'

type Resolver = (ids: string[]) => Promise<Array<[string, string]>>

const client = { select: { companyName: true } } as const
const withClient = (main: string, c: { companyName: string } | null | undefined) => (c ? `${main} · ${c.companyName}` : main)

/** Keyed by lower-cased entity type, since older rows were written in either case. */
const RESOLVERS: Record<string, Resolver> = {
  client: async (ids) => (await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, companyName: true } }))
    .map((r) => [r.id, r.companyName]),
  invoice: async (ids) => (await prisma.invoice.findMany({ where: { id: { in: ids } }, select: { id: true, invoiceNumber: true, client } }))
    .map((r) => [r.id, withClient(r.invoiceNumber ?? 'Draft invoice', r.client)]),
  creditnote: async (ids) => (await prisma.creditNote.findMany({ where: { id: { in: ids } }, select: { id: true, creditNoteNumber: true, invoice: { select: { client } } } }))
    .map((r) => [r.id, withClient(r.creditNoteNumber ?? 'Draft credit note', r.invoice.client)]),
  quotation: async (ids) => (await prisma.quotation.findMany({ where: { id: { in: ids } }, select: { id: true, quotationCode: true, subject: true } }))
    .map((r) => [r.id, `${r.quotationCode} · ${r.subject}`]),
  engagementletter: async (ids) => (await prisma.engagementLetter.findMany({ where: { id: { in: ids } }, select: { id: true, letterCode: true, subject: true } }))
    .map((r) => [r.id, `${r.letterCode} · ${r.subject}`]),
  employee: async (ids) => (await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } }))
    .map((r) => [r.id, r.fullName]),
  user: async (ids) => (await prisma.user.findMany({ where: { id: { in: ids } }, select: USER_LABEL_SELECT }))
    .map((r) => [r.id, userLabel(r)]),
  task: async (ids) => (await prisma.task.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } }))
    .map((r) => [r.id, r.title]),
  lead: async (ids) => (await prisma.lead.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }))
    .map((r) => [r.id, r.name]),
  complianceitem: async (ids) => {
    // No relation to Client on this model: one more batched lookup for the names.
    const items = await prisma.complianceItem.findMany({ where: { id: { in: ids } }, select: { id: true, formCode: true, periodLabel: true, clientId: true } })
    const clients = await prisma.client.findMany({ where: { id: { in: [...new Set(items.map((i) => i.clientId))] } }, select: { id: true, companyName: true } })
    const name = new Map(clients.map((c) => [c.id, c]))
    return items.map((r) => [r.id, withClient(`${r.formCode} ${r.periodLabel}`, name.get(r.clientId))])
  },
  auditengagement: async (ids) => (await prisma.auditEngagement.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } }))
    .map((r) => [r.id, r.title]),
  digitalsignature: async (ids) => (await prisma.digitalSignature.findMany({ where: { id: { in: ids } }, select: { id: true, holderName: true } }))
    .map((r) => [r.id, `DSC · ${r.holderName}`]),
  recurringinvoiceprofile: async (ids) => (await prisma.recurringInvoiceProfile.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }))
    .map((r) => [r.id, r.name]),
  auditudin: async (ids) => (await prisma.auditUdin.findMany({ where: { id: { in: ids } }, select: { id: true, udin: true } }))
    .map((r) => [r.id, `UDIN ${r.udin}`]),
}

/** `${entityType}:${entityId}` → label, for the rows given. */
export async function auditEntityLabels(rows: Array<{ entityType: string; entityId: string | null }>): Promise<Map<string, string>> {
  const byType = new Map<string, Set<string>>()
  for (const r of rows) {
    const key = r.entityType.toLowerCase()
    if (!r.entityId || !RESOLVERS[key]) continue
    if (!byType.has(key)) byType.set(key, new Set())
    byType.get(key)!.add(r.entityId)
  }
  const out = new Map<string, string>()
  await Promise.all([...byType].map(async ([type, ids]) => {
    try {
      for (const [id, label] of await RESOLVERS[type]([...ids])) out.set(`${type}:${id}`, label)
    } catch { /* a label is a nicety — never fail the log over it */ }
  }))
  return out
}

export function entityLabelFor(labels: Map<string, string>, entityType: string, entityId: string | null): string | null {
  return entityId ? (labels.get(`${entityType.toLowerCase()}:${entityId}`) ?? null) : null
}
