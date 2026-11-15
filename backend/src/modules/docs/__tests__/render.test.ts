import { describe, expect, it } from 'vitest'
import { composeDocument, lookup, renderTemplate } from '../render.js'

describe('lookup (dot-path, scope chain)', () => {
  it('resolves a shallow key', () => {
    expect(lookup('name', [{ name: 'Acme' }])).toBe('Acme')
  })
  it('resolves a nested dot-path', () => {
    expect(lookup('firm.name', [{ firm: { name: 'Acme' } }])).toBe('Acme')
  })
  it('later scope shadows earlier', () => {
    expect(lookup('name', [{ name: 'Outer' }, { name: 'Inner' }])).toBe('Inner')
  })
  it('falls back through the chain when the current scope misses', () => {
    expect(lookup('firm.name', [{ firm: { name: 'Acme' } }, { partner: 'A' }])).toBe('Acme')
  })
  it('undefined on a dead path', () => {
    expect(lookup('firm.zzz', [{ firm: { name: 'Acme' } }])).toBeUndefined()
  })
})

describe('renderTemplate — placeholders (D2 scalar half)', () => {
  it('substitutes a simple {{var}}', () => {
    const r = renderTemplate('Hello {{name}}.', { name: 'Vikram' })
    expect(r.text).toBe('Hello Vikram.')
    expect(r.unresolved).toEqual([])
  })
  it('substitutes dot paths', () => {
    const r = renderTemplate('{{firm.name}} at {{firm.place}}.', { firm: { name: 'Sugham', place: 'Chennai' } })
    expect(r.text).toBe('Sugham at Chennai.')
  })
  it('missing keys render as empty and get reported in unresolved', () => {
    const r = renderTemplate('Hi {{who}} from {{firm}}', { firm: 'Acme' })
    // NOTE: {{firm}} -> object 'Acme' is a string here, prints fine.
    expect(r.text).toBe('Hi  from Acme')
    expect(r.unresolved).toContain('who')
  })
  it('does not stringify objects into the output', () => {
    const r = renderTemplate('Acme = {{firm}}', { firm: { name: 'Acme' } })
    expect(r.text).toBe('Acme = ')
    expect(r.unresolved).toContain('firm')
  })
})

describe('renderTemplate — repeating blocks (D2 loop half)', () => {
  const body = 'Partners: {{#partners}}[{{name}} ({{age}})]{{/partners}}.'

  it('expands over each item with its own scope', () => {
    const r = renderTemplate(body, { partners: [{ name: 'Vikram', age: '35' }, { name: 'Priya', age: '29' }] })
    expect(r.text).toBe('Partners: [Vikram (35)][Priya (29)].')
  })

  it('empty array renders empty, flags the block', () => {
    const r = renderTemplate(body, { partners: [] })
    expect(r.text).toBe('Partners: .')
    expect(r.unresolved).toContain('partners')
  })

  it('missing list renders empty, flags the block', () => {
    const r = renderTemplate(body, {})
    expect(r.unresolved).toContain('partners')
  })

  it('inverted block {{^list}} renders ONLY when the list is empty', () => {
    const b = '{{^partners}}No partners.{{/partners}}'
    expect(renderTemplate(b, { partners: [] }).text).toBe('No partners.')
    expect(renderTemplate(b, { partners: [{ name: 'A' }] }).text).toBe('')
  })

  it('outer scope is still visible inside the block via fallback', () => {
    const r = renderTemplate(
      '{{#partners}}{{firm.name}} - {{name}};{{/partners}}',
      { firm: { name: 'Sugham' }, partners: [{ name: 'A' }, { name: 'B' }] },
    )
    expect(r.text).toBe('Sugham - A;Sugham - B;')
  })

  it('inner scope shadows outer on name collision', () => {
    const r = renderTemplate(
      '{{#partners}}{{name}}{{/partners}}',
      { name: 'Firm Name', partners: [{ name: 'Partner Name' }] },
    )
    expect(r.text).toBe('Partner Name')
  })
})

describe('composeDocument (D3 — clause variants)', () => {
  const template = { body: 'DEED between {{partner1.name}} and {{partner2.name}}.\n' }
  const clauses = [
    {
      id: 'c1', clauseCode: 'profit-sharing', clauseTitle: 'Profit sharing', sortOrder: 2, required: true,
      variants: [
        { id: 'v1a', label: 'Equal shares', body: 'Profits shared equally.', isDefault: true },
        { id: 'v1b', label: 'In agreed ratio', body: 'Profits shared in ratio {{ratio}}.', isDefault: false },
      ],
    },
    {
      id: 'c2', clauseCode: 'managing-partner', clauseTitle: 'Managing partner', sortOrder: 1, required: true,
      variants: [
        { id: 'v2a', label: 'One managing partner', body: '{{partner1.name}} shall be the managing partner.', isDefault: true },
        { id: 'v2b', label: 'All partners jointly', body: 'All partners manage jointly.', isDefault: false },
      ],
    },
  ]
  const values = { partner1: { name: 'Vikram' }, partner2: { name: 'Priya' }, ratio: '60:40' }

  it('composes clauses in sort order, defaulting where unselected', () => {
    const r = composeDocument({ template, clauses, chosenVariants: {}, values })
    expect(r.text).toBe(
      'DEED between Vikram and Priya.\n\n\nVikram shall be the managing partner.\n\nProfits shared equally.'
    )
    expect(r.missingRequired).toEqual([])
    expect(r.unresolved).toEqual([])
  })

  it('honours the preparers choice when a variant is picked', () => {
    const r = composeDocument({ template, clauses, chosenVariants: { c1: 'v1b', c2: 'v2b' }, values })
    expect(r.text).toContain('All partners manage jointly.')
    expect(r.text).toContain('Profits shared in ratio 60:40.')
  })

  it('flags a required clause with no default and no choice', () => {
    const noDefault = [
      {
        id: 'c3', clauseCode: 'bank', clauseTitle: 'Bank', sortOrder: 1, required: true,
        variants: [
          { id: 'v3a', label: 'Jointly', body: 'Bank is operated jointly.', isDefault: false },
          { id: 'v3b', label: 'Singly', body: 'Bank is operated singly.', isDefault: false },
        ],
      },
    ]
    const r = composeDocument({ template, clauses: noDefault, chosenVariants: {}, values })
    expect(r.missingRequired).toEqual(['bank'])
  })

  it('optional clause with no variant chosen simply skips', () => {
    const optional = [
      {
        id: 'c4', clauseCode: 'rider', clauseTitle: 'Optional rider', sortOrder: 1, required: false,
        variants: [{ id: 'v4a', label: 'With rider', body: 'Rider text.', isDefault: false }],
      },
    ]
    const r = composeDocument({ template, clauses: optional, chosenVariants: {}, values })
    expect(r.missingRequired).toEqual([])
    expect(r.text).not.toContain('Rider text')
  })
})

describe('renderTemplate — malformed input is forgiving', () => {
  it('unclosed block does not throw; renders what it can', () => {
    const r = renderTemplate('Start {{#list}} middle', { list: [{}] })
    // The open with no close is treated as if the open wasn't there — the
    // walker just renders children in the current scope. The exact text
    // isn't the contract; the contract is "does not throw".
    expect(() => renderTemplate('Start {{#list}} middle', {})).not.toThrow()
    expect(r.text).toContain('Start')
  })

  it('mismatched close renders as literal text (defensive)', () => {
    const r = renderTemplate('A {{/bogus}} B', { a: 1 })
    expect(r.text).toContain('{{/bogus}}')
  })
})
