import type { Response } from 'express'

/**
 * Books API serialisation — the one place camelCase rows become the
 * snake_case, JSON-safe shapes the client consumes. BigInt minor units
 * become plain integers (safe up to 2^53 paise = ₹90 lakh crore), Dates
 * become ISO strings. Applied to every Books response by `okB()`.
 */
export function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

export function serialize(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'bigint') {
    const n = Number(value)
    if (!Number.isSafeInteger(n)) return value.toString()
    return n
  }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(serialize)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'passwordHash') continue
      out[/^[a-z0-9_]+$/.test(k) || k.startsWith('3_') || k.startsWith('4_') ? k : toSnake(k)] = serialize(v)
    }
    return out
  }
  return value
}

export function okB(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data: serialize(data) })
}
