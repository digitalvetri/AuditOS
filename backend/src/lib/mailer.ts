/**
 * Outgoing email over the firm's own SMTP account (Gmail / Google Workspace
 * with an app password, Zoho Mail, or any SMTP server).
 *
 *   SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE ("true" for port 465)
 *   SMTP_USER, SMTP_PASS
 *   MAIL_FROM   e.g. "JNS Accounting Solutions <accounts@example.com>";
 *               defaults to SMTP_USER
 *
 * Not configured → `mailConfigured()` is false and callers say so; nothing is
 * queued or faked. The password is never logged or returned.
 */
import nodemailer, { type Transporter } from 'nodemailer'

export function mailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
}

export function mailFrom(): string | null {
  return process.env.MAIL_FROM || process.env.SMTP_USER || null
}

let transport: Transporter | null = null
function transporter(): Transporter {
  if (transport) return transport
  const port = Number(process.env.SMTP_PORT ?? 587)
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  })
  return transport
}

export interface Mail {
  to: string[]
  cc?: string[]
  replyTo?: string
  subject: string
  text: string
  attachments?: { filename: string; content: Buffer; contentType: string }[]
}

export class MailError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message)
    this.name = 'MailError'
  }
}

/** Send one message. Resolves with the SMTP message id; throws MailError with a clean reason. */
export async function sendMail(m: Mail): Promise<string> {
  if (!mailConfigured()) throw new MailError('Email is not configured on the server (SMTP_HOST, SMTP_USER, SMTP_PASS).', 'not_configured')
  try {
    const info = await transporter().sendMail({ from: mailFrom() ?? undefined, ...m })
    return info.messageId
  } catch (e) {
    const err = e as { code?: string; responseCode?: number; message?: string }
    console.warn('[mail] send failed', err.code ?? '', err.responseCode ?? '')
    const reason = err.code === 'EAUTH' ? 'the mail server rejected the SMTP username or password'
      : err.code === 'ECONNECTION' || err.code === 'ETIMEDOUT' || err.code === 'ESOCKET' ? 'the mail server could not be reached'
      : err.responseCode && err.responseCode >= 500 ? 'the mail server refused the message'
      : 'the mail server returned an error'
    throw new MailError(`The email was not sent: ${reason}.`, err.code)
  }
}

export function resetMailerForTests(): void {
  transport = null
}
