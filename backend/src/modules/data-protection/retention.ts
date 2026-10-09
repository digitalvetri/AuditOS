/**
 * DATA RETENTION + DPDP (Digital Personal Data Protection Act 2023).
 *
 * A former client (status `inactive` with an `exitDate`) whose
 * exitDate + Organisation.dataRetentionYears has passed is "due for
 * deletion". Nothing here runs on a timer: the purge is an explicit Admin
 * action with a typed confirmation (the client code), and every step writes
 * an audit row.
 *
 * What a purge removes (the plan below — the preview and the purge share it,
 * so they can never disagree):
 *   - the client's documents (versions + files; the document rows are
 *     soft-deleted because bookkeeping / registration records link to them)
 *   - GST notices and the notices register (rows + files)
 *   - audit files (engagement, team, working papers + files, review notes,
 *     risks, observations, checklists, UDIN register rows)
 *   - portal / registration credentials, document share links, contacts
 *   - contact details on the client master (person, phone, email, address, notes)
 *
 * What it never touches: invoices, payments and credit notes are statutory
 * records (CGST Act s.36, Income-tax Act s.44AA) and are RETAINED, as is the
 * client master row they point at (soft-deleted, name and GSTIN kept for the
 * invoices). The audit log is never edited — it is append-only and chained.
 */
import path from 'node:path'
import JSZip from 'jszip'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import { istToday } from '../../lib/dates.js'
import { bigintReplacer } from '../../lib/json.js'
import { clientDocumentStorage } from '../workstation/client-folders.routes.js'
import { auditStorage } from '../audit/service.js'
import { LocalStorageAdapter } from '../tools/storage/LocalStorageAdapter.js'
import type { StorageAdapter } from '../tools/storage/StorageAdapter.js'

/** SQC 1 / SA 230: audit documentation is kept at least 7 years. */
export const MIN_RETENTION_YEARS = 7

// Same roots as notices/routes.ts (GST notices) and notices-register/routes.ts.
const gstNoticeStorage = (): StorageAdapter => new LocalStorageAdapter(process.env.GST_NOTICE_STORAGE_ROOT
  ? path.resolve(process.env.GST_NOTICE_STORAGE_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'gst-notices'))
const clientNoticeStorage = (): StorageAdapter => new LocalStorageAdapter(process.env.CLIENT_NOTICE_STORAGE_ROOT
  ? path.resolve(process.env.CLIENT_NOTICE_STORAGE_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'client-notices'))

/** 'YYYY-MM-DD' + whole years (29 Feb → 28 Feb in a non-leap year). */
export function retentionEndDate(exitDate: string, years: number): string {
  const [y, m, d] = exitDate.split('-').map(Number)
  const ty = y + years
  const leap = (ty % 4 === 0 && ty % 100 !== 0) || ty % 400 === 0
  const day = m === 2 && d === 29 && !leap ? 28 : d
  return `${ty}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export async function orgRetentionYears(organisationId: string): Promise<number> {
  const org = await prisma.organisation.findUnique({ where: { id: organisationId }, select: { dataRetentionYears: true } })
  return Math.max(MIN_RETENTION_YEARS, org?.dataRetentionYears ?? 8)
}

export interface FileRef { store: 'client_documents' | 'gst_notices' | 'client_notices' | 'audit_files'; key: string; name: string }

export interface PurgePlan {
  client_id: string
  client_code: string
  company_name: string
  exit_date: string | null
  retention_years: number
  retention_ends: string | null
  due: boolean
  /** What a purge would remove. */
  remove: {
    documents: number
    files: number
    audit_files: number
    gst_notices: number
    client_notices: number
    contacts: number
    credentials: number
    share_links: number
  }
  /** Statutory records that stay, whatever the retention period says. */
  retained: { invoices: number; payments: number; credit_notes: number }
}

async function fileRefs(clientId: string): Promise<FileRef[]> {
  const [versions, gstNotices, clientNotices, wpFiles] = await Promise.all([
    prisma.clientDocumentVersion.findMany({ where: { document: { clientId } }, select: { fileKey: true, originalName: true } }),
    prisma.gstNotice.findMany({ where: { clientId, uploadedFileKey: { not: null } }, select: { uploadedFileKey: true, uploadedFileName: true } }),
    prisma.clientNotice.findMany({ where: { clientId, fileKey: { not: null } }, select: { fileKey: true, fileName: true } }),
    prisma.auditWorkingPaperFile.findMany({ where: { workingPaper: { engagement: { clientId } } }, select: { fileKey: true, originalName: true } }),
  ])
  return [
    ...versions.filter((v) => v.fileKey).map((v) => ({ store: 'client_documents' as const, key: v.fileKey, name: v.originalName ?? v.fileKey })),
    ...gstNotices.map((n) => ({ store: 'gst_notices' as const, key: n.uploadedFileKey!, name: n.uploadedFileName ?? n.uploadedFileKey! })),
    ...clientNotices.map((n) => ({ store: 'client_notices' as const, key: n.fileKey!, name: n.fileName ?? n.fileKey! })),
    ...wpFiles.map((f) => ({ store: 'audit_files' as const, key: f.fileKey, name: f.originalName ?? f.fileKey })),
  ]
}

function storageFor(store: FileRef['store']): StorageAdapter {
  switch (store) {
    case 'client_documents': return clientDocumentStorage
    case 'gst_notices': return gstNoticeStorage()
    case 'client_notices': return clientNoticeStorage()
    case 'audit_files': return auditStorage
  }
}

type ClientRow = { id: string; clientCode: string; companyName: string; status: string; exitDate: string | null; organisationId: string }

export async function buildPurgePlan(client: ClientRow, retentionYears: number, today = istToday()): Promise<PurgePlan> {
  const id = client.id
  const [documents, files, auditFiles, gstNotices, clientNotices, contacts, regCreds, tdsCreds, shareLinks, invoices, payments, creditNotes] = await Promise.all([
    prisma.clientDocument.count({ where: { clientId: id, ...alive } }),
    fileRefs(id).then((f) => f.length),
    prisma.auditEngagement.count({ where: { clientId: id } }),
    prisma.gstNotice.count({ where: { clientId: id } }),
    prisma.clientNotice.count({ where: { clientId: id } }),
    prisma.clientContact.count({ where: { clientId: id } }),
    prisma.registrationCredential.count({ where: { clientId: id } }),
    prisma.tdsPortalCredential.count({ where: { clientId: id } }),
    prisma.clientDocumentShareLink.count({ where: { clientId: id } }),
    prisma.invoice.count({ where: { clientId: id } }),
    prisma.invoicePayment.count({ where: { clientId: id } }),
    prisma.creditNote.count({ where: { clientId: id } }),
  ])
  const ends = client.exitDate ? retentionEndDate(client.exitDate, retentionYears) : null
  return {
    client_id: id,
    client_code: client.clientCode,
    company_name: client.companyName,
    exit_date: client.exitDate,
    retention_years: retentionYears,
    retention_ends: ends,
    due: client.status === 'inactive' && !!ends && ends <= today,
    remove: {
      documents, files, audit_files: auditFiles, gst_notices: gstNotices, client_notices: clientNotices,
      contacts, credentials: regCreds + tdsCreds, share_links: shareLinks,
    },
    retained: { invoices, payments, credit_notes: creditNotes },
  }
}

const CLIENT_SELECT = { id: true, clientCode: true, companyName: true, status: true, exitDate: true, organisationId: true } as const

/** Former clients of the firm whose retention period has ended. */
export async function recordsDueForDeletion(organisationId: string, today = istToday()): Promise<PurgePlan[]> {
  const years = await orgRetentionYears(organisationId)
  const candidates = await prisma.client.findMany({
    where: { organisationId, ...alive, status: 'inactive', exitDate: { not: null } },
    select: CLIENT_SELECT,
    orderBy: { exitDate: 'asc' },
  })
  const due = candidates.filter((c) => retentionEndDate(c.exitDate!, years) <= today)
  return Promise.all(due.map((c) => buildPurgePlan(c, years, today)))
}

export interface PurgeResult {
  plan: PurgePlan
  files_removed: number
  files_failed: { store: string; key: string }[]
}

/**
 * Remove a former client's records. Re-checks eligibility on the server;
 * `confirm` must equal the client code. DB rows go first in one
 * transaction, then the files (best effort — a file that will not delete is
 * reported, never silently kept).
 */
export async function purgeClientRecords(args: {
  organisationId: string
  clientId: string
  confirm: string
  actorUserId: string
  today?: string
}): Promise<PurgeResult> {
  const today = args.today ?? istToday()
  const client = await prisma.client.findFirst({ where: { id: args.clientId, organisationId: args.organisationId, ...alive }, select: CLIENT_SELECT })
  if (!client) throw ApiError.notFound('Client not found.')
  const years = await orgRetentionYears(args.organisationId)
  const plan = await buildPurgePlan(client, years, today)
  if (!plan.due) {
    throw ApiError.conflict('not_due', plan.retention_ends
      ? `This client's records must be kept until ${plan.retention_ends}.`
      : 'Only an inactive client with an exit date can be purged.')
  }
  if (args.confirm.trim() !== client.clientCode) {
    throw ApiError.badRequest(`Type the client code (${client.clientCode}) to confirm.`)
  }

  const files = await fileRefs(client.id)
  const id = client.id
  const now = new Date()
  await prisma.$transaction(async (tx) => {
    // Audit files, children first.
    const engagementIds = (await tx.auditEngagement.findMany({ where: { clientId: id }, select: { id: true } })).map((e) => e.id)
    if (engagementIds.length) {
      const wpIds = (await tx.auditWorkingPaper.findMany({ where: { engagementId: { in: engagementIds } }, select: { id: true } })).map((w) => w.id)
      await tx.auditReviewNote.deleteMany({ where: { engagementId: { in: engagementIds } } })
      await tx.auditWorkingPaperFile.deleteMany({ where: { workingPaperId: { in: wpIds } } })
      await tx.auditWorkingPaper.deleteMany({ where: { id: { in: wpIds } } })
      await tx.auditTeamMember.deleteMany({ where: { engagementId: { in: engagementIds } } })
      await tx.auditRisk.deleteMany({ where: { engagementId: { in: engagementIds } } })
      await tx.auditObservation.deleteMany({ where: { engagementId: { in: engagementIds } } })
      await tx.auditChecklistResponse.deleteMany({ where: { engagementId: { in: engagementIds } } })
      await tx.auditUdin.deleteMany({ where: { OR: [{ engagementId: { in: engagementIds } }, { clientId: id }] } })
      // Tasks keep their history; only the dangling link goes (no FK).
      await tx.task.updateMany({ where: { auditEngagementId: { in: engagementIds } }, data: { auditEngagementId: null } })
      await tx.auditEngagement.deleteMany({ where: { id: { in: engagementIds } } })
    } else {
      await tx.auditUdin.deleteMany({ where: { clientId: id } })
    }
    // Documents: the bytes and their version rows go; the document rows are
    // soft-deleted (bookkeeping / registration records still link to them).
    await tx.clientDocumentVersion.deleteMany({ where: { document: { clientId: id } } })
    await tx.clientDocument.updateMany({ where: { clientId: id, ...alive }, data: { deletedAt: now, updatedBy: args.actorUserId } })
    await tx.clientDocumentShareLink.deleteMany({ where: { clientId: id } })
    await tx.gstNotice.deleteMany({ where: { clientId: id } })
    await tx.clientNotice.deleteMany({ where: { clientId: id } })
    await tx.registrationCredential.deleteMany({ where: { clientId: id } })
    await tx.tdsPortalCredential.deleteMany({ where: { clientId: id } })
    const contactIds = (await tx.clientContact.findMany({ where: { clientId: id }, select: { id: true } })).map((c) => c.id)
    if (contactIds.length) {
      await tx.incorporationParty.updateMany({ where: { clientContactId: { in: contactIds } }, data: { clientContactId: null } })
      await tx.clientContact.deleteMany({ where: { id: { in: contactIds } } })
    }
    // The master row stays for the retained invoices: name and GSTIN are on
    // those invoices anyway; personal contact details go.
    await tx.client.update({
      where: { id },
      data: {
        contactPerson: '(removed)', contactNumber: '', email: null, address: null, notes: null,
        portalEnabled: false, portalInviteEmail: null,
        deletedAt: now, purgedAt: now, updatedBy: args.actorUserId,
      },
    })
  }, { maxWait: 15_000, timeout: 120_000 })

  let removed = 0
  const failed: { store: string; key: string }[] = []
  for (const f of files) {
    try {
      await storageFor(f.store).delete(f.key)
      removed++
    } catch {
      failed.push({ store: f.store, key: f.key })
    }
  }
  return { plan, files_removed: removed, files_failed: failed }
}

// ── DPDP export ───────────────────────────────────────────────────────────

const json = (v: unknown) => JSON.stringify(v, bigintReplacer, 2)
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(-120) || 'file'

/**
 * Everything the firm holds about one client, as JSON plus the uploaded
 * files, for a DPDP access request. Credential secrets are never included
 * (only that a credential exists). A file missing on disk is listed in
 * manifest.json rather than failing the export.
 */
export async function exportClientData(organisationId: string, clientId: string): Promise<{ zip: Buffer; client: { id: string; clientCode: string; companyName: string }; files: number; missing: number }> {
  const client = await prisma.client.findFirst({ where: { id: clientId, organisationId } })
  if (!client) throw ApiError.notFound('Client not found.')
  const id = client.id
  const [contacts, services, documents, gstNotices, clientNotices, invoices, payments, creditNotes, tasks, audits, udins, regCreds, tdsCreds, gstProfile] = await Promise.all([
    prisma.clientContact.findMany({ where: { clientId: id } }),
    prisma.clientService.findMany({ where: { clientId: id } }),
    prisma.clientDocument.findMany({ where: { clientId: id }, include: { versions: true, category: { select: { code: true, name: true } } } }),
    prisma.gstNotice.findMany({ where: { clientId: id } }),
    prisma.clientNotice.findMany({ where: { clientId: id } }),
    prisma.invoice.findMany({ where: { clientId: id } }),
    prisma.invoicePayment.findMany({ where: { clientId: id } }),
    prisma.creditNote.findMany({ where: { clientId: id } }),
    prisma.task.findMany({ where: { clientId: id } }),
    prisma.auditEngagement.findMany({ where: { clientId: id }, include: { workingPapers: { include: { files: true } }, observations: true, udins: true } }),
    prisma.auditUdin.findMany({ where: { clientId: id } }),
    prisma.registrationCredential.findMany({ where: { clientId: id } }),
    prisma.tdsPortalCredential.findMany({ where: { clientId: id } }),
    prisma.gstProfile.findFirst({ where: { clientId: id } }),
  ])
  // Secrets stay out of the export: keep only non-secret descriptive fields.
  const stripSecrets = (row: Record<string, unknown>) => Object.fromEntries(
    Object.entries(row).filter(([k]) => !/cipher|secret|password|token|otp|iv$|tag$|nonce/i.test(k)),
  )

  const zip = new JSZip()
  zip.file('client.json', json(client))
  zip.file('contacts.json', json(contacts))
  zip.file('services.json', json(services))
  zip.file('gst-profile.json', json(gstProfile ? stripSecrets(gstProfile as unknown as Record<string, unknown>) : null))
  zip.file('documents.json', json(documents))
  zip.file('gst-notices.json', json(gstNotices))
  zip.file('notices-register.json', json(clientNotices))
  zip.file('invoices.json', json(invoices))
  zip.file('payments.json', json(payments))
  zip.file('credit-notes.json', json(creditNotes))
  zip.file('tasks.json', json(tasks))
  zip.file('audit-files.json', json(audits))
  zip.file('udins.json', json(udins))
  zip.file('credentials.json', json([
    ...regCreds.map((r) => ({ kind: 'registration', ...stripSecrets(r as unknown as Record<string, unknown>) })),
    ...tdsCreds.map((r) => ({ kind: 'tds_portal', ...stripSecrets(r as unknown as Record<string, unknown>) })),
  ]))

  const refs = await fileRefs(id)
  const manifest: { store: string; key: string; name: string; path: string | null; missing?: true }[] = []
  let n = 0
  let missing = 0
  for (const f of refs) {
    try {
      const bytes = await storageFor(f.store).get(f.key)
      const p = `files/${f.store}/${String(++n).padStart(4, '0')}-${safeName(f.name)}`
      zip.file(p, bytes)
      manifest.push({ ...f, path: p })
    } catch {
      missing++
      manifest.push({ ...f, path: null, missing: true })
    }
  }
  zip.file('manifest.json', json({
    exported_at: new Date().toISOString(),
    client: { id: client.id, code: client.clientCode, name: client.companyName },
    note: 'Export for a DPDP Act 2023 access request. Credential secrets are not included.',
    files: manifest,
  }))
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return { zip: buf, client: { id: client.id, clientCode: client.clientCode, companyName: client.companyName }, files: n, missing }
}
