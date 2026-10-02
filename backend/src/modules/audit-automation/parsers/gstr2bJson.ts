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

const SECTIONS = ['b2b', 'b2ba', 'cdnr', 'cdnra', 'isd', 'isda', 'impg', 'impgsez', 'imps'] as const
type Section = typeof SECTIONS[number]

type Num = number | string | undefined
/**
 * One document in GSTR-2B's JSON. Invoices (b2b/b2ba) use inum/dt; notes
 * (cdnr/cdnra) use ntnum/dt with typ C|D; ISD documents use docnum/docdt;
 * bills of entry (impg) use boenum/boedt. `idt`/`ntdt` are accepted too
 * (older / third-party exports).
 */
interface RawDoc {
  inum?: string; ntnum?: string; docnum?: string; boenum?: string
  dt?: string; idt?: string; ntdt?: string; docdt?: string; boedt?: string
  oinum?: string; ontnum?: string; odocnum?: string
  typ?: string; doctyp?: string
  val?: Num; txval?: Num; igst?: Num; cgst?: Num; sgst?: Num; cess?: Num
  rev?: string; itcavl?: string; itcelg?: string; rsn?: string
  portcd?: string
}
interface RawSupplier { ctin?: string; trdnm?: string; inv?: RawDoc[]; nt?: RawDoc[]; doclist?: RawDoc[] }

function asList(x: unknown): unknown[] { return Array.isArray(x) ? x : x && typeof x === 'object' ? [x] : [] }

function toEntry(section: Section, doc: RawDoc, supplier: { ctin?: string; trdnm?: string }): NormalizedEntry | null {
  const isNote = section === 'cdnr' || section === 'cdnra'
  const isIsd = section === 'isd' || section === 'isda'
  const isBoe = section === 'impg' || section === 'impgsez'
  const number = isBoe
    ? (doc.boenum ? `BOE-${doc.portcd ?? ''}-${doc.boenum}` : '')
    : (doc.inum ?? doc.ntnum ?? doc.docnum ?? '')
  if (!number) return null
  const date = toIsoDate(doc.dt ?? doc.idt ?? doc.ntdt ?? doc.docdt ?? doc.boedt ?? '')
  // A credit note (or an ISD credit-note document) reduces ITC: negative amounts.
  const noteType = (doc.typ ?? doc.doctyp ?? '').toUpperCase()
  const credit = (isNote || isIsd) && (noteType === 'C' || noteType === 'CN' || noteType === 'CR')
  const sign = credit ? -1 : 1
  const amt = (v: Num) => sign * toPaise(v ?? 0)
  const docType = isBoe ? 'BOE' : isIsd ? 'ISD' : isNote ? (credit ? 'CRN' : 'DBN') : 'INV'
  const eligible = (doc.itcavl ?? doc.itcelg ?? 'Y').toUpperCase() !== 'N'
  return {
    section,
    docType,
    supplierGstin: supplier.ctin ?? (isBoe ? 'IMPORT' : ''),
    supplierName: supplier.trdnm ?? (isBoe ? 'Import of goods (customs)' : undefined),
    invoiceNumber: number,
    invoiceDate: date,
    taxableValue: amt(doc.txval),
    igst: amt(doc.igst),
    cgst: amt(doc.cgst),
    sgst: amt(doc.sgst),
    cess: amt(doc.cess),
    invoiceValue: doc.val !== undefined ? amt(doc.val) : undefined,
    reverseCharge: (doc.rev ?? 'N').toUpperCase() === 'Y',
    originalInvoiceNumber: doc.oinum ?? doc.ontnum ?? doc.odocnum ?? undefined,
    itcAvailable: eligible,
    itcReason: !eligible && doc.rsn ? String(doc.rsn) : undefined,
    rawJson: JSON.stringify({ supplier: { ctin: supplier.ctin, trdnm: supplier.trdnm }, doc }),
  }
}

export function parseGstr2BJson(bytes: Buffer): ParsedFiling2B {
  let json: unknown
  try { json = JSON.parse(bytes.toString('utf8')) } catch {
    throw new Error('gstr2b_json_invalid')
  }
  const data = (json as { data?: Record<string, unknown> }).data ?? (json as Record<string, unknown>)
  const gstin = typeof data.gstin === 'string' ? data.gstin : undefined
  const gendt = typeof data.gendt === 'string' ? toIsoDate(data.gendt) : undefined
  const docdata = ((data.docdata as Record<string, unknown>) ?? {}) as Record<string, unknown>

  const entries: NormalizedEntry[] = []
  for (const section of SECTIONS) {
    for (const item of asList(docdata[section]) as RawSupplier[]) {
      // Bills of entry sit directly in the section; everything else is grouped by supplier.
      const docs = (item.inv ?? item.nt ?? item.doclist) ? asList(item.inv ?? item.nt ?? item.doclist) as RawDoc[] : [item as RawDoc]
      for (const doc of docs) {
        const e = toEntry(section, doc, item)
        if (e) entries.push(e)
      }
    }
  }
  return { gstin, generatedAt: gendt, entries }
}
