import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, noContent, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { requireWorkstation } from '../../platform/workstation/scope.js'
import { signedLink } from '../../platform/signedUrl.js'
import { InvoiceService, QR_MODES, TERMS, type ItemInput } from './service.js'
import { GST_RATES } from './totals.js'

/**
 * Invoice HTTP surface — mounted at /api/invoices.
 *
 * Same pipeline as the rest of Workstation: authenticate → require the
 * permission (which returns the caller's scope) → Zod validate → service.
 *
 * NOTHING in any request body carries a total, a tax figure, an invoice
 * number or a timestamp. Totals are recomputed from the items on every write,
 * the number is allocated in the creating transaction and the clock is the
 * server's — which is what makes "the numbers add up" and "the number is
 * unique" properties of the API rather than rules the UI is trusted to keep.
 */
export const invoicesRouter = Router()

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, message: string): z.infer<T> {
  const r = schema.safeParse(data)
  if (!r.success) {
    throw ApiError.badRequest(message, r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
  }
  return r.data
}

const itemSchema = z.object({
  service_id: z.string().nullish(),
  item_name: z.string().trim().min(1, 'Name the item.').max(200),
  description: z.string().trim().max(2000).nullish(),
  /* HSN for goods, SAC for services. Optional because a reimbursement line
     legitimately has neither, and §45 says not to block on a field that does
     not apply. Length-checked because GST codes are 4-8 digits. */
  hsn_sac: z.string().trim().regex(/^\d{4,8}$/, 'HSN/SAC is 4 to 8 digits.').nullish().or(z.literal('')),
  quantity_centi: z.coerce.number().int().positive('Quantity must be more than zero.').max(100_000_000),
  unit: z.string().trim().max(20).nullish(),
  rate_paise: z.coerce.number().int().nonnegative().max(1_000_000_000_0),
  discount_percent: z.coerce.number().int().min(0).max(100).default(0),
  /* The FULL slab. CGST/SGST are derived as half of it by totals.ts, which is
     why the body cannot send them separately — two independently settable
     halves is how a 9+10 invoice gets issued. */
  gst_rate_percent: z.coerce.number().int().refine((n) => (GST_RATES as readonly number[]).includes(n), {
    message: `GST rate must be one of ${GST_RATES.join(', ')}.`,
  }),
})

const bodySchema = z.object({
  client_id: z.string().min(1, 'Choose a client.'),
  invoice_date: ISO_DATE,
  terms: z.enum(TERMS).default('due_on_receipt'),
  due_date: ISO_DATE.nullish(),
  place_of_supply: z.string().trim().max(100).nullish(),
  is_inter_state: z.coerce.boolean().default(false),
  discount_paise: z.coerce.number().int().nonnegative().max(1_000_000_000).default(0),
  notes: z.string().trim().max(2000).nullish(),

  billing_name: z.string().trim().max(200).nullish(),
  billing_address: z.string().trim().max(1000).nullish(),
  ship_same_as_bill: z.coerce.boolean().default(true),
  shipping_name: z.string().trim().max(200).nullish(),
  shipping_address: z.string().trim().max(1000).nullish(),
  customer_gstin: z.string().trim().max(20).nullish(),

  bank_account_id: z.string().nullish(),
  template_id: z.string().trim().max(60).nullish(),
  signatory_name: z.string().trim().max(120).nullish(),
  signatory_designation: z.string().trim().max(120).nullish(),
  footer_note: z.string().trim().max(300).nullish(),
  qr_mode: z.enum(QR_MODES).default('upi_amount'),
  /* Free text on purpose: a custom QR may hold a payment page, a portal
     link or a plain reference. Length-capped because the encoder refuses a
     payload too long to scan. */
  qr_value: z.string().trim().max(300).nullish(),
  /* An uploaded QR, inlined as a data URL. Restricted to raster image types
     — an SVG data URL is a script vector, and this one ends up rendered in a
     document other people open. 400 KB is generous for a QR and stops the
     row becoming a file store. */
  qr_image: z.string()
    .regex(/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/, 'Upload a PNG, JPEG or WebP image.')
    .max(400_000, 'That image is too large — 400 KB is the limit.')
    .nullish(),

  /* Layout and blocks are the builder's own shape; the server stores them
     verbatim and never interprets them, so passthrough objects are correct
     here — validating them would couple the API to the editor's internals. */
  layout_config: z.record(z.unknown()).nullish(),
  block_config: z.array(z.record(z.unknown())).nullish(),

  items: z.array(itemSchema).min(1, 'An invoice needs at least one item.').max(200),
})

function toInput(b: z.infer<typeof bodySchema>) {
  return {
    clientId: b.client_id,
    invoiceDate: b.invoice_date,
    terms: b.terms,
    dueDate: b.due_date ?? null,
    placeOfSupply: b.place_of_supply ?? null,
    isInterState: b.is_inter_state,
    discountPaise: b.discount_paise,
    notes: b.notes ?? null,
    billingName: b.billing_name ?? null,
    billingAddress: b.billing_address ?? null,
    shipSameAsBill: b.ship_same_as_bill,
    shippingName: b.shipping_name ?? null,
    shippingAddress: b.shipping_address ?? null,
    customerGstin: b.customer_gstin ?? null,
    /* NOT `?? null`. `undefined` means the caller said nothing and the
       default account should apply; `null` means they explicitly chose None
       and no bank block should print. Collapsing the two makes "None"
       impossible to express. */
    bankAccountId: b.bank_account_id,
    templateId: b.template_id ?? null,
    layoutConfig: (b.layout_config ?? null) as never,
    blockConfig: (b.block_config ?? null) as never,
    signatoryName: b.signatory_name ?? null,
    signatoryDesignation: b.signatory_designation ?? null,
    footerNote: b.footer_note ?? null,
    qrMode: b.qr_mode,
    qrValue: b.qr_value ?? null,
    qrImage: b.qr_image ?? null,
    items: b.items.map<ItemInput>((i) => ({
      serviceId: i.service_id ?? null,
      itemName: i.item_name,
      description: i.description ?? null,
      hsnSac: i.hsn_sac || null,
      quantityCenti: i.quantity_centi,
      unit: i.unit ?? 'Nos',
      ratePaise: i.rate_paise,
      discountPercent: i.discount_percent,
      gstRatePercent: i.gst_rate_percent,
    })),
  }
}

invoicesRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.read')
  const q = parse(
    z.object({
      status: z.string().optional(),
      client_id: z.string().optional(),
      date_from: ISO_DATE.optional(),
      date_to: ISO_DATE.optional(),
      q: z.string().optional(),
      limit: z.coerce.number().int().positive().max(200).optional(),
      offset: z.coerce.number().int().nonnegative().optional(),
    }),
    req.query,
    'Invalid filters.',
  )
  ok(res, await InvoiceService.list(session, scope, {
    status: q.status, clientId: q.client_id, dateFrom: q.date_from, dateTo: q.date_to,
    q: q.q, limit: q.limit, offset: q.offset,
  }))
}))

invoicesRouter.get('/summary', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.read')
  ok(res, await InvoiceService.summary(session, scope))
}))

/** The bank accounts that may be printed on an invoice (§26). */
invoicesRouter.get('/bank-accounts', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.invoice.read')
  ok(res, await InvoiceService.bankAccounts(session))
}))

/** Add a bank account that may be printed on an invoice (§26). */
invoicesRouter.post('/bank-accounts', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.invoice.manage')
  const b = parse(
    z.object({
      label: z.string().trim().min(1, 'Name the account.').max(80),
      account_number: z.string().trim().min(4, 'Enter the account number.').max(30),
      account_type: z.string().trim().max(30).default('Current'),
      account_holder: z.string().trim().min(1, 'Enter the account holder.').max(120),
      bank_name: z.string().trim().min(1, 'Enter the bank.').max(120),
      branch_name: z.string().trim().max(120).nullish(),
      /* 11 characters, bank code + 0 + branch — checked because a wrong IFSC
         is a payment that silently goes nowhere. */
      ifsc_code: z.string().trim().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC is 11 characters, e.g. KKBK0008660.'),
      upi_id: z.string().trim().max(80).nullish(),
      is_default: z.coerce.boolean().optional(),
    }),
    req.body,
    'Check the bank account.',
  )
  ok(res, await InvoiceService.createBankAccount(session, {
    label: b.label,
    accountNumber: b.account_number,
    accountType: b.account_type,
    accountHolder: b.account_holder,
    bankName: b.bank_name,
    branchName: b.branch_name ?? null,
    ifscCode: b.ifsc_code,
    upiId: b.upi_id ?? null,
    isDefault: b.is_default,
  }), 201)
}))

invoicesRouter.delete('/bank-accounts/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.invoice.manage')
  await InvoiceService.deactivateBankAccount(session, req.params.id)
  noContent(res)
}))

invoicesRouter.get('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.read')
  ok(res, await InvoiceService.get(session, scope, req.params.id))
}))

invoicesRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.manage')
  const body = parse(bodySchema, req.body, 'Check the invoice details.')
  ok(res, await InvoiceService.create(session, scope, toInput(body)), 201)
}))

invoicesRouter.put('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.manage')
  const body = parse(bodySchema, req.body, 'Check the invoice details.')
  ok(res, await InvoiceService.update(session, scope, req.params.id, toInput(body)))
}))

invoicesRouter.post('/:id/send', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.manage')
  ok(res, await InvoiceService.send(session, scope, req.params.id))
}))

invoicesRouter.post('/:id/payments', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.manage')
  const body = parse(
    z.object({ amount_paise: z.coerce.number().int().positive('Enter an amount.') }),
    req.body,
    'Check the payment.',
  )
  ok(res, await InvoiceService.recordPayment(session, scope, req.params.id, body.amount_paise))
}))

invoicesRouter.post('/:id/cancel', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.manage')
  const body = parse(z.object({ reason: z.string().trim().max(500).optional() }), req.body ?? {}, 'Check the reason.')
  ok(res, await InvoiceService.cancel(session, scope, req.params.id, body.reason))
}))

/**
 * A short-lived signed link to the PDF, for WhatsApp and email — the same
 * mechanism the quotation uses, so the document can be shared without handing
 * out a session.
 */
invoicesRouter.get('/:id/pdf-url', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.read')
  const inv = await InvoiceService.get(session, scope, req.params.id)
  ok(res, signedLink(`/api/invoices/${inv.id}/pdf`, `invoice:${inv.id}`, session.userId))
}))

invoicesRouter.delete('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.manage')
  await InvoiceService.remove(session, scope, req.params.id)
  noContent(res)
}))
