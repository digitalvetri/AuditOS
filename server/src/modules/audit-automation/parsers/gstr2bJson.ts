import { type NormalizedEntry, type ParsedFiling2B, toPaise, toIsoDate } from './types.js'

/**
 * Parser for GSTR-2B JSON downloads from the GSTN offline utility.
 *
 * The JSON envelope looks like:
 *   {
 *     "data": {
 *       "rtnprd": "042026",                 // return period MMYYYY
 *       "gstin": "22AAAAA0000A1Z5",
 *       "gendt": "14-05-2026",             // generated date
 *       "docdata": {
 *         "b2b": [                         // supplier-level array
 *           {
 *             "ctin": "07AABCU9603R1ZX",
 *             "trdnm": "Acme Steel",
 *             "inv": [
 *               { "inum": "INV/24/0007", "idt": "10-04-2026",
 *                 "val": 118000, "txval": 100000,
 *                 "igst": 18000, "cgst": 0, "sgst": 0, "cess": 0,
 *                 "itcavl": "Y" }
 *             ]
 *           }
 *         ],
 *         "b2ba": [...], "cdnr": [...], "cdnra": [...],
 *         "isd": [...], "isda": [...], "impg": [...], "imps": [...]
 *       }
 *     }
 *   }
 *
 * We flatten (supplier × invoices) into one NormalizedEntry per invoice
 * and stamp the section on each so downstream can filter / group.
 *
 * Amounts in the JSON are in rupees (decimal) — toPaise() converts.
 */

const SECTIONS = ['b2b', 'b2ba', 'cdnr', 'cdnra', 'isd', 'isda', 'impg', 'imps'] as const

type Section = typeof SECTIONS[number]

interface RawSupplier {
  ctin?: string
  trdnm?: string
  inv?: RawInvoice[]
  nt?: RawInvoice[]   // credit/debit notes use `nt` in some envelopes
}
interface RawInvoice {
  inum?: string
  idt?: string
  ntnum?: string      // note number for CDNR
  ntdt?: string       // note date
  txval?: number | string
  val?: number | string
  igst?: number | string
  cgst?: number | string
  sgst?: number | string
  cess?: number | string
  itcavl?: string     // "Y" | "N"
}

export function parseGstr2BJson(bytes: Buffer): ParsedFiling2B {
  let json: unknown
  try { json = JSON.parse(bytes.toString('utf8')) } catch {
    throw new Error('gstr2b_json_invalid')
  }
  const data = (json as { data?: Record<string, unknown> }).data ?? (json as Record<string, unknown>)
  const gstin = typeof data.gstin === 'string' ? data.gstin : undefined
  const gendt = typeof data.gendt === 'string' ? toIsoDate(data.gendt) : undefined
  const docdata = ((data.docdata as Record<string, unknown>) ?? {}) as Record<Section, RawSupplier[]>

  const entries: NormalizedEntry[] = []
  for (const section of SECTIONS) {
    const suppliers = docdata[section]
    if (!Array.isArray(suppliers)) continue
    for (const supplier of suppliers) {
      const invoices = supplier.inv ?? supplier.nt ?? []
      for (const inv of invoices) {
        const invoiceNumber = inv.inum ?? inv.ntnum ?? ''
        const invoiceDate = toIsoDate(inv.idt ?? inv.ntdt ?? '')
        if (!invoiceNumber) continue
        entries.push({
          section,
          supplierGstin: supplier.ctin ?? '',
          supplierName: supplier.trdnm ?? undefined,
          invoiceNumber,
          invoiceDate,
          taxableValue: toPaise(inv.txval ?? 0),
          igst: toPaise(inv.igst ?? 0),
          cgst: toPaise(inv.cgst ?? 0),
          sgst: toPaise(inv.sgst ?? 0),
          cess: toPaise(inv.cess ?? 0),
          itcAvailable: (inv.itcavl ?? 'Y').toUpperCase() !== 'N',
          rawJson: JSON.stringify({ supplier: { ctin: supplier.ctin, trdnm: supplier.trdnm }, inv }),
        })
      }
    }
  }
  return { gstin, generatedAt: gendt, entries }
}
