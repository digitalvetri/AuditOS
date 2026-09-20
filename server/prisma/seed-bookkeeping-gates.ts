import type { PrismaClient } from '@prisma/client'

/**
 * The five gate rules from spec §4.3 / §7. Slug matches the value set on
 * BookkeepingWorkflowStage.gateRuleSlug in PR-1's seed, so a stage that
 * carries a slug immediately has a live rule after seeding.
 *
 * `isEnforced` starts true — spec §7 defaults to enforcement and lets the
 * firm switch a rule off, not the other way around. `actionSection` and
 * `actionLabel` are the UI shortcut when a gate fails; keeping them as
 * config so a firm can retext "Import" as "Attach bank statement" without
 * a code change.
 */
export const DEFAULT_GATE_RULES: readonly {
  slug: string
  description: string
  requires: 'document' | 'import' | 'all_other_tasks_complete'
  requiresValue: string | null
  actionSection: string | null
  actionLabel: string | null
}[] = [
  {
    slug: 'has_bank_statement_document',
    description: 'Bank statement document must be received before "Bank statement received" can be ticked.',
    requires: 'document', requiresValue: 'bank_statement',
    actionSection: 'data', actionLabel: 'Open Data to receive the document',
  },
  {
    slug: 'has_bank_statement_import',
    description: 'Bank statement import must be present before "Reconcile Bank" can be ticked.',
    requires: 'import', requiresValue: 'bank_statement',
    actionSection: 'data', actionLabel: 'Open Data to import',
  },
  {
    slug: 'has_trial_balance_import',
    description: 'Trial balance import must be present before "Review Accounts" can be ticked.',
    requires: 'import', requiresValue: 'trial_balance',
    actionSection: 'data', actionLabel: 'Open Data to import',
  },
  {
    slug: 'reports_generated',
    description: 'Reports must be available (needs a trial balance import) before "Review Reports" can be ticked.',
    requires: 'import', requiresValue: 'trial_balance',
    actionSection: 'reports', actionLabel: 'Open Reports',
  },
  {
    slug: 'all_other_tasks_complete',
    description: 'Every other stage task on this period must be completed before Final Review.',
    requires: 'all_other_tasks_complete', requiresValue: null,
    actionSection: 'checklist', actionLabel: 'Back to checklist',
  },
]

export async function seedBookkeepingGateRules(prisma: PrismaClient): Promise<number> {
  for (const r of DEFAULT_GATE_RULES) {
    await prisma.bookkeepingGateRule.upsert({
      where: { slug: r.slug },
      update: {
        description: r.description,
        requires: r.requires,
        requiresValue: r.requiresValue,
        actionSection: r.actionSection,
        actionLabel: r.actionLabel,
      },
      create: {
        slug: r.slug,
        description: r.description,
        requires: r.requires,
        requiresValue: r.requiresValue,
        isEnforced: true,
        actionSection: r.actionSection,
        actionLabel: r.actionLabel,
      },
    })
  }
  return DEFAULT_GATE_RULES.length
}
