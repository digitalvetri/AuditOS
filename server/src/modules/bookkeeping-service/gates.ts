/**
 * BOOKKEEPING GATE EVALUATOR (spec §4.3, §7).
 *
 * A task that asserts work was done should require evidence that it was.
 * "Reconcile Bank" cannot honestly be marked complete without a bank
 * statement on record; "Accounts reviewed" cannot without a trial balance
 * import; "Final review completed" cannot until every other task is done.
 *
 * The evaluator is DATA-driven: BookkeepingGateRule.requires is the
 * dispatch key, BookkeepingGateRule.requiresValue is its parameter.
 * Every rule has an `isEnforced` flag — false means the rule still
 * evaluates and the UI still surfaces the reason, but the API allows
 * the task to be completed anyway (spec §7 escape hatch).
 *
 * `evaluatePeriodGates` batch-fetches the evidence a period would need
 * ONCE, so evaluating all nine stage tasks on the period is a fixed
 * three queries, not O(stages).
 */
import type { PrismaClient } from '@prisma/client'
import type { BookkeepingGateRule } from '@prisma/client'

export interface GateResult {
  slug: string
  is_enforced: boolean
  passed: boolean
  reason: string | null
  action: { section: string; label: string } | null
}

export interface PeriodGateContext {
  rulesBySlug: Map<string, BookkeepingGateRule>
  /** DocumentRequest.documentType → true iff a request for that type is at least 'received'. */
  documentsReceived: Set<string>
  /** BookkeepingImport.kind → true iff a successful (status='imported') row exists. */
  importsPresent: Set<string>
  /** Every stage task's status keyed by task id, so all_other_tasks_complete does not re-fetch. */
  taskStatusById: Map<string, string>
}

/**
 * One round-trip per evidence bucket. Called by the period-detail route
 * and by PATCH /tasks/:id, so the cost is amortised across every task
 * decision on a period rather than paid per-task.
 */
export async function loadPeriodGateContext(
  prisma: PrismaClient,
  periodId: string,
): Promise<PeriodGateContext> {
  const [rules, documentRequests, imports, stageTasks] = await Promise.all([
    prisma.bookkeepingGateRule.findMany({}),
    prisma.bookkeepingDocumentRequest.findMany({
      where: {
        periodId, deletedAt: null,
        status: { in: ['received', 'under_review', 'accepted'] },
      },
      select: { documentType: true },
    }),
    prisma.bookkeepingImport.findMany({
      where: { periodId, status: 'imported' },
      select: { kind: true },
    }),
    prisma.bookkeepingTask.findMany({
      where: { periodId, deletedAt: null, stageId: { not: null } },
      select: { id: true, status: true },
    }),
  ])
  return {
    rulesBySlug: new Map(rules.map((r) => [r.slug, r])),
    documentsReceived: new Set(documentRequests.map((d) => d.documentType)),
    importsPresent: new Set(imports.map((i) => i.kind)),
    taskStatusById: new Map(stageTasks.map((t) => [t.id, t.status])),
  }
}

/**
 * Evaluate one gate rule against a period's evidence and (for the
 * "final review" rule) against the tasks around this one.
 *
 * A task with no gate slug returns `null` — the checkbox is always
 * enabled. A task whose gate slug does not exist in the config also
 * returns `null` (with a warning-worthy log line): the safe default is
 * "no gate" rather than "silently blocked".
 */
export function evaluateGate(
  ctx: PeriodGateContext,
  input: { gateRuleSlug: string | null; taskId: string },
): GateResult | null {
  if (!input.gateRuleSlug) return null
  const rule = ctx.rulesBySlug.get(input.gateRuleSlug)
  if (!rule) {
    console.warn(`[bookkeeping] unknown gate rule slug: ${input.gateRuleSlug}`)
    return null
  }

  const action = rule.actionSection && rule.actionLabel
    ? { section: rule.actionSection, label: rule.actionLabel }
    : null

  switch (rule.requires) {
    case 'document': {
      const kind = rule.requiresValue ?? ''
      const has = ctx.documentsReceived.has(kind)
      return {
        slug: rule.slug,
        is_enforced: rule.isEnforced,
        passed: has,
        reason: has ? null : `${rule.description} — no ${prettyDocument(kind)} received for this period.`,
        action,
      }
    }
    case 'import': {
      const kind = rule.requiresValue ?? ''
      const has = ctx.importsPresent.has(kind)
      return {
        slug: rule.slug,
        is_enforced: rule.isEnforced,
        passed: has,
        reason: has ? null : `${rule.description} — no ${prettyImport(kind)} import for this period.`,
        action,
      }
    }
    case 'all_other_tasks_complete': {
      const incomplete: string[] = []
      for (const [id, status] of ctx.taskStatusById) {
        if (id === input.taskId) continue
        // Only completed and cancelled count as "not blocking". Blocked
        // and pending both count as work still to do — a blocked task
        // cannot mask the final review as ready.
        if (status !== 'completed' && status !== 'cancelled') incomplete.push(id)
      }
      const passed = incomplete.length === 0
      return {
        slug: rule.slug,
        is_enforced: rule.isEnforced,
        passed,
        reason: passed
          ? null
          : `${rule.description} — ${incomplete.length} task${incomplete.length === 1 ? '' : 's'} still incomplete.`,
        action,
      }
    }
    default:
      console.warn(`[bookkeeping] unknown gate rule 'requires' value: ${rule.requires}`)
      return null
  }
}

function prettyImport(kind: string): string {
  return kind.replace(/_/g, ' ')
}

function prettyDocument(type: string): string {
  return type.replace(/_/g, ' ')
}
