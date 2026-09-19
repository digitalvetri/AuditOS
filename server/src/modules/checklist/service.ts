import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import type { Session } from '../../platform/auth.js'
import type { Scope } from '../../platform/rbac/matrix.js'
import { assertCanSeeClient, clientIdWhere } from '../../platform/workstation/scope.js'
import { employeeMap } from '../../api/workstation.serialize.js'
import {
  CHECKLIST_STATUSES, DEFAULT_CATEGORIES, DEFAULT_SERVICES, type ChecklistKind, type ChecklistStatus,
} from './catalog.js'

/**
 * CHECKLIST SERVICE — the only writer of the three checklist tables.
 *
 * The rule the whole module exists to enforce: THE MASTER CATALOGUE AND A
 * CLIENT'S WORK ARE DIFFERENT ROWS. Nothing here writes a status, assignee or
 * due date onto a ChecklistService, and nothing writes a client's item into
 * the catalogue — except the one explicit path in `addItem({ addToMaster })`,
 * which creates a NEW master row and then a client row pointing at it.
 *
 * `overdue` is derived on read, never stored (see `displayStatus`).
 */

const todayISO = (now = new Date()): string => now.toISOString().slice(0, 10)

/** Past its due date and not finished — a fact about today, so never stored. */
function displayStatus(row: { status: string; dueDate: string | null }, today: string): string {
  if (row.status === 'completed' || row.status === 'not_required') return row.status
  if (row.dueDate && row.dueDate < today) return 'overdue'
  return row.status
}

async function orgIdFor(clientId: string): Promise<string> {
  const c = await prisma.client.findFirst({ where: { id: clientId, deletedAt: null }, select: { organisationId: true } })
  if (!c) throw ApiError.notFound('Client not found.')
  return c.organisationId
}

/**
 * Seed the master catalogue once per organisation, idempotently.
 *
 * Called on every catalogue read rather than from a seed script, so a fresh
 * database — or a database that pre-dates this module — is correct the first
 * time anyone opens the screen. Upserts by (org, kind, name): a user's edits
 * to name-matched rows survive, their own rows are never touched.
 */
export async function ensureCatalog(organisationId: string, kind: ChecklistKind): Promise<void> {
  const existing = await prisma.checklistService.count({ where: { organisationId, kind } })
  if (existing > 0) return

  for (const [i, c] of DEFAULT_CATEGORIES.entries()) {
    await prisma.checklistCategory.upsert({
      where: { organisationId_kind_name: { organisationId, kind, name: c.name } },
      update: {},
      create: { organisationId, kind, name: c.name, description: c.description, sortOrder: i },
    })
  }
  const cats = await prisma.checklistCategory.findMany({ where: { organisationId, kind }, select: { id: true, name: true } })
  const byName = new Map(cats.map((c) => [c.name, c.id]))

  for (const [i, s] of DEFAULT_SERVICES.entries()) {
    await prisma.checklistService.upsert({
      where: { organisationId_kind_name: { organisationId, kind, name: s.name } },
      update: {},
      create: {
        organisationId, kind, slug: s.slug, name: s.name, code: s.code,
        categoryId: byName.get(s.category) ?? null,
        serviceType: s.serviceType, defaultFrequency: s.defaultFrequency,
        description: s.description, sortOrder: i,
      },
    })
  }
}

// ── Serialisers ───────────────────────────────────────────────────────────

const categoryToApi = (c: { id: string; name: string; description: string | null; active: boolean }) => ({
  id: c.id, name: c.name, description: c.description, active: c.active,
})

const serviceToApi = (s: {
  id: string; slug: string | null; name: string; code: string | null; categoryId: string | null
  serviceType: string; defaultFrequency: string; description: string | null; active: boolean; isCustom: boolean
}) => ({
  id: s.id, slug: s.slug, name: s.name, code: s.code, category_id: s.categoryId,
  service_type: s.serviceType, default_frequency: s.defaultFrequency,
  description: s.description, active: s.active, is_custom: s.isCustom,
})

type ItemRow = Awaited<ReturnType<typeof loadItems>>[number]

function loadItems(clientId: string, kind: ChecklistKind) {
  return prisma.clientChecklistItem.findMany({
    where: { clientId, kind, deletedAt: null },
    include: { service: true, category: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  })
}

function itemToApi(i: ItemRow, names: Map<string, { id: string; full_name: string }>, today: string) {
  return {
    id: i.id,
    client_id: i.clientId,
    service_id: i.serviceId,
    category_id: i.categoryId,
    name: i.customName ?? i.service?.name ?? 'Untitled item',
    code: i.service?.code ?? null,
    category_name: i.category?.name ?? null,
    description: i.description ?? i.service?.description ?? null,
    is_custom: i.serviceId === null,
    /** Stored status — what a write may set. */
    stored_status: i.status,
    /** What the screen shows: stored, or 'overdue' when past due. */
    status: displayStatus(i, today),
    is_overdue: displayStatus(i, today) === 'overdue',
    assigned_to: i.assignedToId ? names.get(i.assignedToId) ?? null : null,
    due_date: i.dueDate,
    frequency: i.frequency,
    notes: i.notes,
    completed_at: i.completedAt?.toISOString() ?? null,
    created_at: i.createdAt.toISOString(),
    updated_at: i.updatedAt.toISOString(),
  }
}

/**
 * §14 — progress over APPLICABLE work only. 'Not required' is excluded from
 * both sides of the fraction, so marking something not required moves the bar
 * up rather than leaving a client permanently short of 100%.
 */
function summarise(items: ReturnType<typeof itemToApi>[]) {
  const count = (s: string) => items.filter((i) => i.status === s).length
  const applicable = items.filter((i) => i.status !== 'not_required').length
  const completed = count('completed')
  return {
    total: items.length,
    completed,
    in_progress: count('in_progress'),
    pending: count('pending'),
    overdue: count('overdue'),
    not_started: count('not_started'),
    not_required: count('not_required'),
    applicable,
    progress_percent: applicable === 0 ? 0 : Math.round((completed / applicable) * 100),
  }
}

async function activity(itemId: string, action: string, detail: string | null, session: Session) {
  await prisma.clientChecklistActivity.create({
    data: { itemId, action, detail, actorId: session.employeeId ?? null, actorName: session.employeeFullName ?? null },
  })
}

// ── The module's public surface ───────────────────────────────────────────

export const Checklists = {
  /** Master catalogue: categories + services. Never client data. */
  async catalog(organisationId: string, kind: ChecklistKind) {
    await ensureCatalog(organisationId, kind)
    const [categories, services] = await Promise.all([
      prisma.checklistCategory.findMany({ where: { organisationId, kind, deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      prisma.checklistService.findMany({ where: { organisationId, kind, deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    ])
    return { categories: categories.map(categoryToApi), services: services.map(serviceToApi) }
  },

  async addCategory(session: Session, organisationId: string, kind: ChecklistKind, input: { name: string; description: string | null }) {
    await ensureCatalog(organisationId, kind)
    const clash = await prisma.checklistCategory.findFirst({ where: { organisationId, kind, name: input.name, deletedAt: null } })
    if (clash) throw ApiError.badRequest('A category with that name already exists.')
    const max = await prisma.checklistCategory.aggregate({ where: { organisationId, kind }, _max: { sortOrder: true } })
    const row = await prisma.checklistCategory.create({
      data: {
        organisationId, kind, name: input.name, description: input.description,
        sortOrder: (max._max.sortOrder ?? 0) + 1, createdBy: session.userId, updatedBy: session.userId,
      },
    })
    return categoryToApi(row)
  },

  /** One client's checklist, with the summary the dashboard renders. */
  async list(session: Session, scope: Scope, clientId: string, kind: ChecklistKind) {
    await assertCanSeeClient(session, scope, clientId)
    const rows = await loadItems(clientId, kind)
    const names = await employeeMap(rows.map((r) => r.assignedToId))
    const today = todayISO()
    const items = rows.map((r) => itemToApi(r, names, today))
    return { items, summary: summarise(items) }
  },

  /**
   * EVERY client's checklist at a glance — the cross-client view that hangs
   * off Workstation → Services → GST.
   *
   * Still one row per client, computed from that client's OWN items: this is
   * a report over the client tables, not a status living on the catalogue.
   * Clients out of the caller's scope are not counted, not merely hidden.
   */
  async overview(session: Session, scope: Scope, kind: ChecklistKind) {
    const where = await clientIdWhere(session, scope)
    const clients = await prisma.client.findMany({
      where: { ...where, deletedAt: null },
      select: { id: true, clientCode: true, companyName: true, gstin: true },
      orderBy: { companyName: 'asc' },
    })
    const rows = await prisma.clientChecklistItem.findMany({
      where: { kind, deletedAt: null, clientId: { in: clients.map((c) => c.id) } },
      include: { service: true },
    })

    const today = todayISO()
    const names = await employeeMap(rows.map((r) => r.assignedToId))
    const byClient = new Map<string, ReturnType<typeof itemToApi>[]>()
    for (const r of rows) {
      const list = byClient.get(r.clientId) ?? []
      list.push(itemToApi(r as ItemRow, names, today))
      byClient.set(r.clientId, list)
    }

    const items = clients.map((c) => {
      const own = byClient.get(c.id) ?? []
      const next = own
        .filter((i) => i.due_date && i.status !== 'completed' && i.status !== 'not_required')
        .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))[0]
      return {
        client_id: c.id,
        client_code: c.clientCode,
        client_name: c.companyName,
        gstin: c.gstin,
        has_checklist: own.length > 0,
        summary: summarise(own),
        next_due: next ? { name: next.name, due_date: next.due_date, status: next.status } : null,
      }
    })

    const all = [...byClient.values()].flat()
    return {
      items,
      totals: {
        ...summarise(all),
        clients: items.length,
        clients_with_checklist: items.filter((i) => i.has_checklist).length,
      },
    }
  },

  async get(session: Session, scope: Scope, clientId: string, kind: ChecklistKind, id: string) {
    await assertCanSeeClient(session, scope, clientId)
    const row = await prisma.clientChecklistItem.findFirst({
      where: { id, clientId, kind, deletedAt: null },
      include: { service: true, category: true },
    })
    if (!row) throw ApiError.notFound('Checklist item not found.')
    const names = await employeeMap([row.assignedToId])
    const acts = await prisma.clientChecklistActivity.findMany({ where: { itemId: id }, orderBy: { createdAt: 'desc' }, take: 50 })
    return {
      ...itemToApi(row, names, todayISO()),
      activity: acts.map((a) => ({
        id: a.id, action: a.action, detail: a.detail,
        actor_name: a.actorName, at: a.createdAt.toISOString(),
      })),
    }
  },

  /**
   * §4 — first-time setup. Adds only the services the user ticked; a service
   * already on the checklist is skipped rather than duplicated.
   */
  async initialize(session: Session, scope: Scope, clientId: string, kind: ChecklistKind, serviceIds: string[]) {
    await assertCanSeeClient(session, scope, clientId)
    const organisationId = await orgIdFor(clientId)
    await ensureCatalog(organisationId, kind)

    const services = await prisma.checklistService.findMany({
      where: { id: { in: serviceIds }, organisationId, kind, deletedAt: null },
    })
    const existing = await prisma.clientChecklistItem.findMany({
      where: { clientId, kind, serviceId: { in: services.map((s) => s.id) }, deletedAt: null },
      select: { serviceId: true },
    })
    const have = new Set(existing.map((e) => e.serviceId))

    for (const [i, s] of services.entries()) {
      if (have.has(s.id)) continue
      const item = await prisma.clientChecklistItem.create({
        data: {
          organisationId, kind, clientId, serviceId: s.id, categoryId: s.categoryId,
          frequency: s.defaultFrequency, sortOrder: i,
          createdBy: session.userId, updatedBy: session.userId,
        },
      })
      await activity(item.id, 'created', `Added from the ${kind.toUpperCase()} master catalogue.`, session)
    }
    return this.list(session, scope, clientId, kind)
  },

  /**
   * §5 and §6 — add one master service, or a custom item. `addToMaster`
   * creates the catalogue row FIRST and then links to it, so a custom item
   * promoted to the catalogue is a normal linked item afterwards.
   */
  async addItem(session: Session, scope: Scope, clientId: string, kind: ChecklistKind, input: {
    serviceId: string | null
    name: string | null
    categoryId: string | null
    description: string | null
    frequency: string
    dueDate: string | null
    assignedToId: string | null
    notes: string | null
    addToMaster: boolean
  }) {
    await assertCanSeeClient(session, scope, clientId)
    const organisationId = await orgIdFor(clientId)
    await ensureCatalog(organisationId, kind)

    let serviceId = input.serviceId
    let categoryId = input.categoryId
    let frequency = input.frequency

    if (serviceId) {
      const s = await prisma.checklistService.findFirst({ where: { id: serviceId, organisationId, kind, deletedAt: null } })
      if (!s) throw ApiError.notFound('That service is not in the master catalogue.')
      const dup = await prisma.clientChecklistItem.findFirst({ where: { clientId, kind, serviceId, deletedAt: null } })
      if (dup) throw ApiError.badRequest(`${s.name} is already on this client's checklist.`)
      categoryId = categoryId ?? s.categoryId
      frequency = input.frequency || s.defaultFrequency
    } else {
      if (!input.name) throw ApiError.badRequest('Give the checklist item a name.')
      if (input.addToMaster) {
        const clash = await prisma.checklistService.findFirst({ where: { organisationId, kind, name: input.name, deletedAt: null } })
        if (clash) throw ApiError.badRequest('A master service with that name already exists — add it from the picker instead.')
        const created = await prisma.checklistService.create({
          data: {
            organisationId, kind, name: input.name, categoryId, description: input.description,
            defaultFrequency: frequency, isCustom: true, serviceType: 'project',
            createdBy: session.userId, updatedBy: session.userId,
          },
        })
        serviceId = created.id
      }
    }

    const max = await prisma.clientChecklistItem.aggregate({ where: { clientId, kind }, _max: { sortOrder: true } })
    const item = await prisma.clientChecklistItem.create({
      data: {
        organisationId, kind, clientId, serviceId,
        customName: serviceId && !input.addToMaster ? null : input.name,
        categoryId, description: input.description, frequency,
        dueDate: input.dueDate, assignedToId: input.assignedToId, notes: input.notes,
        sortOrder: (max._max.sortOrder ?? 0) + 1,
        createdBy: session.userId, updatedBy: session.userId,
      },
    })
    await activity(item.id, 'created', serviceId ? 'Added from the master catalogue.' : 'Custom checklist item.', session)
    if (input.assignedToId) await activity(item.id, 'assigned', null, session)
    return this.get(session, scope, clientId, kind, item.id)
  },

  /** Every editable field of ONE client's item. Touches no other client. */
  async update(session: Session, scope: Scope, clientId: string, kind: ChecklistKind, id: string, patch: {
    status?: ChecklistStatus
    assignedToId?: string | null
    dueDate?: string | null
    frequency?: string
    notes?: string | null
    description?: string | null
    categoryId?: string | null
    name?: string | null
  }) {
    await assertCanSeeClient(session, scope, clientId)
    const before = await prisma.clientChecklistItem.findFirst({ where: { id, clientId, kind, deletedAt: null } })
    if (!before) throw ApiError.notFound('Checklist item not found.')

    if (patch.status && !(CHECKLIST_STATUSES as readonly string[]).includes(patch.status)) {
      throw ApiError.badRequest('Unknown status.')
    }

    const data: Record<string, unknown> = { updatedBy: session.userId }
    if (patch.status !== undefined) {
      data.status = patch.status
      // completed_at belongs to the server's clock, not the browser's.
      data.completedAt = patch.status === 'completed' ? (before.completedAt ?? new Date()) : null
    }
    if (patch.assignedToId !== undefined) data.assignedToId = patch.assignedToId
    if (patch.dueDate !== undefined) data.dueDate = patch.dueDate
    if (patch.frequency !== undefined) data.frequency = patch.frequency
    if (patch.notes !== undefined) data.notes = patch.notes
    if (patch.description !== undefined) data.description = patch.description
    if (patch.categoryId !== undefined) data.categoryId = patch.categoryId
    if (patch.name !== undefined && before.serviceId === null) data.customName = patch.name

    await prisma.clientChecklistItem.update({ where: { id }, data })

    if (patch.status !== undefined && patch.status !== before.status) {
      const action = patch.status === 'completed' ? 'completed' : 'status_changed'
      await activity(id, action, `${before.status} → ${patch.status}`, session)
    }
    if (patch.assignedToId !== undefined && patch.assignedToId !== before.assignedToId) {
      await activity(id, 'assigned', patch.assignedToId ? null : 'Unassigned.', session)
    }
    if (patch.dueDate !== undefined && patch.dueDate !== before.dueDate) {
      await activity(id, 'due_date_changed', `${before.dueDate ?? '—'} → ${patch.dueDate ?? '—'}`, session)
    }
    return this.get(session, scope, clientId, kind, id)
  },

  /** Removes the item from THIS client only; the master service is untouched. */
  async remove(session: Session, scope: Scope, clientId: string, kind: ChecklistKind, id: string) {
    await assertCanSeeClient(session, scope, clientId)
    const row = await prisma.clientChecklistItem.findFirst({ where: { id, clientId, kind, deletedAt: null } })
    if (!row) throw ApiError.notFound('Checklist item not found.')
    await prisma.clientChecklistItem.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: session.userId } })
  },
}
