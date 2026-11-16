import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { gstinStateCode, stateNameToCode } from '../repotic/states.js'

/**
 * PLACE OF SUPPLY → TAX SPLIT. Shared by invoices and quotations.
 *
 * Intra-state supply is CGST + SGST, inter-state is IGST, and which one
 * applies is a fact — the supplier's state against the place of supply — not
 * a checkbox. So when the server can see both states it decides, and the
 * request's `is_inter_state` is only used when it cannot.
 *
 * The supplier's state comes from the firm's own GSTIN in settings
 * (Organisation.gstin) — never from the letterhead block on the document,
 * whose default carries a hard-coded state. The place of supply must be a
 * state from the list: free text such as "Bangalore" is refused, and a blank
 * one is filled from the customer's GSTIN. An invoice whose firm GSTIN or
 * place of supply is unknown can be saved as a draft but not sent.
 */

/** "true"/"false" from a form, or a real boolean — z.coerce.boolean() reads "false" as true. */
export const formBool = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])

/** 'Tamil Nadu (33)' / 'Tamil Nadu' / 'TN' → '33'. Null when unrecognised. */
export function placeOfSupplyCode(pos: string | null | undefined): string | null {
  if (!pos) return null
  const coded = /\((\d{2})\)\s*$/.exec(pos)
  if (coded) return coded[1]
  return stateNameToCode(pos)
}

/** A place of supply on a request: blank, or a state the list knows. */
export const placeOfSupplySchema = z.string().trim().max(100)
  .refine((v) => v === '' || placeOfSupplyCode(v) !== null, 'Choose the place of supply from the list of states.')
  .nullish()

/** The builder's state list (frontend invoices/document.ts STATES), by GST code. */
const STATE_NAMES: Record<string, string> = {
  '35': 'Andaman and Nicobar Islands', '37': 'Andhra Pradesh', '12': 'Arunachal Pradesh', '18': 'Assam',
  '10': 'Bihar', '04': 'Chandigarh', '22': 'Chhattisgarh', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '07': 'Delhi', '30': 'Goa', '24': 'Gujarat', '06': 'Haryana', '02': 'Himachal Pradesh',
  '01': 'Jammu and Kashmir', '20': 'Jharkhand', '29': 'Karnataka', '32': 'Kerala', '38': 'Ladakh',
  '31': 'Lakshadweep', '23': 'Madhya Pradesh', '27': 'Maharashtra', '14': 'Manipur', '17': 'Meghalaya',
  '15': 'Mizoram', '13': 'Nagaland', '21': 'Odisha', '34': 'Puducherry', '03': 'Punjab', '08': 'Rajasthan',
  '11': 'Sikkim', '33': 'Tamil Nadu', '36': 'Telangana', '16': 'Tripura', '09': 'Uttar Pradesh',
  '05': 'Uttarakhand', '19': 'West Bengal', '97': 'Other Territory',
}
export const GST_STATE_NAMES: Readonly<Record<string, string>> = STATE_NAMES

/** '29' → 'Karnataka', the name the builder's state list uses. */
export function stateNameForCode(code: string | null | undefined): string | null {
  return code ? STATE_NAMES[code] ?? null : null
}

/**
 * The firm's organisation (single-tenant): the oldest one. Ordered, because
 * an unordered findFirst can return a different row after an UPDATE moves it.
 */
export async function firmOrgId(db: Prisma.TransactionClient | typeof prisma = prisma): Promise<string | null> {
  return (await db.organisation.findFirst({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } }))?.id ?? null
}

/** The firm's GSTIN from settings (null when not set). */
export async function firmGstin(db: Prisma.TransactionClient | typeof prisma = prisma, organisationId?: string | null): Promise<string | null> {
  const id = organisationId ?? await firmOrgId(db)
  if (!id) return null
  const org = await db.organisation.findUnique({ where: { id }, select: { gstin: true } })
  return org?.gstin ?? null
}

/** The firm's state code, from its GSTIN in settings. */
export function firmStateCode(gstin: string | null | undefined): string | null {
  return gstinStateCode(gstin?.trim() || null)
}

/**
 * The place of supply to use: the one asked for, else the customer GSTIN's
 * state. Never a default state — blank stays blank and blocks sending.
 */
export function defaultPlaceOfSupply(requested: string | null | undefined, customerGstin: string | null | undefined): string | null {
  if (requested && requested.trim()) return requested.trim()
  return stateNameForCode(gstinStateCode(customerGstin?.trim() || null))
}

/** Server-derived when both states are known; otherwise what was asked for. */
export function resolveInterState(
  placeOfSupply: string | null | undefined,
  firmGstinValue: string | null | undefined,
  requested: boolean | undefined,
): boolean {
  const pos = placeOfSupplyCode(placeOfSupply)
  const firm = firmStateCode(firmGstinValue)
  if (pos && firm) return pos !== firm
  return requested ?? false
}
