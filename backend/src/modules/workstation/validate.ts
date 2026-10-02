import { ApiError } from '../../lib/http.js'

/**
 * The `validate` step of the shared pipeline, for Workstation.
 *
 * Errors come back as `details: { field: message }` so the React forms can
 * put the message under the field that caused it rather than showing one
 * banner for a form with six inputs (§20 "field-level messages").
 */
export class FieldErrors {
  private errors: Record<string, string> = {}

  add(field: string, message: string): this {
    if (!this.errors[field]) this.errors[field] = message
    return this
  }

  /** Required, non-blank string. */
  str(field: string, value: unknown, opts: { max?: number; required?: boolean } = {}): string | undefined {
    const required = opts.required ?? true
    if (value === undefined || value === null || value === '') {
      if (required) this.add(field, 'This field is required.')
      return undefined
    }
    if (typeof value !== 'string') {
      this.add(field, 'Must be text.')
      return undefined
    }
    const trimmed = value.trim()
    if (required && !trimmed) {
      this.add(field, 'This field is required.')
      return undefined
    }
    if (opts.max && trimmed.length > opts.max) {
      this.add(field, `Must be ${opts.max} characters or fewer.`)
      return undefined
    }
    return trimmed
  }

  /** Indian mobile/landline: 10 digits, optionally +91-prefixed. */
  phone(field: string, value: unknown, required = true): string | undefined {
    const raw = this.str(field, value, { required })
    if (raw === undefined) return undefined
    const digits = raw.replace(/[\s\-()]/g, '').replace(/^\+91/, '')
    if (!/^[6-9]\d{9}$/.test(digits)) {
      this.add(field, 'Enter a valid 10-digit Indian mobile number.')
      return undefined
    }
    return digits
  }

  email(field: string, value: unknown, required = false): string | undefined {
    const raw = this.str(field, value, { required })
    if (raw === undefined) return undefined
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
      this.add(field, 'Enter a valid email address.')
      return undefined
    }
    return raw.toLowerCase()
  }

  /** Money arrives as rupees from the form and is stored as integer paise. */
  rupeesToPaise(field: string, value: unknown, required = false): number | undefined {
    if (value === undefined || value === null || value === '') {
      if (required) this.add(field, 'This field is required.')
      return required ? undefined : 0
    }
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) {
      this.add(field, 'Enter a valid amount.')
      return undefined
    }
    return Math.round(n * 100)
  }

  /** A calendar date, kept as a 'YYYY-MM-DD' string so it cannot drift. */
  date(field: string, value: unknown, required = false): string | undefined {
    const raw = this.str(field, value, { required })
    if (raw === undefined) return undefined
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) {
      this.add(field, 'Enter a valid date.')
      return undefined
    }
    return raw
  }

  /** An instant. Follow-ups carry a date AND a time. */
  datetime(field: string, value: unknown, required = true): Date | undefined {
    const raw = this.str(field, value, { required })
    if (raw === undefined) return undefined
    const ms = Date.parse(raw)
    if (Number.isNaN(ms)) {
      this.add(field, 'Enter a valid date and time.')
      return undefined
    }
    return new Date(ms)
  }

  oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[], required = true): T | undefined {
    const raw = this.str(field, value, { required })
    if (raw === undefined) return undefined
    if (!allowed.includes(raw as T)) {
      this.add(field, `Must be one of: ${allowed.join(', ')}.`)
      return undefined
    }
    return raw as T
  }

  /** GSTIN: 15 chars — 2 state digits, 10-char PAN, entity, Z, checksum. */
  gstin(field: string, value: unknown, required = false): string | undefined {
    const raw = this.str(field, value, { required })
    if (raw === undefined) return undefined
    const up = raw.toUpperCase()
    if (!/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z]\d$/.test(up)) {
      this.add(field, 'Enter a valid 15-character GSTIN.')
      return undefined
    }
    return up
  }

  pan(field: string, value: unknown, required = false): string | undefined {
    const raw = this.str(field, value, { required })
    if (raw === undefined) return undefined
    const up = raw.toUpperCase()
    if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(up)) {
      this.add(field, 'Enter a valid 10-character PAN.')
      return undefined
    }
    return up
  }

  get hasErrors(): boolean {
    return Object.keys(this.errors).length > 0
  }

  /** Throws 400 with per-field detail, or returns cleanly. */
  throwIfAny(): void {
    if (this.hasErrors) {
      throw ApiError.badRequest('Please correct the highlighted fields.', this.errors)
    }
  }
}

/** Body must be a JSON object before any field is read. */
export function body(req: { body?: unknown }): Record<string, unknown> {
  const b = req.body
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw ApiError.badRequest('A JSON object body is required.')
  }
  return b as Record<string, unknown>
}

/**
 * Lead status adjacency (§5.1). An illegal jump is 422, not a silent write —
 * "Quote Sent → New" is a bug in the caller, not a state we should persist.
 */
export const LEAD_STATUSES = [
  'new', 'contacted', 'requirement_identified', 'quote_sent', 'negotiation', 'won', 'lost',
] as const
export type LeadStatus = (typeof LEAD_STATUSES)[number]

const LEAD_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  new: ['contacted', 'lost'],
  contacted: ['requirement_identified', 'lost'],
  requirement_identified: ['quote_sent', 'lost'],
  quote_sent: ['negotiation', 'won', 'lost'],
  negotiation: ['won', 'lost'],
  won: [],
  // Reopening a lost lead is allowed but lands back at `contacted`, and the
  // activity timeline records it.
  lost: ['contacted'],
}

export function assertLeadTransition(from: string, to: string): void {
  if (from === to) return
  const allowed = LEAD_TRANSITIONS[from as LeadStatus] ?? []
  if (!allowed.includes(to as LeadStatus)) {
    throw ApiError.unprocessable(
      'invalid_transition',
      `A lead cannot move from "${from.replace(/_/g, ' ')}" to "${to.replace(/_/g, ' ')}".`,
      { from, to, allowed },
    )
  }
}

export const SERVICE_STATUSES = [
  'not_started', 'documents_pending', 'in_progress', 'under_review',
  'ready', 'submitted', 'completed', 'failed', 'on_hold',
] as const

export const FOLLOWUP_TYPES = [
  'call', 'whatsapp', 'email', 'meeting', 'document_request',
  'payment_followup', 'service_followup', 'other',
] as const

export const FOLLOWUP_STATUSES = [
  'pending', 'completed', 'rescheduled', 'cancelled', 'missed',
] as const

export const DOCUMENT_STATUSES = [
  'requested', 'pending', 'uploaded', 'under_review', 'verified', 'rejected', 'expired',
] as const

export const GST_FILING_STATUSES = [
  'not_started', 'documents_pending', 'data_preparation', 'under_review',
  'ready_to_file', 'filed', 'failed', 'completed',
] as const

export const CLIENT_STATUSES = [
  'active', 'onboarding', 'pending_documents', 'service_due', 'inactive',
] as const
