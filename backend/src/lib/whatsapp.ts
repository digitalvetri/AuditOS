/**
 * WhatsApp Business Cloud API (Meta Graph API) — send a PDF as a WhatsApp
 * DOCUMENT from the firm's business number. A browser cannot attach a file
 * to a wa.me chat; this can, from any computer.
 *
 *   WHATSAPP_TOKEN            permanent System User access token
 *   WHATSAPP_PHONE_NUMBER_ID  the sending number's ID (not the number itself)
 *   WHATSAPP_TEMPLATE_NAME    approved template with a DOCUMENT header and a
 *                             body with {{1}} = client name, {{2}} = document
 *                             (e.g. "quotation QT-2026-0001"). Needed to
 *                             START a conversation — WhatsApp only allows
 *                             free-form messages within 24h of the client's
 *                             last message.
 *   WHATSAPP_TEMPLATE_LANG    template language code, default "en"
 *   WHATSAPP_API_VERSION      default v21.0
 *   WHATSAPP_API_BASE         default https://graph.facebook.com (override only for a proxy or tests)
 *
 * Flow: upload the PDF (POST /{phone-number-id}/media) → send a message that
 * references the media id, as the template's document header, or — without
 * a template — as a plain document with the covering note as its caption.
 *
 * The token is never logged or returned.
 */
export function whatsappConfigured(): boolean {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)
}

export function whatsappMode(): 'template' | 'document' | null {
  if (!whatsappConfigured()) return null
  return process.env.WHATSAPP_TEMPLATE_NAME ? 'template' : 'document'
}

export class WhatsAppError extends Error {
  constructor(message: string, public readonly code?: number) {
    super(message)
    this.name = 'WhatsAppError'
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>
let fetchImpl: Fetch = (u, i) => fetch(u, i)
export function setWhatsAppFetchForTests(f: Fetch | null): void {
  fetchImpl = f ?? ((u, i) => fetch(u, i))
}

const base = () => `${(process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com').replace(/\/$/, '')}/${process.env.WHATSAPP_API_VERSION || 'v21.0'}/${process.env.WHATSAPP_PHONE_NUMBER_ID}`

/** A Graph API error as a sentence the user can act on. */
function explain(code: number | undefined, detail: string): string {
  switch (code) {
    case 190: return 'The WhatsApp access token has expired or is invalid. Generate a new permanent token in Meta Business settings.'
    case 131030: return 'This number is not on the allowed test-recipient list of your WhatsApp app. Add it in Meta, or go live with the app.'
    case 131047: return 'WhatsApp only allows a free-form message within 24 hours of the client\'s last message. Configure WHATSAPP_TEMPLATE_NAME to start the conversation with an approved template.'
    case 132000: return 'The WhatsApp template\'s parameters do not match. The template body must have exactly {{1}} (client name) and {{2}} (document).'
    case 132001: return 'The WhatsApp template does not exist or is not approved for this language. Check WHATSAPP_TEMPLATE_NAME and WHATSAPP_TEMPLATE_LANG.'
    case 131026: return 'WhatsApp could not deliver to this number — it is not a WhatsApp account.'
    case 131009: case 100: return `WhatsApp rejected the request: ${detail}`
    case 80007: case 130429: case 131048: case 131056: return 'WhatsApp is rate-limiting this number. Try again in a few minutes.'
    case 131031: return 'The WhatsApp business account is locked or restricted. Check it in Meta Business settings.'
    default: return `WhatsApp returned an error${code ? ` (${code})` : ''}: ${detail}`
  }
}

async function graph<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetchImpl(`${base()}${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } })
  } catch {
    throw new WhatsAppError('Could not reach WhatsApp (graph.facebook.com). Check the server\'s internet connection.')
  }
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: number; message?: string; error_data?: { details?: string } } } & T
  if (!res.ok || body.error) {
    const code = body.error?.code
    const detail = body.error?.error_data?.details || body.error?.message || `HTTP ${res.status}`
    console.warn('[whatsapp]', path, res.status, code ?? '-')
    throw new WhatsAppError(explain(code, detail), code)
  }
  return body
}

export interface WhatsAppDocument {
  /** Digits with country code, no +, e.g. 919840011223. */
  to: string
  pdf: Buffer
  filename: string
  /** Template body {{1}}. */
  recipientName: string
  /** Template body {{2}}, e.g. "quotation QT-2026-0001". */
  documentLabel: string
  /** Caption for a free-form document (no-template mode). */
  caption: string
}

/** Upload + send. Resolves with WhatsApp's message id (the message was accepted, not yet delivered). */
export async function sendWhatsAppDocument(d: WhatsAppDocument): Promise<{ messageId: string; mode: 'template' | 'document' }> {
  if (!whatsappConfigured()) throw new WhatsAppError('WhatsApp Business API is not configured on the server (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID).')

  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('type', 'application/pdf')
  form.append('file', new Blob([d.pdf], { type: 'application/pdf' }), d.filename)
  const media = await graph<{ id: string }>('/media', { method: 'POST', body: form })

  const template = process.env.WHATSAPP_TEMPLATE_NAME
  const message = template
    ? {
        messaging_product: 'whatsapp', to: d.to, type: 'template',
        template: {
          name: template,
          language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en' },
          components: [
            { type: 'header', parameters: [{ type: 'document', document: { id: media.id, filename: d.filename } }] },
            { type: 'body', parameters: [{ type: 'text', text: d.recipientName.slice(0, 60) }, { type: 'text', text: d.documentLabel.slice(0, 60) }] },
          ],
        },
      }
    : {
        messaging_product: 'whatsapp', to: d.to, type: 'document',
        document: { id: media.id, filename: d.filename, caption: d.caption.slice(0, 1000) },
      }
  const sent = await graph<{ messages?: { id: string }[] }>('/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message),
  })
  return { messageId: sent.messages?.[0]?.id ?? '', mode: template ? 'template' : 'document' }
}
