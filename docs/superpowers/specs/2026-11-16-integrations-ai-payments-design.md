# Integrations: more AI providers + Razorpay / Cashfree payment links — design

Agreed in conversation on 2026-11-16. The user picked the options: Claude, OpenAI and Gemini join Groq; payment links that mark the invoice paid automatically; no other integrations this round.

## A. AI provider (Integrations → AI provider)
- Providers: `groq` (existing), `anthropic` (Claude), `openai`, `gemini`. One row per (organisation, provider) in the existing `AiProviderConfig` table (api key encrypted with `encryptPortalSecret`, optional model).
- **One active provider per firm.** Add `Organisation.aiProvider String?` (null = first configured provider, else Groq env fallback) — or reuse an existing settings mechanism if one fits better. Saving the first key makes that provider active; a "Use this provider" action switches.
- Default models (editable per firm; the model field shows the default as placeholder):
  - anthropic: `claude-opus-5-5` (via `@anthropic-ai/sdk`, `client.messages.create`; no `temperature` — sampling params are rejected on current models; no prefill; JSON via system instruction + JSON.parse, tolerate a ```json fence)
  - openai: `gpt-5` via OpenAI chat completions (fetch to https://api.openai.com/v1/chat/completions, `response_format: {type:'json_object'}` when json)
  - gemini: `gemini-2.5-flash` via Google's OpenAI-compatible endpoint (https://generativelanguage.googleapis.com/v1beta/openai/chat/completions, Bearer key)
  - groq: unchanged (`DEFAULT_GROQ_MODEL`, env fallback `GROQ_API_KEY` stays)
- `complete()` in `backend/src/modules/notices/groq.ts` becomes provider-neutral (move to `backend/src/lib/llm/` or `modules/integrations/llm.ts`, keep `notices/groq.ts` re-exporting so callers don't change). Keep: `assertAiAllowed`, `maskPersonalData` on user text, `llm_unconfigured` 503, `llm_empty`, `llm_bad_json` 502.
- Test endpoint works for every provider (a tiny "reply with OK" call), errors shown as "The provider rejected the key: …".
- Page: one card per provider (logo-less, name + where to get a key link: console.anthropic.com, platform.openai.com/api-keys, aistudio.google.com/apikey, console.groq.com/keys), status (configured / active), key + model inputs, Test, Save, Remove, "Use this provider". Header copy explains the active provider is used by AI features (GST Notices reply drafter today).
- Tests: provider selection & fallback, each provider adapter with a mocked fetch/SDK, route validation (unknown provider 400, short key 400), remove active provider falls back.

## B. Payment gateways (Integrations → Payment gateways)
- New page `/integrations/payment-gateways`, sidebar item "Payment gateways" (Zoho Payments item stays as is).
- Gateways: **Razorpay**, **Cashfree**, and **Zoho Payments** (Zoho uses the existing zpay connection; if creating links for native AuditOS invoices through zpay is not feasible cleanly, show Zoho as "use the Zoho Payments page" and support Razorpay/Cashfree only — say so in the report).
- New table `PaymentGatewayConfig` (organisationId, gateway 'razorpay'|'cashfree', mode 'live'|'test', keyId/appId, secret encrypted, webhookSecret encrypted (Razorpay; Cashfree signs with the secret key), isDefault, active, audit fields). One default gateway per firm.
- New table `InvoicePaymentLink` (invoiceId, gateway, gatewayLinkId, url, amountPaise, status created|paid|partially_paid|expired|cancelled, paidPaise, lastCheckedAt, paymentId(s) recorded, createdBy, createdAt). Unique (gateway, gatewayLinkId).
- Invoice action **Payment link** on AuditOS invoices (`backend/src/modules/invoice`, frontend invoice detail page): creates a link for the balance due at the default gateway (optionally choose gateway), returns the URL; buttons Copy link / Open; the existing invoice email/WhatsApp send can include the link if simple (optional).
- **Auto-recording:** public webhook endpoints `POST /api/payments/webhooks/razorpay` and `/cashfree` (raw body, signature verified: Razorpay `X-Razorpay-Signature` = HMAC-SHA256(rawBody, webhookSecret) hex; Cashfree `x-webhook-signature` = base64(HMAC-SHA256(timestamp + rawBody, secretKey)) with `x-webhook-timestamp` — VERIFY both against the official docs before coding). On a paid event, record a payment on the invoice through the SAME service the manual "Record payment" uses (mode `upi`/`card`/`online` as the schema allows, reference = gateway payment id), idempotent on the gateway payment id, inside the invoice lock added in audit round 2. Over-payment never recorded beyond balance (excess logged/flagged).
- **Check status** button (and webhook-less fallback): fetch the link from the gateway API and record any new payments the same idempotent way.
- Gateway APIs (VERIFY with official docs via WebFetch before coding): Razorpay Payment Links `POST https://api.razorpay.com/v1/payment_links` (basic auth key_id:key_secret, amount in paise, currency INR, reference_id, customer, notify, callback), `GET /v1/payment_links/:id`; Cashfree Payment Links `POST {base}/pg/links` (headers x-client-id, x-client-secret, x-api-version), base live https://api.cashfree.com, test https://sandbox.cashfree.com; `GET {base}/pg/links/{link_id}` and its orders/payments.
- Settings page shows the webhook URL to paste in the gateway dashboard (`PUBLIC_APP_URL` + path) and a Test button (an authenticated read call that proves the keys work).
- Permission: `integrations.access@organisation` for settings; creating a link needs the invoice payment permission the manual Record payment uses.
- Tests: config CRUD + encryption + default gateway; link creation with mocked fetch per gateway; webhook signature good/bad; paid webhook records exactly one payment (replay = no duplicate); check-status records once; partial payment; cancelled invoice refuses link.

## Out of scope
SMTP/WhatsApp UI, overview page (user declined). Refunds through gateways. Subscriptions.

## Deploy note
Schema change (new tables + one column). Coolify auto-deploys on push to main → rehearse on a prod backup copy before pushing.
