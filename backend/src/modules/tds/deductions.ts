/**
 * TDS DEDUCTEE REGISTER — who the client pays, what was deducted, and the
 * certificates and declarations that change the rate.
 *
 *   GET    /api/tds/:clientId/register?fy=&tan=         everything for the register screen
 *   POST   /api/tds/:clientId/deductions/preview        what the rules give for a payment (nothing saved)
 *   POST | PATCH | DELETE  /api/tds/:clientId/deductees[/:id]
 *   POST | PATCH | DELETE  /api/tds/:clientId/lower-certificates[/:id]
 *   POST | PATCH | DELETE  /api/tds/:clientId/declarations[/:id]
 *   POST | PATCH | DELETE  /api/tds/:clientId/deductions[/:id]
 *   GET    /api/tds/:clientId/deductions/export?fy=&quarter=&form=&tan=   CSV for the return software
 *
 * The server computes the expected TDS on every save (sections.ts) and
 * stores it beside what was actually deducted, so short deduction is
 * visible on the row and on the month's challan. The firm's figure always
 * wins — the calculator only proposes.
 */
import type { Request, Router } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { requireWorkstation } from '../../platform/workstation/scope.js'
import { body, FieldErrors } from '../workstation/validate.js'
import { fyMonths, fyOf, QUARTERS, todayIst, type Quarter } from './calendar.js'
import { computeTds, REMARK_CODE, returnFormFor, SECTIONS, sectionByCode, type Basis, type DeducteeCategory } from './sections.js'

type Session = ReturnType<typeof requireSession>
type Scope = 'self' | 'department' | 'organisation'
interface ScopedClientLike { id: string; companyName: string; tan: string | null; tans: string[] }
export interface RegisterHelpers<C extends ScopedClientLike> {
  assertClient: (session: Session, scope: Scope, clientId: string) => Promise<C>
  resolveTan: (client: C, requested: unknown) => string | null
  storedTan: (client: C, tan: string | null) => string | null
  tanWhere: (client: C, tan: string | null) => Prisma.TdsFilingWhereInput
}

const READ = ['workstation.service.read', 'workstation.service.manage'] as const
const MANAGE = ['workstation.service.manage'] as const
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const FY_RE = /^\d{4}-\d{2}$/
const n = (d: Prisma.Decimal | null) => (d === null ? null : Number(d))
const dec = (v: number) => new Prisma.Decimal(v.toFixed(2))

// ── field readers ─────────────────────────────────────────────────────────
function reader(b: Record<string, unknown>, e: FieldErrors, partial: boolean) {
  const has = (k: string) => b[k] !== undefined
  return {
    has,
    text(k: string, max: number, required = false): string | null | undefined {
      if (!has(k)) { if (required && !partial) e.add(k, 'Required.'); return undefined }
      const v = b[k]
      if (v === null || v === '') { if (required) e.add(k, 'Required.'); return null }
      if (typeof v !== 'string') { e.add(k, 'Must be text.'); return undefined }
      const t = v.trim()
      if (t.length > max) { e.add(k, `Max ${max} characters.`); return undefined }
      return t
    },
    date(k: string, required = false, label = 'Date'): string | null | undefined {
      if (!has(k) || b[k] === null || b[k] === '') { if (required && (!partial || has(k))) e.add(k, 'Required.'); return has(k) ? null : undefined }
      const v = b[k]
      if (typeof v !== 'string' || !DATE_RE.test(v)) { e.add(k, 'Date must be YYYY-MM-DD.'); return undefined }
      return v
    },
    money(k: string, required = false): number | null | undefined {
      if (!has(k) || b[k] === null || b[k] === '') { if (required && (!partial || has(k))) e.add(k, 'Required.'); return has(k) ? null : undefined }
      const num = typeof b[k] === 'number' ? (b[k] as number) : Number(b[k])
      if (!Number.isFinite(num) || num < 0 || num > 1e12) { e.add(k, 'Must be a non-negative amount.'); return undefined }
      return Math.round(num * 100) / 100
    },
    pick<T extends string>(k: string, options: readonly T[], required = false): T | null | undefined {
      if (!has(k) || b[k] === null || b[k] === '') { if (required && !partial) e.add(k, 'Required.'); return has(k) ? null : undefined }
      if (!(options as readonly unknown[]).includes(b[k])) { e.add(k, `Must be one of ${options.join(', ')}.`); return undefined }
      return b[k] as T
    },
    pan(k: string): string | null | undefined {
      if (!has(k) || b[k] === null || b[k] === '') return has(k) ? null : undefined
      const v = typeof b[k] === 'string' ? (b[k] as string).trim().toUpperCase() : ''
      if (!PAN_RE.test(v)) { e.add(k, 'PAN must be 5 letters, 4 digits, 1 letter.'); return undefined }
      return v
    },
  }
}
const defined = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>

// ── API shapes ────────────────────────────────────────────────────────────
type DeducteeRow = Awaited<ReturnType<typeof prisma.tdsDeductee.findFirstOrThrow>>
type CertRow = Awaited<ReturnType<typeof prisma.tdsLowerCertificate.findFirstOrThrow>>
type DeclRow = Awaited<ReturnType<typeof prisma.tdsDeclaration.findFirstOrThrow>>
type DedRow = Awaited<ReturnType<typeof prisma.tdsDeduction.findFirstOrThrow>>
const deducteeApi = (d: DeducteeRow) => ({ id: d.id, name: d.name, pan: d.pan, category: d.category, residency: d.residency, email: d.email, notes: d.notes })
const certApi = (c: CertRow) => ({ id: c.id, deductee_id: c.deducteeId, certificate_no: c.certificateNo, section: c.section, rate: Number(c.rate), valid_from: c.validFrom, valid_to: c.validTo, amount_limit: n(c.amountLimit) })
const declApi = (d: DeclRow) => ({ id: d.id, deductee_id: d.deducteeId, fy: d.fy, form: d.form, received_on: d.receivedOn, estimated_income: n(d.estimatedIncome), uin: d.uin })
const dedApi = (d: DedRow) => {
  const expected = n(d.expectedTds)
  const actual = Number(d.tdsAmount)
  return {
    id: d.id, tan: d.tan, fy: d.fy, month: d.month, deductee_id: d.deducteeId, section: d.section,
    payment_date: d.paymentDate, deduction_date: d.deductionDate, amount_paid: Number(d.amountPaid),
    expected_tds: expected, tds_amount: actual, rate_pct: n(d.ratePct), basis: d.basis,
    invoice_ref: d.invoiceRef, notes: d.notes,
    /** Positive = deducted less than the rules give. */
    shortfall: expected === null ? 0 : Math.round((expected - actual) * 100) / 100,
  }
}

// ── the calculation, with the register's own history ─────────────────────
async function expectedFor(clientId: string, deducteeId: string, section: string, deductionDate: string, amount: number, exceptId?: string) {
  const deductee = await prisma.tdsDeductee.findFirst({ where: { id: deducteeId, clientId, deletedAt: null } })
  if (!deductee) throw ApiError.badRequest('Choose a deductee of this client.', { deductee_id: 'Unknown deductee.' })
  const fy = fyOf(deductionDate)
  const [prior, declaration, certs] = await Promise.all([
    prisma.tdsDeduction.aggregate({
      where: { clientId, deducteeId, section, fy, deletedAt: null, deductionDate: { lte: deductionDate }, ...(exceptId ? { id: { not: exceptId } } : {}) },
      _sum: { amountPaid: true },
    }),
    prisma.tdsDeclaration.findFirst({ where: { clientId, deducteeId, fy, deletedAt: null } }),
    prisma.tdsLowerCertificate.findMany({
      where: { clientId, deducteeId, section, deletedAt: null, validFrom: { lte: deductionDate }, validTo: { gte: deductionDate } },
      orderBy: { validFrom: 'desc' },
    }),
  ])
  let lower: { rate: number; remainingLimit: number | null; certificateNo: string } | null = null
  const cert = certs[0]
  if (cert) {
    let remaining: number | null = null
    if (cert.amountLimit !== null) {
      const used = await prisma.tdsDeduction.aggregate({
        where: { clientId, deducteeId, section, deletedAt: null, deductionDate: { gte: cert.validFrom, lte: cert.validTo }, ...(exceptId ? { id: { not: exceptId } } : {}) },
        _sum: { amountPaid: true },
      })
      remaining = Number(cert.amountLimit) - Number(used._sum.amountPaid ?? 0)
    }
    lower = { rate: Number(cert.rate), remainingLimit: remaining, certificateNo: cert.certificateNo }
  }
  const result = computeTds({
    section,
    category: deductee.category as DeducteeCategory,
    hasPan: Boolean(deductee.pan),
    amount,
    priorFyTotal: Number(prior._sum.amountPaid ?? 0),
    declaration: Boolean(declaration),
    lowerCertificate: lower,
  })
  return { deductee, result, lowerCertificateNo: lower?.certificateNo ?? null, declaration: declaration ? declaration.form : null }
}

export function registerDeductionRoutes<C extends ScopedClientLike>(router: Router, h: RegisterHelpers<C>): void {
  const ctx = async (req: Request, write: boolean) => {
    const session = requireSession(req)
    const scope = requireWorkstation(session, ...(write ? MANAGE : READ))
    const client = await h.assertClient(session, scope, req.params.clientId)
    return { session, client }
  }

  // ── read everything the register screen needs ──
  router.get('/:clientId/register', handler(async (req, res) => {
    const { client } = await ctx(req, false)
    const fy = typeof req.query.fy === 'string' && FY_RE.test(req.query.fy) ? req.query.fy : fyOf(todayIst())
    const tan = h.resolveTan(client, req.query.tan)
    const tanFilter = tan && tan !== client.tan ? { tan } : { OR: [{ tan: null }, ...(client.tan ? [{ tan: client.tan }] : [])] }
    const [deductees, certs, decls, deductions, challans] = await Promise.all([
      prisma.tdsDeductee.findMany({ where: { clientId: client.id, deletedAt: null }, orderBy: { name: 'asc' } }),
      prisma.tdsLowerCertificate.findMany({ where: { clientId: client.id, deletedAt: null }, orderBy: { validFrom: 'desc' } }),
      prisma.tdsDeclaration.findMany({ where: { clientId: client.id, deletedAt: null }, orderBy: { receivedOn: 'desc' } }),
      prisma.tdsDeduction.findMany({ where: { clientId: client.id, fy, deletedAt: null, AND: [tanFilter] }, orderBy: [{ deductionDate: 'desc' }, { createdAt: 'desc' }] }),
      prisma.tdsFiling.findMany({ where: { clientId: client.id, kind: 'challan', fy, deletedAt: null, AND: [h.tanWhere(client, tan)] }, select: { period: true, amountTax: true } }),
    ])
    const challanTax = new Map(challans.map((c) => [c.period, n(c.amountTax)]))
    const months = fyMonths(fy).map((m) => {
      const rows = deductions.filter((d) => d.month === m)
      const deducted = rows.reduce((s, d) => s + Number(d.tdsAmount), 0)
      const expected = rows.reduce((s, d) => s + Number(d.expectedTds ?? d.tdsAmount), 0)
      const deposited = challanTax.get(m) ?? null
      return {
        month: m, entries: rows.length, deducted, expected,
        deposited, difference: deposited === null ? null : Math.round((deposited - deducted) * 100) / 100,
      }
    })
    ok(res, {
      fy, active_tan: tan,
      sections: SECTIONS.map((s) => ({ code: s.code, label: s.label, rate_individual: s.rateIndividual, rate_other: s.rateOther, return_form: s.returnForm, declaration_allowed: Boolean(s.declarationAllowed) })),
      deductees: deductees.map(deducteeApi),
      lower_certificates: certs.map(certApi),
      declarations: decls.map(declApi),
      deductions: deductions.map(dedApi),
      months,
    })
  }))

  // ── deductees ──
  const parseDeductee = (b: Record<string, unknown>, partial: boolean) => {
    const e = new FieldErrors()
    const r = reader(b, e, partial)
    const data = defined({
      name: r.text('name', 150, true),
      pan: r.pan('pan'),
      category: r.pick('category', ['individual_huf', 'other'] as const, true),
      residency: r.pick('residency', ['resident', 'non_resident'] as const),
      email: r.text('email', 150),
      notes: r.text('notes', 1000),
    })
    e.throwIfAny()
    return data
  }
  router.post('/:clientId/deductees', handler(async (req, res) => {
    const { session, client } = await ctx(req, true)
    const data = parseDeductee(body(req), false)
    if (data.pan && await prisma.tdsDeductee.findFirst({ where: { clientId: client.id, pan: data.pan, deletedAt: null } })) {
      throw ApiError.conflict('duplicate', `A deductee with PAN ${data.pan} already exists.`, { pan: 'Already in the register.' })
    }
    const row = await prisma.tdsDeductee.create({ data: { clientId: client.id, ...(data as { name: string }), createdBy: session.userId, updatedBy: session.userId } })
    await writeAudit({ actorUserId: session.userId, action: 'tds_deductee.create', entityType: 'tds_deductee', entityId: row.id, after: { clientId: client.id, ...data }, req })
    ok(res, { deductee: deducteeApi(row) }, 201)
  }))
  router.patch('/:clientId/deductees/:id', handler(async (req, res) => {
    const { session, client } = await ctx(req, true)
    const row = await prisma.tdsDeductee.findFirst({ where: { id: req.params.id, clientId: client.id, deletedAt: null } })
    if (!row) throw ApiError.notFound('Deductee not found.')
    const data = parseDeductee(body(req), true)
    if (data.pan && await prisma.tdsDeductee.findFirst({ where: { clientId: client.id, pan: data.pan, deletedAt: null, id: { not: row.id } } })) {
      throw ApiError.conflict('duplicate', `A deductee with PAN ${data.pan} already exists.`, { pan: 'Already in the register.' })
    }
    // Validation above rejects a blank name / category, so no nulls reach these columns.
    const saved = await prisma.tdsDeductee.update({ where: { id: row.id }, data: { ...(data as Prisma.TdsDeducteeUncheckedUpdateInput), updatedBy: session.userId } })
    await writeAudit({ actorUserId: session.userId, action: 'tds_deductee.update', entityType: 'tds_deductee', entityId: row.id, before: deducteeApi(row), after: data, req })
    ok(res, { deductee: deducteeApi(saved) })
  }))
  router.delete('/:clientId/deductees/:id', handler(async (req, res) => {
    const { session, client } = await ctx(req, true)
    const row = await prisma.tdsDeductee.findFirst({ where: { id: req.params.id, clientId: client.id, deletedAt: null } })
    if (!row) throw ApiError.notFound('Deductee not found.')
    const used = await prisma.tdsDeduction.count({ where: { deducteeId: row.id, deletedAt: null } })
    if (used) throw ApiError.conflict('in_use', `${row.name} has ${used} deduction${used === 1 ? '' : 's'} recorded — delete those first.`)
    await prisma.tdsDeductee.update({ where: { id: row.id }, data: { deletedAt: new Date(), updatedBy: session.userId } })
    await writeAudit({ actorUserId: session.userId, action: 'tds_deductee.delete', entityType: 'tds_deductee', entityId: row.id, before: deducteeApi(row), req })
    ok(res, { deleted: true })
  }))

  // ── lower-deduction certificates (Form 13 / s. 197) ──
  const parseCert = async (clientId: string, b: Record<string, unknown>, partial: boolean, row?: CertRow) => {
    const e = new FieldErrors()
    const r = reader(b, e, partial)
    const data = defined({
      deducteeId: r.text('deductee_id', 64, true) ?? undefined,
      certificateNo: r.text('certificate_no', 40, true) ?? undefined,
      section: r.pick('section', SECTIONS.map((s) => s.code), true) ?? undefined,
      rate: r.money('rate', true),
      validFrom: r.date('valid_from', true) ?? undefined,
      validTo: r.date('valid_to', true) ?? undefined,
      amountLimit: r.money('amount_limit'),
    })
    const rate = data.rate ?? (row ? Number(row.rate) : null)
    if (rate !== null && rate !== undefined && rate > 100) e.add('rate', 'Rate is a percentage (0–100).')
    const from = data.validFrom ?? row?.validFrom, to = data.validTo ?? row?.validTo
    if (from && to && from > to) e.add('valid_to', 'Valid to must be on or after valid from.')
    const deducteeId = data.deducteeId ?? row?.deducteeId
    if (deducteeId && !(await prisma.tdsDeductee.findFirst({ where: { id: deducteeId, clientId, deletedAt: null } }))) e.add('deductee_id', 'Unknown deductee.')
    e.throwIfAny()
    return {
      ...data,
      ...(data.rate !== undefined && data.rate !== null ? { rate: dec(data.rate) } : { rate: undefined }),
      ...(data.amountLimit !== undefined ? { amountLimit: data.amountLimit === null ? null : dec(data.amountLimit) } : {}),
    }
  }
  router.post('/:clientId/lower-certificates', handler(async (req, res) => {
    const { session, client } = await ctx(req, true)
    const data = await parseCert(client.id, body(req), false)
    const row = await prisma.tdsLowerCertificate.create({ data: { ...(data as Prisma.TdsLowerCertificateUncheckedCreateInput), clientId: client.id, createdBy: session.userId, updatedBy: session.userId } })
    await writeAudit({ actorUserId: session.userId, action: 'tds_lower_certificate.create', entityType: 'tds_lower_certificate', entityId: row.id, after: certApi(row), req })
    ok(res, { certificate: certApi(row) }, 201)
  }))
  router.patch('/:clientId/lower-certificates/:id', handler(async (req, res) => {
    const { session, client } = await ctx(req, true)
    const row = await prisma.tdsLowerCertificate.findFirst({ where: { id: req.params.id, clientId: client.id, deletedAt: null } })
    if (!row) throw ApiError.notFound('Certificate not found.')
    const data = await parseCert(client.id, body(req), true, row)
    const saved = await prisma.tdsLowerCertificate.update({ where: { id: row.id }, data: { ...defined(data), updatedBy: session.userId } })
    await writeAudit({ actorUserId: session.userId, action: 'tds_lower_certificate.update', entityType: 'tds_lower_certificate', entityId: row.id, before: certApi(row), after: certApi(saved), req })
    ok(res, { certificate: certApi(saved) })
  }))
  router.delete('/:clientId/lower-certificates/:id', handler(async (req, res) => {
    const { session, client } = await ctx(req, true)
    const row = await prisma.tdsLowerCertificate.findFirst({ where: { id: req.params.id, clientId: client.id, deletedAt: null } })
    if (!row) throw ApiError.notFound('Certificate not found.')
    await prisma.tdsLowerCertificate.update({ where: { id: row.id }, data: { deletedAt: new Date(), updatedBy: session.userId } })
    await writeAudit({ actorUserId: session.userId, action: 'tds_lower_certificate.delete', entityType: 'tds_lower_certificate', entityId: row.id, before: certApi(row), req })
    ok(res, { deleted: true })
  }))

  // ── 15G / 15H declarations ──
  const parseDecl = async (clientId: string, b: Record<string, unknown>, partial: boolean, row?: DeclRow) => {
    const e = new FieldErrors()
    const r = reader(b, e, partial)
    const fy = r.text('fy', 7, true)
    if (fy && !FY_RE.test(fy)) e.add('fy', 'FY must look like 2026-27.')
    const data = defined({
      deducteeId: r.text('deductee_id', 64, true) ?? undefined,
      fy: fy ?? undefined,
      form: r.pick('form', ['15G', '15H'] as const, true) ?? undefined,
      receivedOn: r.date('received_on', true) ?? undefined,
      estimatedIncome: r.money('estimated_income'),
      uin: r.text('uin', 30),
    })
    const received = data.receivedOn ?? row?.receivedOn
    if (received && received > todayIst()) e.add('received_on', "Received date can't be in the future.")
    const deducteeId = data.deducteeId ?? row?.deducteeId
    if (deducteeId && !(await prisma.tdsDeductee.findFirst({ where: { id: deducteeId, clientId, deletedAt: null } }))) e.add('deductee_id', 'Unknown deductee.')
    const clash = deducteeId && (data.fy ?? row?.fy) && await prisma.tdsDeclaration.findFirst({
      where: { clientId, deducteeId, fy: data.fy ?? row!.fy, deletedAt: null, ...(row ? { id: { not: row.id } } : {}) },
    })
    if (clash) e.add('fy', 'This deductee already has a declaration for that FY — edit it instead.')
    e.throwIfAny()
    return { ...data, ...(data.estimatedIncome !== undefined ? { estimatedIncome: data.estimatedIncome === null ? null : dec(data.estimatedIncome) } : {}) }
  }
  router.post('/:clientId/declarations', handler(async (req, res) => {
    const { session, client } = await ctx(req, true)
    const data = await parseDecl(client.id, body(req), false)
    const row = await prisma.tdsDeclaration.create({ data: { ...(data as Prisma.TdsDeclarationUncheckedCreateInput), clientId: client.id, createdBy: session.userId, updatedBy: session.userId } })
    await writeAudit({ actorUserId: session.userId, action: 'tds_declaration.create', entityType: 'tds_declaration', entityId: row.id, after: declApi(row), req })
    ok(res, { declaration: declApi(row) }, 201)
  }))
  router.patch('/:clientId/declarations/:id', handler(async (req, res) => {
    const { session, client } = await ctx(req, true)
    const row = await prisma.tdsDeclaration.findFirst({ where: { id: req.params.id, clientId: client.id, deletedAt: null } })
    if (!row) throw ApiError.notFound('Declaration not found.')
    const data = await parseDecl(client.id, body(req), true, row)
    const saved = await prisma.tdsDeclaration.update({ where: { id: row.id }, data: { ...data, updatedBy: session.userId } })
    await writeAudit({ actorUserId: session.userId, action: 'tds_declaration.update', entityType: 'tds_declaration', entityId: row.id, before: declApi(row), after: declApi(saved), req })
    ok(res, { declaration: declApi(saved) })
  }))
  router.delete('/:clientId/declarations/:id', handler(async (req, res) => {
    const { session, client } = await ctx(req, true)
    const row = await prisma.tdsDeclaration.findFirst({ where: { id: req.params.id, clientId: client.id, deletedAt: null } })
    if (!row) throw ApiError.notFound('Declaration not found.')
    await prisma.tdsDeclaration.update({ where: { id: row.id }, data: { deletedAt: new Date(), updatedBy: session.userId } })
    await writeAudit({ actorUserId: session.userId, action: 'tds_declaration.delete', entityType: 'tds_declaration', entityId: row.id, before: declApi(row), req })
    ok(res, { deleted: true })
  }))

  // ── deductions ──
  const parseDeduction = (b: Record<string, unknown>, partial: boolean) => {
    const e = new FieldErrors()
    const r = reader(b, e, partial)
    const today = todayIst()
    const data = defined({
      deducteeId: r.text('deductee_id', 64, true) ?? undefined,
      section: r.pick('section', SECTIONS.map((s) => s.code), true) ?? undefined,
      paymentDate: r.date('payment_date', true) ?? undefined,
      deductionDate: r.date('deduction_date', true) ?? undefined,
      amountPaid: r.money('amount_paid', true) ?? undefined,
      tdsAmount: r.money('tds_amount'),
      invoiceRef: r.text('invoice_ref', 60),
      notes: r.text('notes', 1000),
    })
    if (data.paymentDate && data.paymentDate > today) e.add('payment_date', "Payment date can't be in the future.")
    if (data.deductionDate && data.deductionDate > today) e.add('deduction_date', "Deduction date can't be in the future.")
    e.throwIfAny()
    return data
  }
  const saveDeduction = async (clientId: string, forTan: string | null, d: {
    deducteeId: string; section: string; paymentDate: string; deductionDate: string; amountPaid: number; tdsAmount: number | null | undefined
  }, exceptId?: string) => {
    const { deductee, result } = await expectedFor(clientId, d.deducteeId, d.section, d.deductionDate, d.amountPaid, exceptId)
    const rule = sectionByCode(d.section)!
    if (deductee.residency === 'non_resident' && rule.returnForm === '26Q') {
      // Non-residents are reported in 27Q; 195 is the usual section. Allowed, but flagged via the export.
    }
    const tds = d.tdsAmount ?? result.tds
    if (tds === null || tds === undefined) {
      throw ApiError.badRequest(`${rule.code} is computed case by case — enter the TDS amount.`, { tds_amount: 'Enter the TDS deducted.' })
    }
    if (tds > d.amountPaid) throw ApiError.badRequest('TDS cannot exceed the amount paid.', { tds_amount: 'More than the amount paid.' })
    return {
      tan: forTan, fy: fyOf(d.deductionDate), month: d.deductionDate.slice(0, 7),
      expectedTds: result.tds === null ? null : dec(result.tds), tdsAmount: dec(tds),
      ratePct: result.rate === null ? (d.amountPaid ? dec((tds / d.amountPaid) * 100) : null) : dec(result.rate),
      basis: (result.tds === null ? 'manual' : result.basis) as Basis,
    }
  }

  router.post('/:clientId/deductions/preview', handler(async (req, res) => {
    const { client } = await ctx(req, false)
    const b = body(req)
    const e = new FieldErrors()
    const r = reader(b, e, false)
    const deducteeId = r.text('deductee_id', 64, true)
    const section = r.pick('section', SECTIONS.map((s) => s.code), true)
    const date = r.date('deduction_date', true)
    const amount = r.money('amount_paid', true)
    const exceptId = typeof b.except_id === 'string' ? b.except_id : undefined
    e.throwIfAny()
    const { result, lowerCertificateNo, declaration, deductee } = await expectedFor(client.id, deducteeId!, section!, date!, amount!, exceptId)
    ok(res, {
      expected_tds: result.tds, rate: result.rate, basis: result.basis, note: result.note,
      lower_certificate_no: lowerCertificateNo, declaration,
      return_form: returnFormFor(section!, deductee.residency as 'resident' | 'non_resident'),
    })
  }))

  router.post('/:clientId/deductions', handler(async (req, res) => {
    const { session, client } = await ctx(req, true)
    const b = body(req)
    const data = parseDeduction(b, false)
    const tan = h.resolveTan(client, b.for_tan)
    if (!tan) throw ApiError.badRequest('Record the TAN under TDS Registration first.')
    const computed = await saveDeduction(client.id, h.storedTan(client, tan), data as Parameters<typeof saveDeduction>[2])
    const row = await prisma.tdsDeduction.create({
      data: {
        clientId: client.id, deducteeId: data.deducteeId!, section: data.section!, paymentDate: data.paymentDate!, deductionDate: data.deductionDate!,
        amountPaid: dec(data.amountPaid!), invoiceRef: data.invoiceRef ?? null, notes: data.notes ?? null, ...computed,
        createdBy: session.userId, updatedBy: session.userId,
      },
    })
    await writeAudit({ actorUserId: session.userId, action: 'tds_deduction.create', entityType: 'tds_deduction', entityId: row.id, after: dedApi(row), req })
    ok(res, { deduction: dedApi(row) }, 201)
  }))
  router.patch('/:clientId/deductions/:id', handler(async (req, res) => {
    const { session, client } = await ctx(req, true)
    const row = await prisma.tdsDeduction.findFirst({ where: { id: req.params.id, clientId: client.id, deletedAt: null } })
    if (!row) throw ApiError.notFound('Deduction not found.')
    const data = parseDeduction(body(req), true)
    const merged = {
      deducteeId: data.deducteeId ?? row.deducteeId, section: data.section ?? row.section,
      paymentDate: data.paymentDate ?? row.paymentDate, deductionDate: data.deductionDate ?? row.deductionDate,
      amountPaid: data.amountPaid ?? Number(row.amountPaid),
      // A changed amount / section / date re-proposes the TDS unless one is given.
      tdsAmount: data.tdsAmount !== undefined ? data.tdsAmount
        : (data.amountPaid !== undefined || data.section !== undefined || data.deducteeId !== undefined || data.deductionDate !== undefined) ? null
        : Number(row.tdsAmount),
    }
    const computed = await saveDeduction(client.id, row.tan, merged, row.id)
    const saved = await prisma.tdsDeduction.update({
      where: { id: row.id },
      data: {
        deducteeId: merged.deducteeId, section: merged.section, paymentDate: merged.paymentDate, deductionDate: merged.deductionDate,
        amountPaid: dec(merged.amountPaid), ...(data.invoiceRef !== undefined ? { invoiceRef: data.invoiceRef } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}), ...computed, tan: row.tan, updatedBy: session.userId,
      },
    })
    await writeAudit({ actorUserId: session.userId, action: 'tds_deduction.update', entityType: 'tds_deduction', entityId: row.id, before: dedApi(row), after: dedApi(saved), req })
    ok(res, { deduction: dedApi(saved) })
  }))
  router.delete('/:clientId/deductions/:id', handler(async (req, res) => {
    const { session, client } = await ctx(req, true)
    const row = await prisma.tdsDeduction.findFirst({ where: { id: req.params.id, clientId: client.id, deletedAt: null } })
    if (!row) throw ApiError.notFound('Deduction not found.')
    await prisma.tdsDeduction.update({ where: { id: row.id }, data: { deletedAt: new Date(), updatedBy: session.userId } })
    await writeAudit({ actorUserId: session.userId, action: 'tds_deduction.delete', entityType: 'tds_deduction', entityId: row.id, before: dedApi(row), req })
    ok(res, { deleted: true })
  }))

  // ── quarter export for the return software ──
  router.get('/:clientId/deductions/export', handler(async (req, res) => {
    const { client } = await ctx(req, false)
    const fy = typeof req.query.fy === 'string' && FY_RE.test(req.query.fy) ? req.query.fy : null
    const quarter = typeof req.query.quarter === 'string' && (QUARTERS as string[]).includes(req.query.quarter) ? (req.query.quarter as Quarter) : null
    const form = typeof req.query.form === 'string' && ['24Q', '26Q', '27Q'].includes(req.query.form) ? req.query.form : null
    if (!fy || !quarter || !form) throw ApiError.badRequest('Choose the FY, quarter and form (24Q, 26Q or 27Q).')
    const tan = h.resolveTan(client, req.query.tan)
    const months = fyMonths(fy).slice(QUARTERS.indexOf(quarter) * 3, QUARTERS.indexOf(quarter) * 3 + 3)
    const tanFilter = tan && tan !== client.tan ? { tan } : { OR: [{ tan: null }, ...(client.tan ? [{ tan: client.tan }] : [])] }
    const [rows, challans] = await Promise.all([
      prisma.tdsDeduction.findMany({
        where: { clientId: client.id, fy, month: { in: months }, deletedAt: null, AND: [tanFilter] },
        include: { deductee: true }, orderBy: [{ deductionDate: 'asc' }],
      }),
      prisma.tdsFiling.findMany({ where: { clientId: client.id, kind: 'challan', fy, period: { in: months }, deletedAt: null, AND: [h.tanWhere(client, tan)] } }),
    ])
    const certs = await prisma.tdsLowerCertificate.findMany({ where: { clientId: client.id, deletedAt: null } })
    const challanOf = new Map(challans.map((c) => [c.period, c]))
    const picked = rows.filter((d) => returnFormFor(d.section, d.deductee.residency as 'resident' | 'non_resident') === form)
    const csv = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = [[
      'Sr', 'Deductee PAN', 'Deductee name', 'Deductee type', 'Section', 'Date of payment/credit', 'Amount paid/credited',
      'Rate %', 'TDS deducted', 'Date of deduction', 'Remark code', 'Lower-deduction cert. no.', 'Challan BSR code',
      'Challan date', 'Challan serial no.', 'Invoice ref',
    ].map(csv).join(',')]
    picked.forEach((d, i) => {
      const ch = challanOf.get(d.month)
      const cert = d.basis === 'lower_certificate'
        ? certs.find((c) => c.deducteeId === d.deducteeId && c.section === d.section && c.validFrom <= d.deductionDate && c.validTo >= d.deductionDate)
        : undefined
      lines.push([
        i + 1, d.deductee.pan ?? 'PANNOTAVBL', d.deductee.name, d.deductee.category === 'individual_huf' ? 'Non-company' : 'Company / other',
        d.section, d.paymentDate, Number(d.amountPaid).toFixed(2), d.ratePct === null ? '' : Number(d.ratePct).toFixed(2),
        Number(d.tdsAmount).toFixed(2), d.deductionDate, REMARK_CODE[d.basis as Basis] ?? '', cert?.certificateNo ?? '',
        ch?.bsrCode ?? '', ch?.eventDate ?? '', ch?.reference ?? '', d.invoiceRef ?? '',
      ].map(csv).join(','))
    })
    const name = `${client.companyName.replace(/[^\w-]+/g, '_')}-${form}-${quarter}-FY${fy}.csv`
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
    res.send('﻿' + lines.join('\r\n'))
  }))
}
