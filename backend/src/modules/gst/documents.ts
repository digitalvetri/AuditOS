/**
 * GST documents — upload / list / download for the handful of statutory
 * papers that a GST registration cycle produces (REG-06 certificate, CMP-02
 * for the composition opt-in, amendment certificates, notices).
 *
 * This file reuses the ClientDocument + ClientDocumentVersion engine built
 * in `workstation/client-folders.routes.ts` so GST docs show up on the
 * client's main document list and audit trail. We ADD two things on top:
 *
 *   1. A category convention — every GST doc is filed under
 *      `DocumentCategory.code = 'gst_registration'`, auto-created per
 *      organisation on first upload. Keeps the client's filing cabinet
 *      tidy without needing a per-org admin UI.
 *   2. A doc-type tag inside the display name so the UI can group /
 *      filter without a schema migration — the name is prefixed with
 *      `[REG-06] Certificate` etc. We don't invent a new column; it's
 *      honest about which papers are which.
 *
 * On a registration-certificate upload we create a reminder Task for the
 * account manager with dueDate = upload + 30 days, matching the statutory
 * display-at-premises window. The user can tick it off when confirmed,
 * same as any other task.
 *
 * Drafts live here too: a lightweight template renderer that produces a
 * client welcome letter from the client's record (name, GSTIN, address,
 * registration date). No PDF — plain text so the operator can paste it
 * into the Send modal we already built or copy to Word.
 */
import crypto from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { ApiError } from '../../lib/http.js'
import {
  CLIENT_DOC_MIME, clientDocumentStorage, readVersionBytes,
} from '../workstation/client-folders.routes.js'

export const GST_DOC_CATEGORY_CODE = 'gst_registration'
const GST_DOC_CATEGORY_NAME = 'GST — registration & correspondence'

/** The sub-types the UI exposes. Each one steers the display-name prefix
 *  and (for `registration_cert`) the 30-day display reminder. */
export const GST_DOC_TYPES = [
  'registration_cert',
  'composition_optin',
  'amendment_cert',
  'notice_order',
  'other',
] as const
export type GstDocType = (typeof GST_DOC_TYPES)[number]
export function isGstDocType(v: unknown): v is GstDocType {
  return typeof v === 'string' && (GST_DOC_TYPES as readonly string[]).includes(v)
}

const TYPE_LABEL: Record<GstDocType, string> = {
  registration_cert: 'REG-06',
  composition_optin: 'CMP-02',
  amendment_cert:    'Amendment',
  notice_order:      'Notice',
  other:             'Other',
}

/** Ensure the GST documents category exists for this org and return its id. */
async function ensureCategory(prisma: PrismaClient, organisationId: string): Promise<string> {
  const cat = await prisma.documentCategory.upsert({
    where: { code: GST_DOC_CATEGORY_CODE },
    update: {},
    create: {
      organisationId,
      code: GST_DOC_CATEGORY_CODE,
      name: GST_DOC_CATEGORY_NAME,
      description: 'GST registration certificates, amendment orders, portal notices and related correspondence.',
      sortOrder: 50,
    },
    select: { id: true },
  })
  return cat.id
}

export interface UploadGstDocInput {
  clientId: string
  docType: GstDocType
  file: {
    buffer: Buffer
    originalname: string
    size: number
  }
  /** Operator-entered label; the type prefix is added automatically. */
  label?: string | null
  /** ARN or reference recorded alongside — searchable in the name. */
  reference?: string | null
}
export interface UploadGstDocResult {
  documentId: string
  name: string
  version: number
  size: number
  thirtyDayTaskId: string | null
}

export async function uploadGstDocument(
  prisma: PrismaClient,
  input: UploadGstDocInput,
  session: { userId: string; employeeId: string | null },
): Promise<UploadGstDocResult> {
  const client = await prisma.client.findFirst({
    where: { id: input.clientId, deletedAt: null },
    select: { id: true, organisationId: true, accountManagerId: true, companyName: true },
  })
  if (!client) throw ApiError.notFound('Client not found.')

  const ext = (input.file.originalname.split('.').pop() ?? '').toLowerCase()
  const mimeType = CLIENT_DOC_MIME[ext]
  if (!mimeType) {
    throw ApiError.unprocessable('file_type', `Allowed types: ${Object.keys(CLIENT_DOC_MIME).join(', ').toUpperCase()}.`)
  }

  const categoryId = await ensureCategory(prisma, client.organisationId)

  // Name is operator label if given, else "[REG-06] Original filename".
  // The prefix makes list grouping cheap in the UI.
  const prefix = `[${TYPE_LABEL[input.docType]}]`
  const baseName = (input.label ?? '').trim() || input.file.originalname
  const refSuffix = input.reference?.trim() ? ` · ${input.reference.trim()}` : ''
  const name = `${prefix} ${baseName}${refSuffix}`.slice(0, 200)

  const docId = crypto.randomUUID()
  const safe = input.file.originalname.replace(/[^A-Za-z0-9._-]/g, '_').slice(-120)
  const key = `${input.clientId}/${docId}/${crypto.randomUUID()}-${safe}`
  await clientDocumentStorage.put(key, input.file.buffer)

  await prisma.$transaction([
    prisma.clientDocument.create({
      data: {
        id: docId,
        clientId: input.clientId,
        categoryId,
        name,
        status: 'uploaded',
        currentVersion: 1,
        createdBy: session.userId,
      },
    }),
    prisma.clientDocumentVersion.create({
      data: {
        documentId: docId,
        version: 1,
        fileKey: key,
        originalName: input.file.originalname,
        mimeType,
        sizeBytes: input.file.size,
        uploadedBy: session.employeeId ?? session.userId,
        reviewStatus: 'uploaded',
      },
    }),
  ])

  // REG-06 upload → 30-day display-at-premises reminder for the account
  // manager. Idempotent against a prior cert for the same client, so a
  // re-upload (new ARN, amendment, etc.) only ever leaves one open task.
  let thirtyDayTaskId: string | null = null
  if (input.docType === 'registration_cert' && client.accountManagerId) {
    const existing = await prisma.task.findFirst({
      where: {
        clientId: input.clientId,
        title: { startsWith: 'Confirm GST certificate displayed' },
        status: { in: ['open', 'pending', 'in_progress', 'paused'] },
      },
      select: { id: true },
    })
    if (!existing) {
      const dueDate = new Date()
      dueDate.setUTCDate(dueDate.getUTCDate() + 30)
      const task = await prisma.task.create({
        data: {
          clientId: input.clientId,
          title: `Confirm GST certificate displayed at ${client.companyName}'s premises`,
          description:
            'Statutory: the GST registration certificate (Form REG-06) must be prominently displayed at the client\'s principal place of business within 30 days of registration. ' +
            'Confirm with the client and mark this task done, or follow up if not yet done.',
          assignedEmployeeId: client.accountManagerId,
          assignedById: session.employeeId ?? session.userId,
          dueDate: dueDate.toISOString().slice(0, 10),
          priority: 'medium',
          status: 'open',
        },
        select: { id: true },
      })
      thirtyDayTaskId = task.id
    } else {
      thirtyDayTaskId = existing.id
    }
  }

  return { documentId: docId, name, version: 1, size: input.file.size, thirtyDayTaskId }
}

export interface GstDocListRow {
  id: string
  name: string
  doc_type: GstDocType
  status: string
  version: number
  size_bytes: number
  mime_type: string
  original_name: string
  uploaded_at: string
}

/** List every GST doc for a client, newest first, decoded for the UI. */
export async function listGstDocuments(prisma: PrismaClient, clientId: string): Promise<GstDocListRow[]> {
  const cat = await prisma.documentCategory.findFirst({ where: { code: GST_DOC_CATEGORY_CODE } })
  if (!cat) return []
  const docs = await prisma.clientDocument.findMany({
    where: { clientId, categoryId: cat.id, deletedAt: null },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    orderBy: { createdAt: 'desc' },
  })
  return docs.map((d) => {
    const v = d.versions[0]
    // The name was written as "[REG-06] …" — parse the prefix back out.
    const match = /^\[([^\]]+)\]/.exec(d.name)
    const label = match?.[1]
    const docType: GstDocType =
      label === 'REG-06' ? 'registration_cert'
      : label === 'CMP-02' ? 'composition_optin'
      : label === 'Amendment' ? 'amendment_cert'
      : label === 'Notice' ? 'notice_order'
      : 'other'
    return {
      id: d.id,
      name: d.name,
      doc_type: docType,
      status: d.status,
      version: d.currentVersion,
      size_bytes: v?.sizeBytes ?? 0,
      mime_type: v?.mimeType ?? 'application/octet-stream',
      original_name: v?.originalName ?? d.name,
      uploaded_at: (v?.uploadedAt ?? d.createdAt).toISOString(),
    }
  })
}

/** Fetch the latest version's bytes for inline / attachment download. */
export async function readGstDocumentBytes(
  prisma: PrismaClient,
  clientId: string,
  documentId: string,
): Promise<{ bytes: Buffer; mimeType: string; name: string } | null> {
  const cat = await prisma.documentCategory.findFirst({ where: { code: GST_DOC_CATEGORY_CODE } })
  if (!cat) return null
  const doc = await prisma.clientDocument.findFirst({
    where: { id: documentId, clientId, categoryId: cat.id, deletedAt: null },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  })
  if (!doc) return null
  const v = doc.versions[0]
  if (!v) return null
  const bytes = await readVersionBytes(v.fileKey)
  if (!bytes) return null
  return { bytes, mimeType: v.mimeType ?? 'application/octet-stream', name: v.originalName ?? doc.name }
}

// ── Drafts ──────────────────────────────────────────────────────────────

const DRAFT_TEMPLATES = ['welcome_letter'] as const
export type DraftTemplate = (typeof DRAFT_TEMPLATES)[number]
export function isDraftTemplate(v: unknown): v is DraftTemplate {
  return typeof v === 'string' && (DRAFT_TEMPLATES as readonly string[]).includes(v)
}

export interface DraftInput {
  clientId: string
  template: DraftTemplate
}

export interface DraftResult {
  template: DraftTemplate
  subject: string
  body: string
  recipient_email: string | null
  variables: Record<string, string>
}

/** Render a draft from a template + the client's record. Pure derivation,
 *  no side effects — the UI shows the result in a modal where the
 *  operator can edit before Download or Send. */
export async function renderDraft(prisma: PrismaClient, input: DraftInput): Promise<DraftResult> {
  const client = await prisma.client.findFirst({
    where: { id: input.clientId, deletedAt: null },
    select: { id: true, companyName: true, legalName: true, email: true, organisationId: true },
  })
  if (!client) throw ApiError.notFound('Client not found.')

  const gst = await prisma.gstProfile.findFirst({
    where: { clientId: input.clientId, deletedAt: null },
    select: { gstin: true, registrationDate: true, legalName: true, state: true },
  })

  const org = await prisma.organisation.findFirst({
    where: { id: client.organisationId },
    select: { name: true },
  })

  const now = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' })
  const vars: Record<string, string> = {
    client_name: client.companyName,
    legal_name: gst?.legalName ?? client.legalName ?? client.companyName,
    gstin: gst?.gstin ?? '—',
    state: gst?.state ?? '',
    registration_date: gst?.registrationDate ?? '',
    firm_name: org?.name ?? 'the firm',
    today: now,
  }

  if (input.template === 'welcome_letter') {
    const subject = `GST registration confirmed — ${vars.client_name} (GSTIN ${vars.gstin})`
    const body = [
      `${vars.today}`,
      '',
      `Dear ${vars.client_name},`,
      '',
      `Congratulations — your GST registration is now active.`,
      '',
      `  GSTIN                : ${vars.gstin}`,
      vars.legal_name && vars.legal_name !== vars.client_name ? `  Legal name           : ${vars.legal_name}` : null,
      vars.state ? `  State of registration: ${vars.state}` : null,
      vars.registration_date ? `  Date of registration : ${vars.registration_date}` : null,
      '',
      'Three things to do within the next 30 days:',
      '',
      '  1. Display the GST Registration Certificate (Form REG-06) prominently at your principal place of business.',
      '  2. Mention the GSTIN on all tax invoices, bills of supply, and official letterheads.',
      '  3. Set up your invoicing to apply the right CGST / SGST / IGST based on the place of supply.',
      '',
      'Your first GSTR-1 will typically be due by the 11th of the next month and GSTR-3B by the 20th. We\'ll send a reminder a few days before each.',
      '',
      'If you have any questions on invoicing, place-of-supply, or how to issue a credit note, please reach out.',
      '',
      'Best regards,',
      vars.firm_name,
    ].filter((l): l is string => l !== null).join('\n')
    const emailRow = await prisma.client.findFirst({ where: { id: input.clientId }, select: { email: true } })
    return {
      template: input.template,
      subject,
      body,
      recipient_email: emailRow?.email ?? null,
      variables: vars,
    }
  }

  // Should be unreachable while DRAFT_TEMPLATES has one entry.
  throw ApiError.badRequest(`Unknown draft template: ${input.template}`)
}
