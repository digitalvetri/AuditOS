/**
 * Template renderer for DocTemplate bodies (POST-DELIVERY-CHANGES §D2 + §D3).
 *
 * Grammar is deliberately small — the editor is an auditor, not a
 * template programmer:
 *
 *   {{firm.name}}              simple placeholder, dot-path
 *   {{partner.pan}}            works for any object / nested path
 *   {{#partners}}              repeating block OPEN
 *     {{name}} {{age}}         inside, 'name' resolves against the CURRENT item
 *     {{address}}              (not the outer scope)
 *   {{/partners}}              repeating block CLOSE
 *   {{^partners}}…{{/partners}} "empty" block — renders when the list is empty
 *
 * A reference to a path that doesn't resolve to a scalar renders as the
 * empty string. We don't throw: a partially-filled template is still
 * worth drafting. The UI surfaces unresolved placeholders separately
 * so a preparer can see what's missing.
 *
 * Pure. Same (body, values) in → same string out.
 */

export type RenderValue = string | number | boolean | null | undefined | RenderObject | RenderValue[]
export interface RenderObject { [k: string]: RenderValue }

const OPEN_RE = /\{\{\s*([#^])\s*([a-zA-Z_][\w.]*)\s*\}\}/g
const CLOSE_RE = /\{\{\s*\/\s*([a-zA-Z_][\w.]*)\s*\}\}/g
const VAR_RE = /\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g

export interface RenderResult {
  text: string
  /** Placeholders the template asked for that didn't resolve. Useful for
   *  the review UI to mark unfilled fields BEFORE the firm sends the paper. */
  unresolved: string[]
}

/** Dot-path lookup, scope-aware. Returns undefined when the path is dead. */
export function lookup(path: string, scopes: RenderObject[]): RenderValue | undefined {
  const parts = path.split('.')
  for (let i = scopes.length - 1; i >= 0; i--) {
    let cur: RenderValue | undefined = scopes[i]
    let ok = true
    for (const p of parts) {
      if (cur && typeof cur === 'object' && !Array.isArray(cur) && p in cur) {
        cur = (cur as RenderObject)[p]
      } else { ok = false; break }
    }
    if (ok) return cur
  }
  return undefined
}

/** Render a scalar value — numbers/booleans stringify; null/undefined → ''. */
function toText(v: RenderValue | undefined): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  // Objects / arrays never flatten to text — a placeholder that points at
  // one is a mistake the UI should surface via `unresolved`, not a JSON blob
  // printed in the paper.
  return ''
}

/**
 * Parse the body into a tree of nodes the walker can expand. Produces
 * either a `text` leaf, a `var` leaf, or a `block` node with an array
 * of children and its own kind ('#' loop, '^' empty).
 */
type Node =
  | { kind: 'text'; value: string }
  | { kind: 'var'; path: string; raw: string }
  | { kind: 'block'; mode: '#' | '^'; path: string; children: Node[] }

function parse(body: string): Node[] {
  // Collect every tag with its index and length, then walk.
  interface Tag { index: number; length: number; kind: '#' | '^' | '/' | 'var'; path: string; raw: string }
  const tags: Tag[] = []
  // Opens
  for (const m of body.matchAll(OPEN_RE)) {
    tags.push({ index: m.index!, length: m[0].length, kind: m[1] as '#' | '^', path: m[2], raw: m[0] })
  }
  for (const m of body.matchAll(CLOSE_RE)) {
    tags.push({ index: m.index!, length: m[0].length, kind: '/', path: m[1], raw: m[0] })
  }
  // Vars (skip positions already claimed by blocks; the open/close alternatives
  // and the var regex overlap, so dedupe by starting index).
  const claimed = new Set(tags.map((t) => t.index))
  for (const m of body.matchAll(VAR_RE)) {
    if (claimed.has(m.index!)) continue
    tags.push({ index: m.index!, length: m[0].length, kind: 'var', path: m[1], raw: m[0] })
  }
  tags.sort((a, b) => a.index - b.index)

  // Walk forwards building the tree.
  const root: Node[] = []
  const stack: Node[][] = [root]
  const openStack: Array<{ path: string; mode: '#' | '^' }> = []
  let cursor = 0
  for (const tag of tags) {
    if (tag.index < cursor) continue // overlap guard
    const current = stack[stack.length - 1]
    if (tag.index > cursor) current.push({ kind: 'text', value: body.slice(cursor, tag.index) })
    if (tag.kind === '#' || tag.kind === '^') {
      const block: Node = { kind: 'block', mode: tag.kind, path: tag.path, children: [] }
      current.push(block)
      stack.push(block.children)
      openStack.push({ path: tag.path, mode: tag.kind })
    } else if (tag.kind === '/') {
      const opened = openStack.pop()
      if (!opened || opened.path !== tag.path) {
        // Mismatched close. Render it literally rather than throwing —
        // a half-authored template is still worth previewing.
        current.push({ kind: 'text', value: tag.raw })
      } else {
        stack.pop()
      }
    } else {
      current.push({ kind: 'var', path: tag.path, raw: tag.raw })
    }
    cursor = tag.index + tag.length
  }
  if (cursor < body.length) stack[stack.length - 1].push({ kind: 'text', value: body.slice(cursor) })
  // Dangling opens render their children inline but mark the whole block
  // unresolved (the walker treats them as if the open wasn't there).
  while (openStack.length) {
    openStack.pop()
    stack.pop()
  }
  return root
}

function walk(nodes: Node[], scopes: RenderObject[], unresolved: Set<string>): string {
  let out = ''
  for (const n of nodes) {
    if (n.kind === 'text') { out += n.value; continue }
    if (n.kind === 'var') {
      const v = lookup(n.path, scopes)
      const scalar = toText(v)
      if (scalar === '' && (v === undefined || typeof v === 'object')) unresolved.add(n.path)
      out += scalar
      continue
    }
    // block
    const target = lookup(n.path, scopes)
    const isEmpty = target === undefined || target === null || target === false
      || (Array.isArray(target) && target.length === 0)
      || (typeof target === 'object' && !Array.isArray(target) && Object.keys(target as object).length === 0)
    if (n.mode === '^') {
      if (isEmpty) out += walk(n.children, scopes, unresolved)
      continue
    }
    // n.mode === '#'
    if (isEmpty) {
      unresolved.add(n.path)
      continue
    }
    if (Array.isArray(target)) {
      for (const item of target) {
        const scope = typeof item === 'object' && item !== null && !Array.isArray(item)
          ? item as RenderObject
          : { '.': item } as RenderObject
        out += walk(n.children, [...scopes, scope], unresolved)
      }
    } else if (typeof target === 'object') {
      out += walk(n.children, [...scopes, target as RenderObject], unresolved)
    } else {
      // Truthy scalar — render the children once, no scope push.
      out += walk(n.children, scopes, unresolved)
    }
  }
  return out
}

/** Render a template body against a field-values object. */
export function renderTemplate(body: string, values: RenderObject): RenderResult {
  const unresolved = new Set<string>()
  const text = walk(parse(body), [values], unresolved)
  return { text, unresolved: [...unresolved].sort() }
}

/**
 * Assemble a composed document from a template and the preparer's picks:
 * for each clause, use the selected variant's body, falling back to the
 * clause's default variant when none is chosen. Returns the rendered text
 * plus every unresolved placeholder across the template body and every
 * selected variant — one call, one review.
 */
export interface ComposeInput {
  template: { body: string }
  clauses: Array<{
    id: string
    clauseCode: string
    clauseTitle: string
    sortOrder: number
    required: boolean
    variants: Array<{ id: string; label: string; body: string; isDefault: boolean }>
  }>
  /** Clause.id → Variant.id. Missing entries fall back to the clause's default. */
  chosenVariants: Record<string, string>
  values: RenderObject
}

export interface ComposeResult {
  text: string
  /** Required clauses with no variant chosen and no default available. */
  missingRequired: string[]
  unresolved: string[]
}

export function composeDocument(input: ComposeInput): ComposeResult {
  const unresolved = new Set<string>()
  const missingRequired: string[] = []

  // Template body first.
  const bodyOut = walk(parse(input.template.body), [input.values], unresolved)

  // Clauses in sort order, each on its chosen (or default) variant.
  const clauses = [...input.clauses].sort((a, b) => a.sortOrder - b.sortOrder)
  const parts: string[] = [bodyOut]
  for (const c of clauses) {
    const chosen = input.chosenVariants[c.id]
    const variant = (chosen && c.variants.find((v) => v.id === chosen))
      || c.variants.find((v) => v.isDefault)
      || null
    if (!variant) {
      if (c.required) missingRequired.push(c.clauseCode)
      continue
    }
    parts.push(walk(parse(variant.body), [input.values], unresolved))
  }

  return { text: parts.filter((p) => p !== '').join('\n\n'), missingRequired, unresolved: [...unresolved].sort() }
}
