import { XMLParser } from 'fast-xml-parser'
import {
  type NormalizedTdsEntry,
  type ParsedTdsBooks,
  normalizeSection,
  normalizeTan,
  normalizeQuarter,
  toIsoDate,
  toPaise,
} from './tdsTypes.js'

/**
 * Parser for a Tally XML voucher export containing TDS entries.
 *
 * TDS in Tally lives as ledger entries within Purchase / Journal
 * vouchers whose LEDGERNAME matches TDS patterns. Structure (relevant
 * fields):
 *   <VOUCHER VCHTYPE="Purchase" or "Journal">
 *     <DATE>20260615</DATE>
 *     <VOUCHERNUMBER>...</VOUCHERNUMBER>
 *     <PARTYNAME>Acme Steel</PARTYNAME>
 *     <PARTYGSTIN>...</PARTYGSTIN>      (may hold TAN in some setups)
 *     <PARTYTAN>BLRA00001A</PARTYTAN>   (Tally's TDS master field)
 *     <ALLLEDGERENTRIES.LIST>
 *       <LEDGERNAME>Professional Fees</LEDGERNAME>
 *       <AMOUNT>-100000.00</AMOUNT>
 *     </ALLLEDGERENTRIES.LIST>
 *     <ALLLEDGERENTRIES.LIST>
 *       <LEDGERNAME>TDS on Professional Fees 194J</LEDGERNAME>
 *       <AMOUNT>10000.00</AMOUNT>
 *     </ALLLEDGERENTRIES.LIST>
 *   </VOUCHER>
 *
 * We extract one entry per (voucher, TDS ledger). Section is inferred
 * from the ledger name (falls back to attribute).
 */

interface TallyVoucher {
  DATE?: string
  VOUCHERNUMBER?: string
  PARTYNAME?: string
  PARTYTAN?: string
  PARTYGSTIN?: string
  PARTYLEDGERNAME?: string
  'ALLLEDGERENTRIES.LIST'?: TallyLedgerEntry | TallyLedgerEntry[]
  ['@_VCHTYPE']?: string
}
interface TallyLedgerEntry {
  LEDGERNAME?: string
  AMOUNT?: string | number
  TDSDEDUCTEEAMOUNT?: string | number
}

const TDS_RE = /(tds|tax\s*deducted)/i

function tallyDateToIso(v: string | undefined): string {
  if (!v) return ''
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v.trim())
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  return toIsoDate(v)
}

function amountToPaise(v: unknown): number {
  const n = Math.abs(Number(v ?? 0))
  return Number.isFinite(n) ? toPaise(n) : 0
}

export function parseTdsBooksTallyXml(bytes: Buffer): ParsedTdsBooks {
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '@_',
    parseAttributeValue: false, trimValues: true,
  })
  let doc: unknown
  try { doc = parser.parse(bytes.toString('utf8')) } catch {
    throw new Error('tds_books_tally_xml_invalid')
  }

  const vouchers: TallyVoucher[] = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'VOUCHER') {
        if (Array.isArray(val)) vouchers.push(...(val as TallyVoucher[]))
        else vouchers.push(val as TallyVoucher)
      } else if (val && typeof val === 'object') walk(val)
    }
  }
  walk(doc)

  const entries: NormalizedTdsEntry[] = []
  for (const v of vouchers) {
    const vchType = v['@_VCHTYPE'] ?? ''
    if (vchType && !/purchase|journal/i.test(vchType)) continue

    const raw = v['ALLLEDGERENTRIES.LIST']
    const ledger: TallyLedgerEntry[] = Array.isArray(raw) ? (raw as TallyLedgerEntry[]) : raw ? [raw as TallyLedgerEntry] : []

    // Find the base-amount entry (non-TDS ledger with the largest absolute amount).
    const nonTds = ledger.filter((e) => e.LEDGERNAME && !TDS_RE.test(e.LEDGERNAME))
    const base = nonTds.sort((a, b) => Math.abs(Number(b.AMOUNT ?? 0)) - Math.abs(Number(a.AMOUNT ?? 0)))[0]

    const tan = normalizeTan(v.PARTYTAN ?? v.PARTYGSTIN ?? '')
    const tdsDate = tallyDateToIso(v.DATE)
    if (!tan || !tdsDate) continue

    // One entry per TDS ledger row in this voucher.
    for (const e of ledger) {
      if (!e.LEDGERNAME || !TDS_RE.test(e.LEDGERNAME)) continue
      const section = normalizeSection(e.LEDGERNAME)
      if (!section) continue
      entries.push({
        section,
        deductorTan: tan,
        deductorName: v.PARTYNAME ?? v.PARTYLEDGERNAME ?? undefined,
        quarter: normalizeQuarter(tdsDate),
        amountPaid: amountToPaise(base?.AMOUNT ?? 0),
        tdsAmount: amountToPaise(e.AMOUNT),
        tdsDate,
      })
    }
  }

  return { entries }
}
