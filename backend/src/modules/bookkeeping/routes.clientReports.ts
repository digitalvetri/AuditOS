import type { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { prisma } from '../../lib/prisma.js'
import { generateClientReport, readClientReportFile, renderClientDashboard } from './services/BookkeepingClientReportService.js'

/**
 * BOOKKEEPING · CLIENT DASHBOARD ROUTES (BOOKKEEPING-REBUILD §6).
 *
 * Mounted on the parent bookkeeping router at
 *   /api/bookkeeping/companies/:companyId/client-reports/...
 */

function requireRead(session: Session) {
  if (!can(session, 'tools.audit_automation.bookkeeping.master.read', 'self')) {
    throw ApiError.forbidden('You do not have permission to view client reports.')
  }
}
function requireManage(session: Session) {
  if (!can(session, 'tools.audit_automation.bookkeeping.master.manage', 'self')) {
    throw ApiError.forbidden('You do not have permission to generate client reports.')
  }
}

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD.')

export function registerBookkeepingClientReportRoutes(router: Router): void {
  // POST /client-reports — generate one.
  router.post(
    '/companies/:companyId/client-reports',
    handler(async (req, res) => {
      const session = requireSession(req)
      requireManage(session)
      const body = z.object({
        from: ISO,
        to: ISO,
        fy_id: z.string().max(64).optional().nullable(),
        // Accepted for older clients; the dashboard now labels its own periods.
        period_label: z.string().max(80).optional(),
        fy_label: z.string().max(30).optional(),
        prepared_by: z.string().min(1).max(200),
        firm_contact: z.string().max(400).optional().nullable(),
      }).safeParse(req.body)
      if (!body.success) throw ApiError.badRequest(body.error.issues[0]?.message ?? 'Invalid input.')

      const result = await generateClientReport(
        prisma,
        {
          companyId: req.params.companyId,
          financialYearId: body.data.fy_id ?? null,
          from: body.data.from,
          to: body.data.to,
          preparedBy: body.data.prepared_by,
          firmContact: body.data.firm_contact ?? null,
        },
        session.userId,
      )

      await writeAudit({
        actorUserId: session.userId,
        action: 'bookkeeping.client_report.generate',
        entityType: 'bookkeeping_client_report',
        entityId: result.id,
        after: { fileName: result.fileName, sha: result.fileSha256, from: body.data.from, to: body.data.to },
        req,
      })

      // We don't return the HTML in the JSON envelope — it can be big and
      // the client only needs the id to download it (or the sha to verify
      // history). Two extra bytes vs an unbounded payload.
      ok(res, {
        id: result.id,
        fileName: result.fileName,
        fileSha256: result.fileSha256,
      })
    }),
  )

  // GET /client-dashboard/view — the dashboard page itself, not saved, for
  // the in-app view (an iframe). The CSP `sandbox` gives the page an opaque
  // origin even if opened directly, so its script can never act as the app.
  router.get(
    '/companies/:companyId/client-dashboard/view',
    handler(async (req, res) => {
      const session = requireSession(req)
      requireRead(session)
      const q = z.object({
        from: ISO,
        to: ISO,
        fy_id: z.string().max(64).optional(),
        prepared_by: z.string().max(200).optional(),
        firm_contact: z.string().max(400).optional(),
      }).safeParse(req.query)
      if (!q.success) throw ApiError.badRequest(q.error.issues[0]?.message ?? 'Invalid input.')
      if (q.data.from > q.data.to) throw ApiError.badRequest('The period start is after its end.')
      let html: string
      try {
        html = await renderClientDashboard(prisma, {
          companyId: req.params.companyId,
          financialYearId: q.data.fy_id ?? null,
          from: q.data.from,
          to: q.data.to,
          preparedBy: q.data.prepared_by?.trim() || 'JNS Accounting Solutions',
          firmContact: q.data.firm_contact?.trim() || null,
        })
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('Company not found')) throw ApiError.notFound('Company not found.')
        throw e
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-modals allow-downloads allow-popups; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; frame-ancestors 'self'")
      res.send(html)
    }),
  )

  // GET /client-reports — history, newest first.
  router.get(
    '/companies/:companyId/client-reports',
    handler(async (req, res) => {
      const session = requireSession(req)
      requireRead(session)
      const items = await prisma.bookkeepingClientReport.findMany({
        where: { tallyCompanyId: req.params.companyId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      })
      ok(res, { items })
    }),
  )

  // GET /client-reports/:id/download — stream the exact file bytes.
  //
  // Content-Disposition uses the stored fileName. The response is
  // authenticated because a client dashboard summarises the client's
  // whole book — even if the recipient is the client, only the firm
  // downloads from here (they forward via WhatsApp / email).
  router.get(
    '/companies/:companyId/client-reports/:reportId/download',
    handler(async (req, res) => {
      const session = requireSession(req)
      requireRead(session)
      const row = await prisma.bookkeepingClientReport.findFirst({
        where: { id: req.params.reportId, tallyCompanyId: req.params.companyId },
      })
      if (!row) throw ApiError.notFound('Report not found.')
      const bytes = await readClientReportFile(row.storagePath)
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${row.fileName.replace(/[^\w.-]+/g, '_')}"`)
      res.send(bytes)
    }),
  )
}
