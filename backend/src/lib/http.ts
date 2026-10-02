import type { NextFunction, Request, Response } from 'express'

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

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    })
    return
  }
  // Never leak salary, bank or ledger detail into a client body or a log line.
  console.error('[unhandled]', err instanceof Error ? err.message : 'unknown error')
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong.' } })
}
