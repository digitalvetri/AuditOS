import crypto from 'node:crypto'
import { Router } from 'express'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { env } from '../../lib/env.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { writeActivity } from '../../platform/workstation/activity.js'
import { assertCanSeeClient, requireWorkstation } from '../../platform/workstation/scope.js'
import JSZip from 'jszip'
import { renderPdf } from '../../platform/pdfBuffer.js'
import { streamInvoicePdf, INVOICE_PDF_INCLUDE } from '../invoice/pdf.js'
import { streamQuotationPdf, QUOTATION_PDF_INCLUDE } from '../quotation/pdf.js'
import { streamEngagementPdf } from '../engagement/pdf.js'
import { INCLUDE as ENGAGEMENT_INCLUDE } from '../engagement/service.js'
import { streamDocPdf } from '../docs/pdf.js'
import { INCLUDE as DOC_INCLUDE } from '../docs/service.js'
import { streamEInvoicePdf, streamEwayBillPdf, streamGstFilingPdf } from './record-pdf.js'
import { buildClientFolders, CLIENT_VIEW, readVersionBytes, sendFile } from './client-folders.routes.js'

/**
 * CLIENT DOCUMENT LINK — the client's own live view of their Documents tab.
 *
 * Staff (authenticated, mounted under /api/clients):
 *   GET    /api/clients/:id/share-link          the current link (on or off), or null
 *   POST   /api/clients/:id/share-link          create — or regenerate, which revokes the old one for good
 *   DELETE /api/clients/:id/share-link          turn off: the URL stops working at once
 *   POST   /api/clients/:id/share-link/resume   turn the SAME link back on
 *
 * Client (public, mounted before `authenticate`):
 *   GET /api/client-portal/:token                    folders, built fresh on every call
 *   GET /api/client-portal/:token/open?source&ref[&download=1]   the file — inline, or as a download
 *   GET /api/client-portal/:token/zip[?folder=key]               every available file, zipped
 *
 * Unlike the 100-year PDF links in share/routes.ts, this token lives in the
 * database so it can be revoked, and it carries no snapshot: every request
 * re-reads the client's documents, so the page is always current.
 */
export const clientShareLinkRouter = Router()
export const clientPortalPublicRouter = Router()

const portalUrl = (token: string) => `${env.publicAppUrl ?? ''}/portal/documents/${token}`

function linkToApi(l: { id: string; token: string; createdAt: Date; pausedAt: Date | null; lastViewedAt: Date | null; viewCount: number }) {
  return {
    id: l.id,
    active: l.pausedAt === null,
    paused_at: l.pausedAt?.toISOString() ?? null,
    url: portalUrl(l.token),
    // Relative when PUBLIC_APP_URL is unset — the UI prefixes its own origin.
    absolute: env.publicAppUrl !== null,
    created_at: l.createdAt.toISOString(),
    last_viewed_at: l.lastViewedAt?.toISOString() ?? null,
    view_count: l.viewCount,
  }
}

const activeLink = (clientId: string) =>
  prisma.clientDocumentShareLink.findFirst({ where: { clientId, revokedAt: null }, orderBy: { createdAt: 'desc' } })

// GET /api/clients/:id/share-link
clientShareLinkRouter.get('/:id/share-link', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.read', 'workstation.document.manage')
  await assertCanSeeClient(session, scope, req.params.id)
  const l = await activeLink(req.params.id)
  ok(res, l ? linkToApi(l) : null)
}))

// POST /api/clients/:id/share-link — a fresh token; any earlier link is revoked.
clientShareLinkRouter.post('/:id/share-link', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.manage')
  const clientId = req.params.id
  await assertCanSeeClient(session, scope, clientId)
  const client = await prisma.client.findFirst({ where: { id: clientId, ...alive }, select: { id: true, companyName: true } })
  if (!client) throw ApiError.notFound('Client not found.')

  const now = new Date()
  const [revoked, link] = await prisma.$transaction([
    prisma.clientDocumentShareLink.updateMany({
      where: { clientId, revokedAt: null }, data: { revokedAt: now, revokedBy: session.userId },
    }),
    prisma.clientDocumentShareLink.create({
      data: { clientId, token: crypto.randomBytes(32).toString('base64url'), createdBy: session.userId },
    }),
  ])

  const regenerated = revoked.count > 0
  await writeActivity({
    session, subjectType: 'client', subjectId: clientId,
    action: regenerated ? 'document_link.regenerated' : 'document_link.created',
    description: regenerated
      ? 'Client document link regenerated — the previous link no longer works.'
      : 'Client document link created.',
    entityType: 'ClientDocumentShareLink', entityId: link.id,
  })
  await writeAudit({
    actorUserId: session.userId, action: regenerated ? 'client_document_link.regenerate' : 'client_document_link.create',
    entityType: 'ClientDocumentShareLink', entityId: link.id, after: { clientId }, req,
  })
  ok(res, linkToApi(link), 201)
}))

// DELETE /api/clients/:id/share-link — turn off (reversible: see /resume).
clientShareLinkRouter.delete('/:id/share-link', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.manage')
  const clientId = req.params.id
  await assertCanSeeClient(session, scope, clientId)

  const l = await activeLink(clientId)
  if (!l) throw ApiError.notFound('This client has no document link.')
  if (l.pausedAt) return ok(res, linkToApi(l))
  const updated = await prisma.clientDocumentShareLink.update({
    where: { id: l.id }, data: { pausedAt: new Date(), pausedBy: session.userId },
  })
  await writeActivity({
    session, subjectType: 'client', subjectId: clientId,
    action: 'document_link.paused', description: 'Client document link turned off.',
    entityType: 'ClientDocumentShareLink', entityId: l.id,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'client_document_link.pause',
    entityType: 'ClientDocumentShareLink', entityId: l.id, after: { clientId }, req,
  })
  ok(res, linkToApi(updated))
}))

// POST /api/clients/:id/share-link/resume — the same URL works again.
clientShareLinkRouter.post('/:id/share-link/resume', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.manage')
  const clientId = req.params.id
  await assertCanSeeClient(session, scope, clientId)

  const l = await activeLink(clientId)
  if (!l) throw ApiError.notFound('This client has no document link.')
  if (!l.pausedAt) return ok(res, linkToApi(l))
  const updated = await prisma.clientDocumentShareLink.update({
    where: { id: l.id }, data: { pausedAt: null, pausedBy: null },
  })
  await writeActivity({
    session, subjectType: 'client', subjectId: clientId,
    action: 'document_link.resumed', description: 'Client document link turned back on.',
    entityType: 'ClientDocumentShareLink', entityId: l.id,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'client_document_link.resume',
    entityType: 'ClientDocumentShareLink', entityId: l.id, after: { clientId }, req,
  })
  ok(res, linkToApi(updated))
}))

/** The live, non-revoked link for `token`, with its client — or a 404 that says what happened. */
async function resolveToken(token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw ApiError.notFound('This link is not valid.')
  const link = await prisma.clientDocumentShareLink.findUnique({
    where: { token },
    include: { client: { select: { id: true, organisationId: true, companyName: true, clientCode: true, gstin: true, deletedAt: true } } },
  })
  if (!link || link.client.deletedAt) throw ApiError.notFound('This link is not valid.')
  if (link.revokedAt) throw new ApiError(410, 'link_revoked', 'This link has been replaced by a newer one. Ask your accountant for the new link.')
  if (link.pausedAt) throw new ApiError(410, 'link_paused', 'This link is turned off for now. Ask your accountant to turn it back on.')
  return link
}

// GET /api/client-portal/:token[?visit=1]
clientPortalPublicRouter.get('/client-portal/:token', handler(async (req, res) => {
  const link = await resolveToken(req.params.token)
  const { client } = link

  const [folders, firm] = await Promise.all([
    buildClientFolders(CLIENT_VIEW, client),
    prisma.organisation.findUnique({ where: { id: client.organisationId }, select: { name: true } }),
  ])
  // The page polls to stay live; only its first load counts as a visit.
  if (req.query.visit === '1') {
    await prisma.clientDocumentShareLink.update({
      where: { id: link.id }, data: { lastViewedAt: new Date(), viewCount: { increment: 1 } },
    })
  }

  // Only what the client needs: no staff ids, no internal document ids, no
  // empty folders.
  const shown = folders
    .filter((f) => f.items.length > 0)
    .map((f) => ({
      key: f.key, label: f.label, group: f.group, count: f.items.length,
      items: f.items.map((i) => ({
        id: i.id, source: i.source, title: i.title, subtitle: i.subtitle, date: i.date,
        status: i.status, amount_paise: i.amount_paise,
        openable: i.openable === 'missing' ? 'none' : i.openable,
        file_name: i.file_name, mime_type: i.mime_type, fields: i.fields,
      })),
    }))

  res.setHeader('Cache-Control', 'private, no-store')
  ok(res, {
    firm: firm?.name ?? null,
    client: { name: client.companyName, code: client.clientCode, gstin: client.gstin },
    folders: shown,
    total: shown.reduce((n, f) => n + f.count, 0),
    generated_at: new Date().toISOString(),
  })
}))

/**
 * One document's bytes, for the client. Only what CLIENT_VIEW lists: the row
 * must belong to this client and must not be a draft. Null when it does not
 * exist (or is not visible) or has no file.
 */
async function itemFile(clientId: string, source: string, ref: string): Promise<{ name: string; mime: string; bytes: Buffer } | null> {
  const where = { id: ref, clientId, ...alive }
  const issued = { ...where, status: { not: 'draft' } }
  const pdf = async (name: string, write: (res: never) => unknown) =>
    ({ name, mime: 'application/pdf', bytes: await renderPdf(write) })
  switch (source) {
    case 'invoice': {
      const inv = await prisma.invoice.findFirst({ where: issued, include: INVOICE_PDF_INCLUDE })
      return inv ? pdf(`${inv.invoiceNumber ?? 'invoice'}.pdf`, (res) => streamInvoicePdf(res, inv)) : null
    }
    case 'quotation': {
      const q = await prisma.quotation.findFirst({ where: issued, include: QUOTATION_PDF_INCLUDE })
      return q ? pdf(`${q.quotationCode}.pdf`, (res) => streamQuotationPdf(res, q)) : null
    }
    case 'engagement': {
      const l = await prisma.engagementLetter.findFirst({ where: issued, include: ENGAGEMENT_INCLUDE })
      return l ? pdf(`${l.letterCode}.pdf`, (res) => streamEngagementPdf(res, l)) : null
    }
    case 'wsdoc': {
      const d = await prisma.workstationDoc.findFirst({ where: issued, include: DOC_INCLUDE })
      return d ? pdf(`${d.docCode}.pdf`, (res) => streamDocPdf(res, d)) : null
    }
    case 'eway': {
      const e = await prisma.ewayBill.findFirst({ where, include: { client: true } })
      return e ? pdf(`${e.ewbNo}.pdf`, (res) => streamEwayBillPdf(res, e)) : null
    }
    case 'einvoice': {
      const e = await prisma.eInvoiceIrn.findFirst({ where, include: { client: true } })
      return e ? pdf(`e-invoice-${e.documentNo}.pdf`, (res) => streamEInvoicePdf(res, e)) : null
    }
    case 'gst_filing': {
      const g = await prisma.gstFiling.findFirst({
        where: { id: ref, gstProfile: { clientId }, ...alive }, include: { gstProfile: { include: { client: true } } },
      })
      return g ? pdf(`${g.returnType}-${g.period}.pdf`, (res) => streamGstFilingPdf(res, g)) : null
    }
    case 'upload': {
      const v = await prisma.clientDocumentVersion.findFirst({
        where: { id: ref, document: { clientId, ...alive } }, include: { document: true },
      })
      if (!v?.mimeType) return null
      const bytes = await readVersionBytes(v.fileKey)
      return bytes ? { name: v.originalName ?? v.document.name, mime: v.mimeType, bytes } : null
    }
    default:
      return null
  }
}

// GET /api/client-portal/:token/open?source=…&ref=…[&download=1]
clientPortalPublicRouter.get('/client-portal/:token/open', handler(async (req, res) => {
  const link = await resolveToken(req.params.token)
  const f = await itemFile(link.client.id, String(req.query.source ?? ''), String(req.query.ref ?? ''))
  if (!f) throw ApiError.notFound('This document is not available.')
  sendFile(res, f.bytes, f.name, f.mime, req.query.download === '1')
}))

const ZIP_MAX_FILES = 300

// GET /api/client-portal/:token/zip[?folder=key] — one folder, or everything.
clientPortalPublicRouter.get('/client-portal/:token/zip', handler(async (req, res) => {
  const link = await resolveToken(req.params.token)
  const { client } = link
  const only = typeof req.query.folder === 'string' && req.query.folder ? req.query.folder : null

  const folders = (await buildClientFolders(CLIENT_VIEW, client)).filter((f) => !only || f.key === only)
  if (only && folders.length === 0) throw ApiError.notFound('Folder not found.')
  const items = folders.flatMap((f) => f.items
    .filter((i) => i.openable === 'pdf' || i.openable === 'file')
    .map((i) => ({ folder: f.label, source: i.source, id: i.id })))
  if (items.length === 0) throw ApiError.notFound('There are no files to download here yet.')
  if (items.length > ZIP_MAX_FILES) {
    throw ApiError.unprocessable('too_many', `That is more than ${ZIP_MAX_FILES} files — download one folder at a time.`)
  }

  const zip = new JSZip()
  const used = new Set<string>()
  const clean = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'file'
  // A few at a time: PDFs render in memory.
  for (let i = 0; i < items.length; i += 6) {
    const batch = await Promise.all(items.slice(i, i + 6).map(async (it) => ({ it, f: await itemFile(client.id, it.source, it.id).catch(() => null) })))
    for (const { it, f } of batch) {
      if (!f) continue
      const dir = only ? '' : `${clean(it.folder)}/`
      let name = `${dir}${clean(f.name)}`
      for (let n = 2; used.has(name); n++) name = `${dir}${clean(f.name).replace(/(\.[^.]*)?$/, ` (${n})$1`)}`
      used.add(name)
      zip.file(name, f.bytes)
    }
  }
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  const label = only ? folders[0].label : 'All documents'
  sendFile(res, bytes, `${clean(client.companyName)} - ${clean(label)}.zip`, 'application/zip', true)
}))
