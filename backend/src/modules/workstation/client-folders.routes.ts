import crypto from 'node:crypto'
import path from 'node:path'
import { Router } from 'express'
import multer from 'multer'
import { writeAudit } from '../../platform/audit.js'
import { writeActivity } from '../../platform/workstation/activity.js'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import type { PermissionCode } from '../../platform/rbac/matrix.js'
import { signedLink, verifyResourceToken } from '../../platform/signedUrl.js'
import { assertCanSeeClient, requireWorkstation, workstationScope } from '../../platform/workstation/scope.js'
import { LocalStorageAdapter } from '../tools/storage/LocalStorageAdapter.js'
import type { StorageAdapter } from '../tools/storage/StorageAdapter.js'
import { aaStorage } from '../audit-automation/storage.js'
import { bookkeepingImportStorage } from './bookkeepingImportStorage.js'
import { partnershipStorage } from '../partnership/storage.js'
import { streamEInvoicePdf, streamEwayBillPdf, streamGstFilingPdf } from './record-pdf.js'

/**
 * CLIENT DOCUMENT FOLDERS — every document the firm holds for one client,
 * grouped into folders (E-Way Bills, E-Invoices, Invoices, GST returns,
 * uploaded files by category, imported source files…).
 *
 * The documents themselves live in their own modules; this router only reads
 * them. Each item says how it opens:
 *   - 'pdf' / 'file' → GET …/document-folders/open mints a signed link
 *   - 'record'       → the item carries its fields; the UI shows them
 *   - 'missing'      → a version was recorded but its file was never uploaded
 *   - 'none'         → requested but nothing uploaded yet
 *
 * A folder only appears when the caller holds that module's read permission,
 * so this view never widens what someone could already see elsewhere.
 */
export const clientFoldersRouter = Router()

type Openable = 'pdf' | 'file' | 'record' | 'missing' | 'none'

interface FolderItem {
  id: string
  source: string
  title: string
  subtitle: string | null
  date: string | null
  status: string | null
  amount_paise: number | null
  openable: Openable
  file_name: string | null
  mime_type: string | null
  fields: [string, string][] | null
  /** Uploaded files only: the ClientDocument, for version/verify actions. */
  document_id: string | null
  /** Uploaded files only: the employee who uploaded the shown version. */
  uploaded_by_id?: string | null
  /** An organization's request that was received for one of its clients:
   *  the file lives with that client, not here. */
  stored_for?: { client_id: string; client_name: string; document_id: string } | null
}

export interface Folder {
  key: string
  label: string
  group: 'compliance' | 'billing' | 'uploads' | 'imports'
  items: FolderItem[]
}

/**
 * Folders built from other modules' records also take uploaded files (a
 * scanned e-way bill, a signed engagement letter…). Each gets its own
 * document category so the upload lands back in the same folder.
 */
const FOLDER_UPLOAD_CATEGORY: Record<string, string> = {
  eway: 'E-Way Bills',
  einvoice: 'E-Invoices',
  gst_returns: 'GST Returns',
  invoices: 'Invoices',
  quotations: 'Quotations',
  engagement_letters: 'Engagement Letters',
  letters_agreements: 'Letters & Agreements',
  bookkeeping_imports: 'Bookkeeping Imports',
  purchase_registers: 'Purchase Registers',
  gstr2b: 'GSTR-2B',
  tds_26as: 'Form 26AS',
  tds_books: 'TDS Books',
}
const FOLDER_CATEGORY_PREFIX = 'folder_'

/**
 * Document categories an upload may create on first use, for folders that
 * have no record behind them yet. `tds` matches the TDS module's own
 * category; `consolidated` holds merged files saved on an organization.
 */
export const LAZY_CATEGORIES: Record<string, { name: string; description: string }> = {
  tds: { name: 'TDS', description: 'Challans, return receipts, certificates and notices recorded under TDS.' },
  consolidated: { name: 'Consolidated', description: 'Merged files built from several documents (originals are kept).' },
}

export async function ensureCategory(organisationId: string, code: string) {
  const known = LAZY_CATEGORIES[code]
  if (!known) return prisma.documentCategory.findFirst({ where: { code, organisationId, ...alive } })
  return prisma.documentCategory.upsert({
    where: { code }, update: {},
    create: { organisationId, code, name: known.name, description: known.description, sortOrder: 90 },
  })
}

function item(p: Partial<FolderItem> & Pick<FolderItem, 'id' | 'source' | 'title' | 'openable'>): FolderItem {
  return {
    subtitle: null, date: null, status: null, amount_paise: null,
    file_name: null, mime_type: null, fields: null, document_id: null, ...p,
  }
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fields = (pairs: [string, string | null | undefined][]): [string, string][] =>
  pairs.filter((p): p is [string, string] => p[1] != null && p[1] !== '')

export function has(session: Session, ...perms: string[]): boolean {
  return workstationScope(session, ...(perms as PermissionCode[])) !== null
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  csv: 'text/csv', txt: 'text/plain', json: 'application/json', xml: 'application/xml',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  zip: 'application/zip',
}
export const mimeOf = (name: string) => MIME_BY_EXT[(name.split('.').pop() ?? '').toLowerCase()] ?? 'application/octet-stream'

// GET /api/clients/:id/document-folders
clientFoldersRouter.get('/:id/document-folders', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.read', 'workstation.document.manage')
  const clientId = req.params.id
  await assertCanSeeClient(session, scope, clientId)

  const client = await prisma.client.findFirst({ where: { id: clientId, ...alive }, select: { id: true, organisationId: true } })
  if (!client) throw ApiError.notFound('Client not found.')
  const folders = await buildClientFolders(session, client)

  const canUpload = has(session, 'workstation.document.manage')
  const total = folders.reduce((n, f) => n + f.items.length, 0)
  ok(res, {
    folders: folders.map((f) => ({ ...f, count: f.items.length, can_upload: canUpload })),
    total,
    generated_at: new Date().toISOString(),
  })
}))

/**
 * Every folder for one client, gated by the caller's module permissions.
 * The CALLER must already have checked the client is in scope — the
 * organization document view reuses this for each of its clients.
 */
export async function buildClientFolders(session: Session, client: { id: string; organisationId: string }): Promise<Folder[]> {
  const clientId = client.id
  const categories = await prisma.documentCategory.findMany({
    where: { organisationId: client.organisationId, ...alive }, orderBy: { sortOrder: 'asc' },
  })

  const canEway = has(session, 'workstation.eway.read', 'workstation.eway.generate')
  const canGst = has(session, 'workstation.gst.read', 'workstation.gst.manage')
  const canInvoice = has(session, 'workstation.invoice.read')
  const canQuote = has(session, 'workstation.quotation.read')
  const canEngagement = has(session, 'workstation.engagement.read')
  const canDoc = has(session, 'workstation.doc.read')
  const canService = has(session, 'workstation.service.read', 'workstation.service.manage')
  const canAa = can(session, 'tools.audit_automation.access', 'self')

  const none = Promise.resolve([])
  const [
    ewbs, irns, invoices, quotations, letters, wsdocs, gstFilings,
    uploads, bkImports, prs, gstr2b, tds26as, tdsBooks,
  ] = await Promise.all([
    canEway ? prisma.ewayBill.findMany({ where: { clientId, ...alive }, orderBy: { generatedAt: 'desc' } }) : none,
    canEway ? prisma.eInvoiceIrn.findMany({ where: { clientId, ...alive }, orderBy: { documentDate: 'desc' } }) : none,
    canInvoice ? prisma.invoice.findMany({ where: { clientId, ...alive }, orderBy: { invoiceDate: 'desc' } }) : none,
    canQuote ? prisma.quotation.findMany({ where: { clientId, ...alive }, orderBy: { quoteDate: 'desc' } }) : none,
    canEngagement ? prisma.engagementLetter.findMany({ where: { clientId, ...alive }, orderBy: { letterDate: 'desc' } }) : none,
    canDoc ? prisma.workstationDoc.findMany({ where: { clientId, ...alive }, orderBy: { docDate: 'desc' } }) : none,
    canGst ? prisma.gstFiling.findMany({ where: { gstProfile: { clientId }, ...alive }, orderBy: [{ period: 'desc' }, { returnType: 'asc' }] }) : none,
    prisma.clientDocument.findMany({
      where: { clientId, ...alive },
      include: { category: true, versions: { orderBy: { version: 'desc' }, take: 1 } },
      orderBy: { updatedAt: 'desc' },
    }),
    canService ? prisma.bookkeepingImport.findMany({ where: { clientId }, orderBy: { importedAt: 'desc' } }) : none,
    canAa ? prisma.aaPurchaseRegister.findMany({ where: { clientId, ...alive }, orderBy: { createdAt: 'desc' } }) : none,
    canAa ? prisma.aaGstFiling2B.findMany({ where: { clientId, ...alive }, orderBy: { createdAt: 'desc' } }) : none,
    canAa ? prisma.aaTds26AS.findMany({ where: { clientId, ...alive }, orderBy: { createdAt: 'desc' } }) : none,
    canAa ? prisma.aaTdsBooks.findMany({ where: { clientId, ...alive }, orderBy: { createdAt: 'desc' } }) : none,
  ])

  const folders: Folder[] = []

  if (canEway) {
    folders.push({
      key: 'eway', label: 'E-Way Bills', group: 'compliance',
      items: ewbs.map((e) => item({
        id: e.id, source: 'eway', openable: 'pdf',
        title: e.ewbNo, subtitle: [e.documentNo, e.toPartyName].filter(Boolean).join(' · ') || null,
        date: iso(e.generatedAt), status: e.status, amount_paise: e.valuePaise,
        fields: fields([
          ['E-way bill no', e.ewbNo], ['Document no', e.documentNo], ['Document date', e.documentDate],
          ['From GSTIN', e.fromGstin], ['To GSTIN', e.toGstin], ['To party', e.toPartyName],
          ['Value', rupees(e.valuePaise)], ['Status', e.status], ['Valid until', e.validUntil],
          ['Extensions', e.extensionCount ? String(e.extensionCount) : null],
          ['Cancel reason', e.cancelReason], ['Simulated', e.isSimulated ? 'Yes' : null],
        ]),
      })),
    })
    folders.push({
      key: 'einvoice', label: 'E-Invoices', group: 'compliance',
      items: irns.map((e) => item({
        id: e.id, source: 'einvoice', openable: 'pdf',
        title: e.documentNo, subtitle: e.buyerName ?? e.buyerGstin,
        date: e.documentDate, status: e.status, amount_paise: e.totalValuePaise,
        fields: fields([
          ['Document no', e.documentNo], ['Document date', e.documentDate], ['Type', e.documentType],
          ['IRN', e.irn], ['Buyer', e.buyerName], ['Buyer GSTIN', e.buyerGstin],
          ['Place of supply', e.placeOfSupply], ['Total value', rupees(e.totalValuePaise)],
          ['Status', e.status], ['Reported at', iso(e.reportedAt)], ['Cancel reason', e.cancelReason],
          ['Simulated', e.isSimulated ? 'Yes' : null],
        ]),
      })),
    })
  }

  if (canGst) {
    folders.push({
      key: 'gst_returns', label: 'GST Returns', group: 'compliance',
      items: gstFilings.map((g) => item({
        id: g.id, source: 'gst_filing', openable: 'pdf',
        title: `${g.returnType} — ${g.period}`, subtitle: g.arn ? `ARN ${g.arn}` : null,
        date: iso(g.filedAt) ?? g.dueDate, status: g.status,
        fields: fields([
          ['Return', g.returnType], ['Period', g.period], ['Financial year', g.financialYear],
          ['Status', g.status], ['Due date', g.dueDate], ['Filed at', iso(g.filedAt)], ['ARN', g.arn],
          ['Payment', g.paymentStatus], ['Challan', g.challanRef], ['Remarks', g.remarks],
        ]),
      })),
    })
  }

  if (canInvoice) {
    folders.push({
      key: 'invoices', label: 'Invoices', group: 'billing',
      items: invoices.map((i) => item({
        id: i.id, source: 'invoice', openable: 'pdf',
        title: i.invoiceNumber, subtitle: i.billingName, date: i.invoiceDate,
        status: i.status, amount_paise: i.totalPaise,
      })),
    })
  }
  if (canQuote) {
    folders.push({
      key: 'quotations', label: 'Quotations', group: 'billing',
      items: quotations.map((q) => item({
        id: q.id, source: 'quotation', openable: 'pdf',
        title: q.quotationCode, subtitle: q.subject, date: q.quoteDate,
        status: q.status, amount_paise: q.totalPaise,
      })),
    })
  }
  if (canEngagement) {
    folders.push({
      key: 'engagement_letters', label: 'Engagement Letters', group: 'billing',
      items: letters.map((l) => item({
        id: l.id, source: 'engagement', openable: 'pdf',
        title: l.letterCode, subtitle: l.subject, date: l.letterDate, status: l.status,
      })),
    })
  }
  if (canDoc) {
    folders.push({
      key: 'letters_agreements', label: 'Letters & Agreements', group: 'billing',
      items: wsdocs.map((d) => item({
        id: d.id, source: 'wsdoc', openable: 'pdf',
        title: d.title, subtitle: d.docCode, date: d.docDate, status: d.status,
      })),
    })
  }

  // Uploaded / requested files. A file uploaded into a record folder (its
  // category is `folder_<key>`) joins that folder; everything else gets one
  // folder per document category. TDS receipts, partnership filings and
  // bookkeeping deliverables all land here.
  // Requests answered on behalf of a child client (organization requests).
  const answered = uploads.length
    ? await prisma.clientDocument.findMany({
        where: { sourceRequestId: { in: uploads.map((d) => d.id) }, ...alive },
        select: { id: true, sourceRequestId: true, client: { select: { id: true, companyName: true } } },
      })
    : []
  const storedFor = new Map(answered.map((a) => [a.sourceRequestId!, { client_id: a.client.id, client_name: a.client.companyName, document_id: a.id }]))

  const intoFolder = new Map<string, FolderItem[]>()
  const byCategory = new Map<string, Folder>()
  for (const c of categories) {
    if (c.code.startsWith(FOLDER_CATEGORY_PREFIX)) continue
    byCategory.set(`uploads:${c.code}`, { key: `uploads:${c.code}`, label: `${c.name} Documents`, group: 'uploads', items: [] })
  }
  for (const d of uploads) {
    const v = d.versions[0]
    const sf = storedFor.get(d.id) ?? null
    const it = item({
      id: v?.id ?? d.id, source: 'upload',
      openable: !v ? 'none' : v.mimeType ? 'file' : 'missing',
      title: d.name,
      subtitle: sf
        ? `Received · stored under ${sf.client_name}`
        : [d.financialYear, v ? `v${v.version}` : null].filter(Boolean).join(' · ') || null,
      stored_for: sf,
      date: iso(v?.uploadedAt ?? d.updatedAt), status: d.status,
      file_name: v?.originalName ?? null, mime_type: v?.mimeType ?? null, document_id: d.id,
      uploaded_by_id: v?.uploadedBy ?? null,
    })
    if (d.category.code.startsWith(FOLDER_CATEGORY_PREFIX)) {
      const target = d.category.code.slice(FOLDER_CATEGORY_PREFIX.length)
      intoFolder.set(target, [...(intoFolder.get(target) ?? []), it])
      continue
    }
    const key = `uploads:${d.category.code}`
    let f = byCategory.get(key)
    if (!f) {
      f = { key, label: `${d.category.name} Documents`, group: 'uploads', items: [] }
      byCategory.set(key, f)
    }
    f.items.push(it)
  }
  folders.push(...[...byCategory.values()].sort((a, b) => a.label.localeCompare(b.label)))

  const importFolder = (key: string, label: string, rows: { id: string; originalFilename: string; createdAt: Date }[], source: string, sub: (r: never) => string | null) => {
    folders.push({
      key, label, group: 'imports',
      items: rows.map((r) => item({
        id: r.id, source, openable: 'file', title: r.originalFilename,
        subtitle: sub(r as never), date: iso(r.createdAt),
        file_name: r.originalFilename, mime_type: mimeOf(r.originalFilename),
      })),
    })
  }
  if (canService) {
    folders.push({
      key: 'bookkeeping_imports', label: 'Bookkeeping Imports', group: 'imports',
      items: bkImports.map((b) => item({
        id: b.id, source: 'bk_import', openable: 'file', title: b.originalFilename,
        subtitle: `${b.kind.replace(/_/g, ' ')} · ${b.periodFromInFile} → ${b.periodToInFile}`,
        date: iso(b.importedAt), status: b.status, file_name: b.originalFilename, mime_type: b.mimeType,
      })),
    })
  }
  if (canAa) {
    const period = (r: { periodMonth: number; periodYear: number }) => `${String(r.periodMonth).padStart(2, '0')}/${r.periodYear}`
    importFolder('purchase_registers', 'Purchase Registers', prs, 'aa_pr', period)
    importFolder('gstr2b', 'GSTR-2B', gstr2b, 'aa_2b', period)
    importFolder('tds_26as', 'Form 26AS', tds26as, 'aa_26as', (r: { assessmentYear: number }) => `AY ${r.assessmentYear}`)
    importFolder('tds_books', 'TDS Books', tdsBooks, 'aa_tdsbooks', (r: { assessmentYear: number }) => `AY ${r.assessmentYear}`)
  }

  for (const f of folders) {
    const extra = intoFolder.get(f.key)
    if (extra) f.items.push(...extra)
  }
  return folders
}

/**
 * GET /api/clients/:id/document-folders/open?source=…&ref=… — a short-lived
 * signed link to the document. Re-checks that `ref` belongs to this client
 * and that the caller may read that module.
 */
clientFoldersRouter.get('/:id/document-folders/open', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.read', 'workstation.document.manage')
  const clientId = req.params.id
  await assertCanSeeClient(session, scope, clientId)

  const source = String(req.query.source ?? '')
  const ref = String(req.query.ref ?? '')
  if (!ref) throw ApiError.badRequest('ref is required.')
  const notFound = () => ApiError.notFound('Document not found.')
  const need = (allowed: boolean) => { if (!allowed) throw ApiError.forbidden() }
  const where = { id: ref, clientId, ...alive }

  switch (source) {
    case 'invoice': {
      need(has(session, 'workstation.invoice.read'))
      if (!await prisma.invoice.findFirst({ where, select: { id: true } })) throw notFound()
      return ok(res, signedLink(`/api/invoices/${ref}/pdf`, `invoice:${ref}`, session.userId))
    }
    case 'quotation': {
      need(has(session, 'workstation.quotation.read'))
      if (!await prisma.quotation.findFirst({ where, select: { id: true } })) throw notFound()
      return ok(res, signedLink(`/api/quotations/${ref}/pdf`, `quotation:${ref}`, session.userId))
    }
    case 'engagement': {
      need(has(session, 'workstation.engagement.read'))
      if (!await prisma.engagementLetter.findFirst({ where, select: { id: true } })) throw notFound()
      return ok(res, signedLink(`/api/engagement-letters/${ref}/pdf`, `engagement:${ref}`, session.userId))
    }
    case 'wsdoc': {
      need(has(session, 'workstation.doc.read'))
      if (!await prisma.workstationDoc.findFirst({ where, select: { id: true } })) throw notFound()
      return ok(res, signedLink(`/api/workstation-docs/${ref}/pdf`, `wsdoc:${ref}`, session.userId))
    }
    case 'upload': {
      const v = await prisma.clientDocumentVersion.findFirst({
        where: { id: ref, document: { clientId, ...alive } }, select: { id: true, mimeType: true },
      })
      if (!v) throw notFound()
      if (!v.mimeType) throw ApiError.notFound('The original file has not been uploaded yet. Use Upload file to add it.')
      return ok(res, signedLink(`/api/workstation-documents/${ref}/download`, `workstation-document:${ref}`, session.userId))
    }
    case 'eway': case 'einvoice': {
      need(has(session, 'workstation.eway.read', 'workstation.eway.generate'))
      const row = source === 'eway'
        ? await prisma.ewayBill.findFirst({ where, select: { id: true } })
        : await prisma.eInvoiceIrn.findFirst({ where, select: { id: true } })
      if (!row) throw notFound()
      break
    }
    case 'gst_filing': {
      need(has(session, 'workstation.gst.read', 'workstation.gst.manage'))
      if (!await prisma.gstFiling.findFirst({ where: { id: ref, gstProfile: { clientId }, ...alive }, select: { id: true } })) throw notFound()
      break
    }
    case 'bk_import': {
      need(has(session, 'workstation.service.read', 'workstation.service.manage'))
      if (!await prisma.bookkeepingImport.findFirst({ where: { id: ref, clientId }, select: { id: true } })) throw notFound()
      break
    }
    case 'aa_pr': case 'aa_2b': case 'aa_26as': case 'aa_tdsbooks': {
      need(can(session, 'tools.audit_automation.access', 'self'))
      if (!await AA_FILE[source](ref, clientId)) throw notFound()
      break
    }
    default:
      throw ApiError.badRequest('Unknown document source.')
  }
  ok(res, signedLink(`/api/client-files/${source}/${ref}`, `client-file:${source}:${ref}`, session.userId))
}))

/**
 * POST /api/clients/:id/document-folders/:folder/upload — add a file straight
 * into a folder. `folder` is a folder key from the listing: `uploads:<code>`
 * for a document category, or a record folder such as `eway`. Multipart:
 * `file`, optional `name` and `financial_year`.
 */
const folderUpload = () => multer({ storage: multer.memoryStorage(), limits: { fileSize: CLIENT_DOC_MAX_MB * 1024 * 1024, files: 1 } })

clientFoldersRouter.post('/:id/document-folders/:folder/upload', (req, res, next) => {
  folderUpload().single('file')(req, res, (err: unknown) => {
    if (!err) return next()
    if ((err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
      return next(ApiError.unprocessable('too_large', `File is larger than the ${CLIENT_DOC_MAX_MB} MB limit.`))
    }
    next(ApiError.badRequest('Upload could not be read.'))
  })
}, handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.manage')
  const clientId = req.params.id
  await assertCanSeeClient(session, scope, clientId)

  const client = await prisma.client.findFirst({ where: { id: clientId, ...alive }, select: { id: true, organisationId: true } })
  if (!client) throw ApiError.notFound('Client not found.')

  const file = req.file
  if (!file) throw ApiError.badRequest('Choose a file to upload.', { file: 'Choose a file to upload.' })
  const ext = (file.originalname.split('.').pop() ?? '').toLowerCase()
  const mimeType = CLIENT_DOC_MIME[ext]
  if (!mimeType) {
    throw ApiError.unprocessable('file_type', `Allowed types: ${Object.keys(CLIENT_DOC_MIME).join(', ').toUpperCase()}.`)
  }

  // Resolve the folder to a document category.
  const folder = req.params.folder
  let categoryId: string
  if (folder.startsWith('uploads:')) {
    const cat = await ensureCategory(client.organisationId, folder.slice('uploads:'.length))
    if (!cat) throw ApiError.notFound('Folder not found.')
    categoryId = cat.id
  } else {
    const label = FOLDER_UPLOAD_CATEGORY[folder]
    if (!label) throw ApiError.notFound('Folder not found.')
    const code = `${FOLDER_CATEGORY_PREFIX}${folder}`
    const cat = await prisma.documentCategory.upsert({
      where: { code },
      update: {},
      create: { organisationId: client.organisationId, code, name: label, description: `Files uploaded into the ${label} folder.`, sortOrder: 100 },
    })
    categoryId = cat.id
  }

  const b = req.body as Record<string, unknown>
  const name = (typeof b.name === 'string' && b.name.trim() ? b.name.trim() : file.originalname).slice(0, 200)
  const fy = typeof b.financial_year === 'string' && /^\d{4}-\d{2}$/.test(b.financial_year.trim()) ? b.financial_year.trim() : null

  const docId = crypto.randomUUID()
  const safe = file.originalname.replace(/[^A-Za-z0-9._-]/g, '_').slice(-120)
  const key = `${clientId}/${docId}/${crypto.randomUUID()}-${safe}`
  await clientDocumentStorage.put(key, file.buffer)

  const [doc] = await prisma.$transaction([
    prisma.clientDocument.create({
      data: {
        id: docId, clientId, categoryId, name, financialYear: fy,
        status: 'uploaded', currentVersion: 1, createdBy: session.userId,
      },
    }),
    prisma.clientDocumentVersion.create({
      data: {
        documentId: docId, version: 1, fileKey: key, originalName: file.originalname, mimeType,
        sizeBytes: file.size, uploadedBy: session.employeeId ?? session.userId, reviewStatus: 'uploaded',
      },
    }),
  ])

  await writeActivity({
    session, subjectType: 'client', subjectId: clientId,
    action: 'document.uploaded',
    description: `${name} uploaded (v1).`,
    entityType: 'ClientDocument', entityId: doc.id,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'client_document.upload',
    entityType: 'ClientDocument', entityId: doc.id,
    after: { clientId, folder, name, originalName: file.originalname, sizeBytes: file.size }, req,
  })
  ok(res, { id: doc.id, name: doc.name, folder }, 201)
}))

type StoredFile = { storagePath: string; originalFilename: string; mimeType?: string } | null
const pick = { storagePath: true, originalFilename: true } as const
export const AA_FILE: Record<string, (id: string, clientId?: string) => Promise<StoredFile>> = {
  aa_pr: (id, clientId) => prisma.aaPurchaseRegister.findFirst({ where: { id, ...(clientId ? { clientId } : {}), ...alive }, select: pick }),
  aa_2b: (id, clientId) => prisma.aaGstFiling2B.findFirst({ where: { id, ...(clientId ? { clientId } : {}), ...alive }, select: pick }),
  aa_26as: (id, clientId) => prisma.aaTds26AS.findFirst({ where: { id, ...(clientId ? { clientId } : {}), ...alive }, select: pick }),
  aa_tdsbooks: (id, clientId) => prisma.aaTdsBooks.findFirst({ where: { id, ...(clientId ? { clientId } : {}), ...alive }, select: pick }),
}

/** Send bytes inline (open in a browser tab) or as an attachment (?download=1). */
export function sendFile(res: import('express').Response, bytes: Buffer, name: string, mime: string, download: boolean) {
  res.setHeader('Content-Type', mime)
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`)
  res.send(bytes)
}

/**
 * Real uploaded bytes behind a ClientDocumentVersion. Several modules write
 * into the one ClientDocument store, each with its own storage root, so the
 * key is looked up in each until one holds it.
 */
const tdsStorage = () => new LocalStorageAdapter(process.env.TDS_STORAGE_ROOT
  ? path.resolve(process.env.TDS_STORAGE_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'tds-documents'))

/** Files uploaded straight onto a client document (Documents → Upload file). */
export const clientDocumentStorage: StorageAdapter = new LocalStorageAdapter(process.env.CLIENT_DOC_STORAGE_ROOT
  ? path.resolve(process.env.CLIENT_DOC_STORAGE_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'client-documents'))

export const CLIENT_DOC_MAX_MB = 25
export const CLIENT_DOC_MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', txt: 'text/plain', json: 'application/json', xml: 'application/xml', zip: 'application/zip',
}

export async function readVersionBytes(fileKey: string): Promise<Buffer | null> {
  const stores: StorageAdapter[] = [clientDocumentStorage, tdsStorage(), partnershipStorage]
  for (const s of stores) {
    try {
      if (await s.exists(fileKey)) return await s.get(fileKey)
    } catch { /* key not valid for this adapter — try the next */ }
  }
  return null
}

async function readOr404(store: StorageAdapter, key: string): Promise<Buffer> {
  if (!await store.exists(key).catch(() => false)) {
    throw ApiError.notFound('This file is no longer in storage. Re-upload it from its module.')
  }
  return store.get(key)
}

/** Signed bytes for the imported source files. Mounted before `authenticate`. */
export const clientFilesSignedRouter = Router()

clientFilesSignedRouter.get('/client-files/:source/:id', handler(async (req, res) => {
  const { source, id } = req.params
  verifyResourceToken(`client-file:${source}:${id}`, typeof req.query.t === 'string' ? req.query.t : undefined)
  const download = req.query.download === '1'

  if (source === 'eway') {
    const e = await prisma.ewayBill.findFirst({ where: { id, ...alive }, include: { client: true } })
    if (!e) throw ApiError.notFound('E-way bill not found.')
    return streamEwayBillPdf(res, e, download)
  }
  if (source === 'einvoice') {
    const e = await prisma.eInvoiceIrn.findFirst({ where: { id, ...alive }, include: { client: true } })
    if (!e) throw ApiError.notFound('E-invoice not found.')
    return streamEInvoicePdf(res, e, download)
  }
  if (source === 'gst_filing') {
    const g = await prisma.gstFiling.findFirst({ where: { id, ...alive }, include: { gstProfile: { include: { client: true } } } })
    if (!g) throw ApiError.notFound('GST return not found.')
    return streamGstFilingPdf(res, g, download)
  }
  if (source === 'bk_import') {
    const b = await prisma.bookkeepingImport.findFirst({ where: { id } })
    if (!b) throw ApiError.notFound('File not found.')
    return sendFile(res, await readOr404(bookkeepingImportStorage, b.storagePath), b.originalFilename, b.mimeType, download)
  }
  const load = AA_FILE[source]
  if (!load) throw ApiError.notFound('File not found.')
  const f = await load(id)
  if (!f) throw ApiError.notFound('File not found.')
  sendFile(res, await readOr404(aaStorage, f.storagePath), f.originalFilename, mimeOf(f.originalFilename), download)
}))
