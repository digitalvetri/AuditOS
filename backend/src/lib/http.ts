import type { NextFunction, Request, Response } from 'express'
import { reportError } from './errorReport.js'

/**
 * The one response envelope (Part 1 §9). Every endpoint in this server
 * answers in this shape, so `src/services/api.ts` on the frontend needs no
 * branch and no adapter.
 *
 *   Success: 2xx  { data: T }
 *   Error:   4xx  { error: { code, message, details? } }
 */
export type Envelope<T> =
  | { data: T }
  | { error: { code: string; message: string; details?: unknown } }

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message)
  }
  static badRequest(m: string, d?: unknown) { return new ApiError(400, 'validation', m, d) }
  static unauthorized(m = 'Sign in to continue.') { return new ApiError(401, 'unauthenticated', m) }
  static forbidden(m = 'Access denied.') { return new ApiError(403, 'forbidden', m) }
  static notFound(m = 'Not found.') { return new ApiError(404, 'not_found', m) }
  static conflict(code: string, m: string, d?: unknown) { return new ApiError(409, code, m, d) }
  static unprocessable(code: string, m: string, d?: unknown) { return new ApiError(422, code, m, d) }
  static tooMany(m = 'Too many attempts. Try again shortly.') { return new ApiError(429, 'rate_limited', m) }
}

export function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ data })
}

export function noContent(res: Response): void {
  res.status(204).end()
}

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function handler(
  fn: (req: Request, res: Response) => Promise<unknown> | unknown,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next)
  }
}

export function errorMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    })
    return
  }
  // Most money is stored in paise in BIGINT columns (bookkeeping, e-invoice,
  // e-way bill, bank statements), which hold far more than any real amount.
  // Some older columns — invoices, quotations, payroll, expenses, payments —
  // are still 32-bit, so one amount there above ₹2,14,74,836.47 cannot be
  // saved. Say which limit was hit, plainly, instead of a bare 500.
  const overflow = integerOverflow(err)
  if (overflow) {
    res.status(422).json({
      error: {
        code: 'amount_too_large',
        message: overflow === 'int4'
          ? 'An amount is too large to save — invoices, quotations, payroll, expenses and payments accept at most ₹2,14,74,836 for a single amount. Split it, or ask your administrator.'
          : 'An amount is too large to save. Check the figure for extra digits, or ask your administrator.',
      },
    })
    return
  }
  // The stack and the route, so a 500 can be traced. Path only — never the
  // query string (signed-link tokens travel there) and never the body
  // (salary, bank or ledger detail).
  const route = `${req?.method ?? '?'} ${req?.path ?? '?'}`
  console.error(`[unhandled] ${route}`, err instanceof Error ? (err.stack ?? err.message) : 'unknown error')
  reportError(err, route)
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong.' } })
}

/**
 * Prisma's INT4/INT8 conversion failure, or Postgres "integer out of range"
 * / "bigint out of range" (22003). Returns which width overflowed.
 */
function integerOverflow(err: unknown): 'int4' | 'int8' | null {
  if (!(err instanceof Error)) return null
  const m = err.message
  if (/into an INT8|bigint out of range/i.test(m)) return 'int8'
  if (/Unable to fit integer value .* into an INT4|integer out of range/i.test(m)) return 'int4'
  if ((err as { code?: unknown }).code === '22003') return 'int4'
  return null
}
