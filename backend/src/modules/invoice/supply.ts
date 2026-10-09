import { z } from 'zod'
import { gstinStateCode, stateNameToCode } from '../repotic/states.js'

/**
 * PLACE OF SUPPLY → TAX SPLIT. Shared by invoices and quotations.
 *
 * Intra-state supply is CGST + SGST, inter-state is IGST, and which one
 * applies is a fact — the supplier's state against the place of supply — not
 * a checkbox. So when the server can see both states it decides, and the
 * request's `is_inter_state` is only used when it cannot.
 *
 * The firm keeps no settings record of its own GSTIN; its letterhead lives on
 * the document's `layout_config.company` (the builder snapshots it onto every
 * invoice and quotation), so that block is the supplier's state.
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

/** The firm's own state code, from the letterhead the document carries. */
export function firmStateCode(layoutConfig: unknown): string | null {
  const company = (layoutConfig && typeof layoutConfig === 'object'
    ? (layoutConfig as { company?: unknown }).company
    : null) as { gstin?: unknown; state?: unknown } | null | undefined
  if (!company || typeof company !== 'object') return null
  const gstin = typeof company.gstin === 'string' ? company.gstin.trim() : ''
  if (gstin) {
    const code = gstinStateCode(gstin)
    if (code) return code
  }
  return typeof company.state === 'string' ? stateNameToCode(company.state) : null
}

/** Server-derived when both states are known; otherwise what was asked for. */
export function resolveInterState(
  placeOfSupply: string | null | undefined,
  layoutConfig: unknown,
  requested: boolean | undefined,
): boolean {
  const pos = placeOfSupplyCode(placeOfSupply)
  const firm = firmStateCode(layoutConfig)
  if (pos && firm) return pos !== firm
  return requested ?? false
}
