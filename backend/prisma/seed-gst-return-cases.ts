/**
 * GST Returns — one-shot migration of the demo GstCompliancePeriod rows
 * onto the shared partnership engine.
 *
 * The pre-rebuild flat-panel flow stored each period as
 *   GstCompliancePeriod  (one per client × month)
 *     ├── GstFiling GSTR-1  (with ARN, taxable value, tax)
 *     ├── GstFiling GSTR-3B (with liability, ITC, net payable)
 *     └── GstR2BRecord      (with ITC statement + reconciliation state)
 *
 * The rebuild's case model is one PartnershipCase per (client × return kind
 * × period) — three per compliance period. This function walks the existing
 * period rows, opens the corresponding cases if they don't already exist,
 * copies the master template into case-owned rows, and carries over ARN +
 * figures so §9-3's client list shows the demo data instead of a blank
 * page.
 *
 * Idempotent — the (clientId, kind, period) unique index means a re-run
 * only opens cases that are still missing. Safe on every `docker compose
 * up` even without the opt-in gst-compliance seed.
 */
import type { PrismaClient, Prisma } from '@prisma/client'
import { KINDS } from '../src/modules/partnership/constants.js'

type ReturnKind = 'GSTR1' | 'GSTR2B' | 'GSTR3B'

const paise = (n: bigint | null | undefined) => (n === null || n === undefined ? null : Number(n))

function nextCaseCode(existing: string[], prefix: string, year: number): string {
  const p = `${prefix}-${year}-`
  let max = 0
  for (const c of existing) {
    if (!c.startsWith(p)) continue
    const n = Number(c.slice(p.length))
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${p}${String(max + 1).padStart(4, '0')}`
}

export async function migrateGstReturnCases(prisma: PrismaClient): Promise<{ opened: Record<ReturnKind, number>; skipped: number; gateBackfill: number }> {
  const opened: Record<ReturnKind, number> = { GSTR1: 0, GSTR2B: 0, GSTR3B: 0 }
  let skipped = 0

  // Every compliance period that has a client — the ones without a client
  // are orphaned demo rows and get no case.
  const periods = await prisma.gstCompliancePeriod.findMany({
    where: { deletedAt: null },
    include: {
      gstProfile: { select: { clientId: true } },
      filings: { where: { deletedAt: null } },
      r2b: true,
    },
  })

  // One case code counter across the whole migration, per prefix.
  const allCases = await prisma.partnershipCase.findMany({ select: { caseCode: true } })
  const codeIndex = allCases.map((c) => c.caseCode)

  for (const p of periods) {
    if (!p.gstProfile?.clientId) { skipped += 1; continue }
    const clientId = p.gstProfile.clientId
    const year = Number(p.financialYear.slice(0, 4))
    // periodType coming off the compliance row was written from the profile
    // at creation; we honour it here.
    const periodType = p.periodType === 'quarterly' ? 'quarterly' : 'monthly'

    for (const kind of ['GSTR1', 'GSTR2B', 'GSTR3B'] as const) {
      const already = await prisma.partnershipCase.findFirst({
        where: { clientId, kind, period: p.period, deletedAt: null },
        select: { id: true },
      })
      if (already) { skipped += 1; continue }

      // Build detailsJson from the matching legacy row, when one exists.
      let dueDate: string | null = null
      let detailsJson: string | null = null
      if (kind === 'GSTR1' || kind === 'GSTR3B') {
        const returnType = kind === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'
        const f = p.filings.find((x) => x.returnType === returnType)
        if (f) {
          const d: Record<string, unknown> = {
            arn: f.arn ?? null,
            filed_at: f.filedAt ? f.filedAt.toISOString().slice(0, 10) : null,
            filed_by_user_id: f.filedByUserId ?? null,
            receipt_document_id: null,
            taxable_value_paise: null,
            tax_paise: null,
            itc_finalised_paise: null,
          }
          if (kind === 'GSTR1') {
            d.taxable_value_paise = paise(f.taxableValue)
            d.tax_paise = paise(f.taxAmount)
          } else {
            d.tax_paise = paise(f.taxLiability)
            d.itc_finalised_paise = paise(f.eligibleItc)
          }
          detailsJson = JSON.stringify(d)
          dueDate = f.dueDate ?? p.nextDueDate ?? null
        } else {
          dueDate = p.nextDueDate ?? null
        }
      }
      if (kind === 'GSTR2B') {
        if (p.r2b) {
          const itc = paise(p.r2b.totalItcCgst)! + paise(p.r2b.totalItcSgst)! + paise(p.r2b.totalItcIgst)! + paise(p.r2b.totalItcCess)!
          detailsJson = JSON.stringify({
            arn: null, taxable_value_paise: null, tax_paise: null,
            itc_finalised_paise: p.r2b.status === 'reconciliation_completed' ? itc : null,
            filed_at: null, filed_by_user_id: null, receipt_document_id: null,
          })
        }
      }

      const cfg = KINDS[kind]
      const caseCode = nextCaseCode(codeIndex, cfg.codePrefix, year)
      codeIndex.push(caseCode)

      // Load the master template ONCE per kind and reuse; the template is
      // stable across periods within a run.
      const template = await prisma.partnershipTemplateCategory.findMany({
        where: { kind, deletedAt: null },
        orderBy: { sortOrder: 'asc' },
        include: { items: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } } },
      })

      await prisma.$transaction(async (tx) => {
        const c = await tx.partnershipCase.create({
          data: {
            caseCode, kind, stage: cfg.stages[0],
            clientId, clientServiceId: null,
            assignedEmployeeId: p.assignedEmployeeId,
            reviewerEmployeeId: p.reviewerEmployeeId,
            approverEmployeeId: null,
            dueDate,
            period: p.period,
            periodType,
            detailsJson,
            createdBy: 'seed',
            lastActivityAt: new Date(),
          },
        })

        const docsByKey = new Map<string, { itemId: string; name: string; categoryName: string; requirement: string; condition: string | null; dueDate: string | null; docTypeOptions: string | null; maxAgeDays: number | null }>()
        let reqOrder = 0

        for (const cat of template) {
          const cc = await tx.partnershipCaseCategory.create({
            data: {
              caseId: c.id, sourceCategoryId: cat.id, name: cat.name,
              description: cat.description, stage: cat.stage, sortOrder: cat.sortOrder,
              perPartner: cat.perPartner, entityCondition: cat.entityCondition,
              createdBy: 'seed',
            },
          })
          for (const it of cat.items) {
            const ci = await tx.partnershipCaseItem.create({
              data: {
                caseId: c.id, categoryId: cc.id, sourceItemId: it.id,
                name: it.name, description: it.description, requirement: it.requirement,
                kind: it.kind, perPartner: it.perPartner, docKey: it.docKey, condition: it.condition,
                entityCondition: it.entityCondition,
                docTypeOptions: it.docTypeOptions, maxAgeDays: it.maxAgeDays,
                gateRule: it.gateRule,
                sortOrder: it.sortOrder,
                createdBy: 'seed',
              },
            })
            if (it.kind === 'DOCUMENT' && !it.perPartner && !cat.perPartner) {
              const key = it.docKey ?? `item:${ci.id}`
              if (!docsByKey.has(key)) {
                docsByKey.set(key, {
                  itemId: ci.id, name: it.name, categoryName: cat.name,
                  requirement: it.requirement, condition: it.condition,
                  dueDate: null, docTypeOptions: it.docTypeOptions, maxAgeDays: it.maxAgeDays,
                })
              }
            }
          }
        }
        for (const [key, d] of docsByKey) {
          await tx.partnershipDocRequirement.create({
            data: {
              caseId: c.id, itemId: d.itemId, docKey: key.startsWith('item:') ? null : key,
              name: d.name, categoryName: d.categoryName, requirement: d.requirement,
              condition: d.condition, dueDate: d.dueDate,
              sortOrder: (reqOrder += 10),
              docTypeOptions: d.docTypeOptions, maxAgeDays: d.maxAgeDays,
              createdBy: 'seed',
            },
          })
        }

        // Denormalised progress — the list sort/filter reads this.
        const totalItems = template.reduce((n, cat) => n + cat.items.length, 0)
        const requiredItems = template.reduce((n, cat) => n + cat.items.filter((i) => i.requirement === 'REQUIRED').length, 0)
        const docsRequired = docsByKey.size
        await tx.partnershipCase.update({
          where: { id: c.id },
          data: { itemsTotal: totalItems, itemsRequired: requiredItems, docsRequired },
        })
      })
      opened[kind] += 1
    }
  }

  // Forward-propagate gate rules from the master template onto every case
  // item that still has NULL. This lets §9-6 (case-per-period gating) work
  // on cases that were opened before gateRule existed on the schema —
  // otherwise those old cases would have blank rules forever.
  const gateBackfill = await prisma.$executeRawUnsafe(
    'UPDATE "PartnershipCaseItem" ci SET "gateRule" = ti."gateRule" FROM "PartnershipTemplateItem" ti WHERE ci."sourceItemId" = ti.id AND ti."gateRule" IS NOT NULL AND ci."gateRule" IS NULL',
  )
  return { opened, skipped, gateBackfill }
}
