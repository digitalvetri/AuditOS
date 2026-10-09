import path from 'node:path'
import type { AuditEngagement, Prisma } from '@prisma/client'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import type { Session } from '../../platform/auth.js'
import type { Scope } from '../../platform/rbac/matrix.js'
import { assertCanSeeClient } from '../../platform/workstation/scope.js'
import { LocalStorageAdapter } from '../tools/storage/LocalStorageAdapter.js'
import type { StorageAdapter } from '../tools/storage/StorageAdapter.js'

/**
 * AUDIT FILES — shared rules (docs/audit-files/README.md).
 *
 * One AuditEngagement per client × financial year × audit type. Visibility
 * is the client's: a file is seen by whoever may see its client. After the
 * lock every write is refused with 423, except an addendum (SA 230 A24).
 */

export const STATUSES = ['planning', 'fieldwork', 'review', 'reporting', 'signed', 'archived'] as const
export const PRE_SIGN = ['planning', 'fieldwork', 'review', 'reporting'] as const

/** Bytes behind working-paper evidence. AUDIT_FILES_STORAGE_ROOT overrides the root. */
export const auditStorage: StorageAdapter = new LocalStorageAdapter(process.env.AUDIT_FILES_STORAGE_ROOT
  ? path.resolve(process.env.AUDIT_FILES_STORAGE_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'audit-files'))

/** The caller's employee id — every sign-off on an audit file is a person's. */
export function me(session: Session): string {
  if (!session.employeeId) throw ApiError.forbidden('Your login is not linked to an employee, so it cannot sign off audit work.')
  return session.employeeId
}

/** 404 when the file does not exist, 403 when its client is not the caller's. */
export async function loadFile(session: Session, scope: Scope, id: string): Promise<AuditEngagement> {
  const row = await prisma.auditEngagement.findFirst({ where: { id, ...alive } })
  if (!row) throw ApiError.notFound('Audit file not found.')
  await assertCanSeeClient(session, scope, row.clientId)
  return row
}

export const isSigningPartner = (e: AuditEngagement, session: Session) =>
  !!session.employeeId && e.signingPartnerId === session.employeeId
export const isManager = (e: AuditEngagement, session: Session) =>
  !!session.employeeId && e.managerId === session.employeeId

export interface WriteMode { addendum: boolean; reason: string | null }

/**
 * Every write on a file goes through this. Before the lock it is a normal
 * write. After it, 423 `file_locked` — unless the route accepts an addendum
 * and the body carries `{ addendum: true, addendum_reason }` from the signing
 * partner or the manager.
 */
export function guardWrite(e: AuditEngagement, session: Session, body: unknown, allowAddendum = false): WriteMode {
  if (!e.lockedAt) return { addendum: false, reason: null }
  const b = (body ?? {}) as Record<string, unknown>
  const wants = b.addendum === true || b.addendum === 'true' || b.addendum === '1'
  if (!wants || !allowAddendum) {
    throw new ApiError(423, 'file_locked', allowAddendum
      ? 'This audit file is locked. Add this as an addendum (with a reason) if it must be recorded.'
      : 'This audit file is locked and cannot be changed.')
  }
  if (!isSigningPartner(e, session) && !isManager(e, session)) {
    throw ApiError.forbidden('Only the signing partner or the manager can add an addendum to a locked file.')
  }
  const reason = typeof b.addendum_reason === 'string' ? b.addendum_reason.trim() : ''
  if (!reason) throw ApiError.badRequest('Give the reason for the addendum.', { addendum_reason: 'Required.' })
  return { addendum: true, reason }
}

// ── Lookups ─────────────────────────────────────────────────────────────────

export interface EmployeeRef { id: string; full_name: string; employee_code: string }

/** Employees by id as `{ id, full_name, employee_code }` — the Workstation employee triple. */
export async function employeeNames(ids: (string | null | undefined)[]): Promise<Map<string, EmployeeRef>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))]
  if (!list.length) return new Map()
  const rows = await prisma.employee.findMany({ where: { id: { in: list } }, select: { id: true, fullName: true, employeeCode: true } })
  return new Map(rows.map((r) => [r.id, { id: r.id, full_name: r.fullName, employee_code: r.employeeCode }]))
}

export async function clientsById(ids: string[]) {
  const rows = await prisma.client.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, clientCode: true, companyName: true, pan: true },
  })
  return new Map(rows.map((r) => [r.id, r]))
}

export async function assertEmployee(id: string | null | undefined, field: string) {
  if (!id) return
  const e = await prisma.employee.findFirst({ where: { id, ...alive }, select: { id: true } })
  if (!e) throw ApiError.badRequest('Employee not found.', { [field]: 'Employee not found.' })
}

// ── Checklists ──────────────────────────────────────────────────────────────

export const appliesTo = (t: { appliesTo: string }, type: string) =>
  t.appliesTo.split(',').map((s) => s.trim()).some((s) => s === type || s === 'all')

/** Active templates with their clauses. */
export async function activeTemplates() {
  return prisma.auditChecklistTemplate.findMany({
    where: { isActive: true },
    include: { items: { select: { clause: true }, orderBy: { sortOrder: 'asc' } } },
    orderBy: { code: 'asc' },
  })
}

// ── Progress and blockers ───────────────────────────────────────────────────

export interface Progress {
  working_papers: { total: number; prepared: number; reviewed: number }
  review_notes_open: number
  observations_open: number
  checklist_pending: number
  team_undeclared: number
}

interface Detail {
  progress: Progress
  unreviewedRefs: string[]
  undeclared: string[]
  pendingByTemplate: { code: string; name: string; pending: number }[]
}

/** Progress (and what feeds the blockers) for many files at once. */
export async function progressFor(files: Pick<AuditEngagement, 'id' | 'auditType'>[]): Promise<Map<string, Detail>> {
  const ids = files.map((f) => f.id)
  const out = new Map<string, Detail>()
  if (!ids.length) return out
  const [papers, notes, obs, team, answered, templates] = await Promise.all([
    prisma.auditWorkingPaper.findMany({ where: { engagementId: { in: ids }, ...alive }, select: { engagementId: true, ref: true, status: true }, orderBy: { ref: 'asc' } }),
    prisma.auditReviewNote.groupBy({ by: ['engagementId'], where: { engagementId: { in: ids }, ...alive, status: { not: 'cleared' } }, _count: true }),
    prisma.auditObservation.groupBy({ by: ['engagementId'], where: { engagementId: { in: ids }, ...alive, status: { notIn: ['resolved', 'carried_forward'] } }, _count: true }),
    prisma.auditTeamMember.findMany({ where: { engagementId: { in: ids }, ...alive, independenceDeclaredAt: null }, select: { engagementId: true, employeeId: true } }),
    prisma.auditChecklistResponse.findMany({ where: { engagementId: { in: ids }, answer: { not: 'pending' } }, select: { engagementId: true, templateCode: true, clause: true } }),
    activeTemplates(),
  ])
  const names = await employeeNames(team.map((t) => t.employeeId))
  const done = new Set(answered.map((a) => `${a.engagementId}|${a.templateCode}|${a.clause}`))
  for (const f of files) {
    const wps = papers.filter((p) => p.engagementId === f.id)
    const pendingByTemplate = templates.filter((t) => appliesTo(t, f.auditType)).map((t) => ({
      code: t.code, name: t.name,
      pending: t.items.filter((i) => !done.has(`${f.id}|${t.code}|${i.clause}`)).length,
    }))
    const undeclared = team.filter((t) => t.engagementId === f.id)
    out.set(f.id, {
      progress: {
        working_papers: {
          total: wps.length,
          prepared: wps.filter((p) => p.status === 'prepared' || p.status === 'reviewed').length,
          reviewed: wps.filter((p) => p.status === 'reviewed').length,
        },
        review_notes_open: notes.find((n) => n.engagementId === f.id)?._count ?? 0,
        observations_open: obs.find((n) => n.engagementId === f.id)?._count ?? 0,
        checklist_pending: pendingByTemplate.reduce((s, t) => s + t.pending, 0),
        team_undeclared: undeclared.length,
      },
      unreviewedRefs: wps.filter((p) => p.status !== 'reviewed').map((p) => p.ref),
      undeclared: undeclared.map((t) => names.get(t.employeeId)?.full_name ?? t.employeeId),
      pendingByTemplate: pendingByTemplate.filter((t) => t.pending > 0),
    })
  }
  return out
}

export interface Blocker { code: string; message: string; count: number; items: string[] }

/** What still stops the signing partner from signing. Empty = ready. */
export function blockersOf(e: AuditEngagement, d: Detail): Blocker[] {
  const b: Blocker[] = []
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  if (!e.acceptanceApprovedAt) {
    b.push({ code: 'acceptance_not_approved', message: 'Client acceptance has not been approved by a partner.', count: 1, items: [] })
  }
  if (d.unreviewedRefs.length) {
    b.push({ code: 'working_papers_not_reviewed', message: `${plural(d.unreviewedRefs.length, 'working paper is', 'working papers are')} not reviewed.`, count: d.unreviewedRefs.length, items: d.unreviewedRefs })
  }
  if (d.progress.review_notes_open) {
    b.push({ code: 'review_notes_open', message: `${plural(d.progress.review_notes_open, 'review note is', 'review notes are')} not cleared.`, count: d.progress.review_notes_open, items: [] })
  }
  if (d.undeclared.length) {
    b.push({ code: 'independence_not_declared', message: `${plural(d.undeclared.length, 'team member has', 'team members have')} not declared independence.`, count: d.undeclared.length, items: d.undeclared })
  }
  if (d.pendingByTemplate.length) {
    const n = d.progress.checklist_pending
    b.push({ code: 'checklist_pending', message: `${plural(n, 'checklist item is', 'checklist items are')} still pending.`, count: n, items: d.pendingByTemplate.map((t) => `${t.name}: ${t.pending}`) })
  }
  return b
}

export async function blockersFor(e: AuditEngagement): Promise<Blocker[]> {
  const d = (await progressFor([e])).get(e.id)!
  return blockersOf(e, d)
}

// ── Materiality (SA 320) ────────────────────────────────────────────────────

/** A percentage string ("5", "0.5", "1.25") as an integer of 1/10000ths of a percent. */
export function pctScaled(p: number | string): bigint {
  const n = typeof p === 'number' ? p : Number(p)
  if (!Number.isFinite(n) || n < 0 || n > 100) throw ApiError.badRequest('A percentage must be between 0 and 100.')
  return BigInt(Math.round(n * 10_000))
}

/** `paise × percent`, rounded half-up to the paisa, in integer arithmetic. */
export function applyPct(paise: bigint, scaled: bigint): bigint {
  const DEN = 1_000_000n // 100 (percent) × 10_000 (scale)
  const neg = paise < 0n
  const abs = neg ? -paise : paise
  const r = (abs * scaled + DEN / 2n) / DEN
  return neg ? -r : r
}

export function computeMateriality(base: bigint, percent: number | string, performancePct: number | string, trivialPct: number | string) {
  const overall = applyPct(base, pctScaled(percent))
  return {
    overall,
    performance: applyPct(overall, pctScaled(performancePct)),
    trivial: applyPct(overall, pctScaled(trivialPct)),
  }
}

/** Normalised percent string: "5", "0.5" — never "5.0000". */
export function pctString(p: number | string): string {
  return String(Number(Number(p).toFixed(4)))
}

export type Tx = Prisma.TransactionClient
