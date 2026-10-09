/**
 * JSON.stringify throws on a bigint. Client-books money columns are BigInt
 * (int8), so a raw Prisma row handed to an audit log, an activity entry or
 * a response would otherwise fail. Integer paise are exact as a JSON number
 * up to 2^53, so they are written as plain numbers — the same shape the
 * rest of the API already uses for paise.
 */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? Number(value) : value
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, bigintReplacer)
}
