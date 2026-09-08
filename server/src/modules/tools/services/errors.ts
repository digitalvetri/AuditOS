/**
 * A ToolError carries a message written for the person at the screen (§13).
 * Anything else that escapes a service is treated as an internal failure and
 * shown as "Conversion failed. Please try again." — never a stack trace.
 */
export type ToolErrorCode =
  | 'unsupported_type'
  | 'too_large'
  | 'empty'
  | 'unreadable'
  | 'encrypted'
  | 'not_encrypted'
  | 'wrong_password'
  | 'no_tables'
  | 'no_text_layer'
  | 'partial'
  | 'invalid_range'
  | 'invalid_options'
  | 'not_authorised'
  | 'engine_unavailable'
  | 'failed'

export class ToolError extends Error {
  constructor(public readonly code: ToolErrorCode, message: string, public readonly details?: Record<string, unknown>) {
    super(message)
  }
}

export function userMessage(err: unknown): { code: ToolErrorCode; message: string; details?: Record<string, unknown> } {
  if (err instanceof ToolError) return { code: err.code, message: err.message, details: err.details }
  return { code: 'failed', message: 'Conversion failed. Please try again.' }
}
