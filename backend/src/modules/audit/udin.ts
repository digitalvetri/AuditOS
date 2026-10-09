import type { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { assertCanSeeClient, clientScopeWhere } from '../../platform/workstation/scope.js'
import { clientsById, employeeNames, assertEmployee } from './service.js'
import * as S from './serialize.js'
import { ISO_DATE, access, audit, isUniqueViolation, parse } from './common.js'

/**
 * ICAI UDIN register, firm-wide. A UDIN is 18 characters: the 2-digit year,
 * the 6-digit membership number of the member who generated it, and 10
 * uppercase alphanumerics. The membership number inside must be the
 * signing member's.
 */

export const UDIN_RE = /^(\d{2})(\d{6})([A-Z0-9]{10})$/
const DOC_TYPES = ['audit_report', 'tax_audit_report', 'certificate', 'caro', 'other'] as const

export function validateUdin(udin: string, membershipNo: string) {
  const m = UDIN_RE.exec(udin)
  if (!m) {
    throw ApiError.badRequest('A UDIN is 18 characters: 2-digit year, 6-digit membership number, then 10 capital letters or digits.', { udin: 'Invalid format.' })
  }
  if (m[2] !== membershipNo.padStart(6, '0')) {
    throw ApiError.unprocessable('udin_membership_mismatch', `The membership number in this UDIN (${m[2]}) is not ${membershipNo.padStart(6, '0')}.`, { udin: 'Membership number does not match.' })
  }
}

export const udinDocType = (auditType: string) => (auditType === 'tax' ? 'tax_audit_report' : 'audit_report')

export function registerUdins(r: Router) {
  r.get('/udins/missing', handler(async (req, res) => {
    const { session, scope } = access(req, 'read')
    const rows = await prisma.auditEngagement.findMany({
      where: {
        ...alive, ...(await clientScopeWhere(session, scope)),
        status: { in: ['signed', 'archived'] }, reportDate: { not: null },
        udins: { none: { revokedAt: null } },
      },
      orderBy: { reportDate: 'asc' },
    })
    const [clients, names] = await Promise.all([
      clientsById(rows.map((e) => e.clientId)),
      employeeNames(rows.flatMap((e) => [e.signingPartnerId, e.managerId, e.lockedBy, e.acceptanceApprovedBy])),
    ])
    ok(res, S.list(rows.map((e) => S.engagement(e, { client: clients.get(e.clientId) ?? null, names }))))
  }))

  r.get('/udins', handler(async (req, res) => {
    const { session, scope } = access(req, 'read')
    const q = parse(z.object({
      from: ISO_DATE.optional(), to: ISO_DATE.optional(), client_id: z.string().optional(),
      partner_id: z.string().optional(), include_revoked: z.string().optional(),
    }), req.query, 'Invalid filters.')
    const where: Prisma.AuditUdinWhereInput = {
      ...(await clientScopeWhere(session, scope)),
      ...(q.client_id ? { AND: [{ clientId: q.client_id }] } : {}),
      ...(q.partner_id ? { partnerId: q.partner_id } : {}),
      ...(q.from || q.to ? { documentDate: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
      ...(q.include_revoked === '1' || q.include_revoked === 'true' ? {} : { revokedAt: null }),
    }
    const rows = await prisma.auditUdin.findMany({ where, include: { engagement: { select: { auditCode: true } } }, orderBy: [{ documentDate: 'desc' }, { createdAt: 'desc' }] })
    const [clients, names] = await Promise.all([clientsById(rows.map((u) => u.clientId)), employeeNames(rows.map((u) => u.partnerId))])
    ok(res, S.list(rows.map((u) => S.udin(u, { clients, names }))))
  }))

  r.post('/udins', handler(async (req, res) => {
    const { session, scope } = access(req, 'manage')
    const b = parse(z.object({
      client_id: z.string().min(1, 'Choose the client.'),
      engagement_id: z.string().nullish(),
      udin: z.string().trim().toUpperCase(),
      document_type: z.enum(DOC_TYPES),
      document_description: z.string().trim().max(500).nullish(),
      document_date: ISO_DATE,
      partner_id: z.string().nullish(),
      membership_no: z.string().trim().regex(/^\d{1,6}$/, 'A membership number is up to 6 digits.'),
      generated_on: ISO_DATE,
    }), req.body, 'Invalid UDIN.')
    await assertCanSeeClient(session, scope, b.client_id)
    const client = await prisma.client.findFirst({ where: { id: b.client_id, ...alive }, select: { organisationId: true } })
    if (!client) throw ApiError.notFound('Client not found.')
    if (b.engagement_id) {
      const e = await prisma.auditEngagement.findFirst({ where: { id: b.engagement_id, ...alive }, select: { clientId: true } })
      if (!e || e.clientId !== b.client_id) throw ApiError.badRequest('That audit file is not for this client.', { engagement_id: 'Not for this client.' })
    }
    await assertEmployee(b.partner_id, 'partner_id')
    validateUdin(b.udin, b.membership_no)
    const row = await prisma.auditUdin.create({
      data: {
        organisationId: client.organisationId, engagementId: b.engagement_id ?? null, clientId: b.client_id, udin: b.udin,
        documentType: b.document_type, documentDescription: b.document_description ?? null, documentDate: b.document_date,
        partnerId: b.partner_id ?? null, membershipNo: b.membership_no.padStart(6, '0'), generatedOn: b.generated_on, createdBy: session.userId,
      },
      include: { engagement: { select: { auditCode: true } } },
    }).catch((err) => {
      if (isUniqueViolation(err)) throw ApiError.conflict('udin_exists', 'That UDIN is already in the register.')
      throw err
    })
    await audit(req, session, 'udin_record', 'AuditUdin', row.id, undefined, { udin: row.udin, client_id: row.clientId, engagement_id: row.engagementId, document_type: row.documentType })
    ok(res, S.udin(row, { clients: await clientsById([row.clientId]), names: await employeeNames([row.partnerId]) }), 201)
  }))

  r.post('/udins/:udinId/revoke', handler(async (req, res) => {
    const { session, scope } = access(req, 'manage')
    const b = parse(z.object({ reason: z.string().trim().min(1, 'Give the reason for revoking.').max(1000) }), req.body, 'Give the reason for revoking.')
    const row = await prisma.auditUdin.findUnique({ where: { id: req.params.udinId } })
    if (!row) throw ApiError.notFound('UDIN not found.')
    await assertCanSeeClient(session, scope, row.clientId)
    if (row.revokedAt) throw ApiError.conflict('already_revoked', 'This UDIN is already revoked.')
    const updated = await prisma.auditUdin.update({
      where: { id: row.id }, data: { revokedAt: new Date(), revokedReason: b.reason }, include: { engagement: { select: { auditCode: true } } },
    })
    await audit(req, session, 'udin_revoke', 'AuditUdin', row.id, { revoked_at: null }, { revoked_at: updated.revokedAt, reason: b.reason })
    ok(res, S.udin(updated, { clients: await clientsById([row.clientId]), names: await employeeNames([row.partnerId]) }))
  }))
}
