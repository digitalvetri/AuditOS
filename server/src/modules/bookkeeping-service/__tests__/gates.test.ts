import { describe, expect, it } from 'vitest'
import { evaluateGate, type PeriodGateContext } from '../gates.js'
import type { BookkeepingGateRule } from '@prisma/client'

/**
 * Every rule branch of the gate evaluator, tested against a hand-built
 * context so the tests need no database. The route handler owns the
 * DB round-trips (`loadPeriodGateContext`), so keeping the evaluator
 * pure is what makes these tests possible.
 */
function rule(over: Partial<BookkeepingGateRule>): BookkeepingGateRule {
  return {
    slug: 'x',
    description: 'x',
    requires: 'document',
    requiresValue: null,
    isEnforced: true,
    actionSection: 'data',
    actionLabel: 'Open Data',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }
}

function ctx(over: Partial<PeriodGateContext> = {}): PeriodGateContext {
  return {
    rulesBySlug: over.rulesBySlug ?? new Map(),
    documentsReceived: over.documentsReceived ?? new Set(),
    importsPresent: over.importsPresent ?? new Set(),
    taskStatusById: over.taskStatusById ?? new Map(),
  }
}

describe('bookkeeping/gates — no slug / unknown slug', () => {
  it('returns null when the task carries no gate slug', () => {
    expect(evaluateGate(ctx(), { gateRuleSlug: null, taskId: 't1' })).toBeNull()
  })
  it('returns null when the slug is not in config (fails open, safe default)', () => {
    expect(evaluateGate(ctx(), { gateRuleSlug: 'missing', taskId: 't1' })).toBeNull()
  })
})

describe('bookkeeping/gates — requires: document', () => {
  const r = rule({ slug: 'bank_doc', requires: 'document', requiresValue: 'bank_statement' })
  const rulesBySlug = new Map([[r.slug, r]])

  it('passes when the document is received', () => {
    const g = evaluateGate(
      ctx({ rulesBySlug, documentsReceived: new Set(['bank_statement']) }),
      { gateRuleSlug: 'bank_doc', taskId: 't1' },
    )
    expect(g).toEqual({
      slug: 'bank_doc', is_enforced: true, passed: true, reason: null,
      action: { section: 'data', label: 'Open Data' },
    })
  })
  it('fails when the document is not received, and surfaces the reason', () => {
    const g = evaluateGate(
      ctx({ rulesBySlug }),
      { gateRuleSlug: 'bank_doc', taskId: 't1' },
    )!
    expect(g.passed).toBe(false)
    expect(g.reason).toMatch(/no bank statement received/)
  })
})

describe('bookkeeping/gates — requires: import', () => {
  const r = rule({ slug: 'tb_import', requires: 'import', requiresValue: 'trial_balance' })
  const rulesBySlug = new Map([[r.slug, r]])

  it('passes when the import is present', () => {
    const g = evaluateGate(
      ctx({ rulesBySlug, importsPresent: new Set(['trial_balance']) }),
      { gateRuleSlug: 'tb_import', taskId: 't1' },
    )!
    expect(g.passed).toBe(true)
  })
  it('fails when the import is missing and mentions the kind', () => {
    const g = evaluateGate(
      ctx({ rulesBySlug }),
      { gateRuleSlug: 'tb_import', taskId: 't1' },
    )!
    expect(g.passed).toBe(false)
    expect(g.reason).toMatch(/trial balance/)
  })
})

describe('bookkeeping/gates — requires: all_other_tasks_complete', () => {
  const r = rule({ slug: 'final', requires: 'all_other_tasks_complete', requiresValue: null })
  const rulesBySlug = new Map([[r.slug, r]])

  it('passes when every OTHER task is completed or cancelled', () => {
    const g = evaluateGate(
      ctx({
        rulesBySlug,
        taskStatusById: new Map([
          ['t1', 'pending'],   // <-- the task being evaluated
          ['t2', 'completed'],
          ['t3', 'cancelled'],
        ]),
      }),
      { gateRuleSlug: 'final', taskId: 't1' },
    )!
    expect(g.passed).toBe(true)
  })
  it('fails when any other task is still open (pending / in_progress / blocked)', () => {
    const g = evaluateGate(
      ctx({
        rulesBySlug,
        taskStatusById: new Map([
          ['t1', 'pending'],
          ['t2', 'completed'],
          ['t3', 'blocked'],   // <-- blocking t1
        ]),
      }),
      { gateRuleSlug: 'final', taskId: 't1' },
    )!
    expect(g.passed).toBe(false)
    expect(g.reason).toMatch(/1 task/)
  })
  it('does not count the task ITSELF as an obstacle to its own completion', () => {
    // A one-task period should still be able to complete its final review;
    // the evaluator explicitly skips input.taskId.
    const g = evaluateGate(
      ctx({
        rulesBySlug,
        taskStatusById: new Map([['t1', 'pending']]),
      }),
      { gateRuleSlug: 'final', taskId: 't1' },
    )!
    expect(g.passed).toBe(true)
  })
})

describe('bookkeeping/gates — is_enforced flag', () => {
  it('carries through is_enforced=false so the caller knows to allow completion', () => {
    const r = rule({
      slug: 'bank_doc',
      requires: 'document',
      requiresValue: 'bank_statement',
      isEnforced: false,
    })
    const g = evaluateGate(
      ctx({ rulesBySlug: new Map([[r.slug, r]]) }),
      { gateRuleSlug: 'bank_doc', taskId: 't1' },
    )!
    expect(g.passed).toBe(false)   // reason still surfaces
    expect(g.is_enforced).toBe(false)
    expect(g.reason).not.toBeNull()
  })
})
