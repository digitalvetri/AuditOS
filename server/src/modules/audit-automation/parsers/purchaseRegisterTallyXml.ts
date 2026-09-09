import { XMLParser } from 'fast-xml-parser'
import {
  type NormalizedEntry,
  type ParsedPurchaseRegister,
  toPaise,
  toIsoDate,
} from './types.js'

/**
 * Parser for a Tally Day Book / Voucher Register XML export.
 *
 * Tally XML uses upper-case tag names and has this rough shape for a
 * purchase voucher:
 *   <VOUCHER VCHTYPE="Purchase">
 *     <DATE>20260410</DATE>                              yyyymmdd
 *     <VOUCHERNUMBER>INV/24/0007</VOUCHERNUMBER>
 *     <PARTYNAME>Acme Steel</PARTYNAME>
 *     <PARTYGSTIN>07AABCU9603R1ZX</PARTYGSTIN>
 *     <ALLLEDGERENTRIES.LIST>
 *       <LEDGERNAME>Purchase - Steel</LEDGERNAME>
 *       <AMOUNT>-100000.00</AMOUNT>              taxable
 *       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
 *     </ALLLEDGERENTRIES.LIST>
 *     <ALLLEDGERENTRIES.LIST>
 *       <LEDGERNAME>IGST 18%</LEDGERNAME>
 *       <AMOUNT>-18000.00</AMOUNT>
 *     </ALLLEDGERENTRIES.LIST>
 *   </VOUCHER>
 *
 * We ignore the sign convention (Tally uses negative for credits); we
 * just take the absolute amount and bucket it into taxable / IGST / CGST
 * / SGST / cess based on the ledger name pattern.
 */

interface TallyVoucher {
  DATE?: string
  VOUCHERNUMBER?: string
  PARTYNAME?: string
  PARTYGSTIN?: string
  PARTYLEDGERNAME?: string
  'ALLLEDGERENTRIES.LIST'?: TallyLedgerEntry | TallyLedgerEntry[]
  ['@_VCHTYPE']?: string
}
interface TallyLedgerEntry {
  LEDGERNAME?: string
  AMOUNT?: string | number
}

const IGST_RE = /igst|integrated/i
const CGST_RE = /cgst|central/i
const SGST_RE = /sgst|state|utgst/i
const CESS_RE = /cess/i

function pickAmount(entries: TallyLedgerEntry[], test: RegExp): number {
  const hit = entries.find((e) => e.LEDGERNAME && test.test(e.LEDGERNAME))
  if (!hit) return 0
  const n = Math.abs(Number(hit.AMOUNT ?? 0))
  return Number.isFinite(n) ? toPaise(n) : 0
}

function taxableFromEntries(entries: TallyLedgerEntry[]): number {
  // Taxable = any purchase ledger (not IGST/CGST/SGST/cess).
  const purchase = entries.find((e) => {
    const n = e.LEDGERNAME ?? ''
    return n && !IGST_RE.test(n) && !CGST_RE.test(n) && !SGST_RE.test(n) && !CESS_RE.test(n)
  })
  if (!purchase) return 0
  const n = Math.abs(Number(purchase.AMOUNT ?? 0))
  return Number.isFinite(n) ? toPaise(n) : 0
}

function tallyDateToIso(v: string | undefined): string {
  if (!v) return ''
  // YYYYMMDD → YYYY-MM-DD
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v.trim())
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  return toIsoDate(v)
}

export function parsePurchaseRegisterTallyXml(bytes: Buffer): ParsedPurchaseRegister {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false,
    trimValues: true,
  })
  let doc: unknown
  try { doc = parser.parse(bytes.toString('utf8')) } catch {
    throw new Error('pr_tally_xml_invalid')
  }

  // Voucher containers vary across Tally exports; walk to find VOUCHER nodes.
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

  const entries: NormalizedEntry[] = []
  for (const v of vouchers) {
    if (v['@_VCHTYPE'] && !/purchase/i.test(v['@_VCHTYPE'])) continue
    const invoiceNumber = String(v.VOUCHERNUMBER ?? '').trim()
    const invoiceDate = tallyDateToIso(v.DATE)
    const gstin = String(v.PARTYGSTIN ?? '').trim()
    if (!invoiceNumber || !gstin) continue

    const raw = v['ALLLEDGERENTRIES.LIST']
    const ledgerEntries: TallyLedgerEntry[] = Array.isArray(raw)
      ? (raw as TallyLedgerEntry[])
      : raw
        ? [raw as TallyLedgerEntry]
        : []

    entries.push({
      supplierGstin: gstin,
      supplierName: String(v.PARTYNAME ?? v.PARTYLEDGERNAME ?? '').trim() || undefined,
      invoiceNumber,
      invoiceDate,
      taxableValue: taxableFromEntries(ledgerEntries),
      igst: pickAmount(ledgerEntries, IGST_RE),
      cgst: pickAmount(ledgerEntries, CGST_RE),
      sgst: pickAmount(ledgerEntries, SGST_RE),
      cess: pickAmount(ledgerEntries, CESS_RE),
    })
  }

  return { entries }
}
