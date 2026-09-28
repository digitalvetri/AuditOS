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
  /** The supplier's own invoice number / date (Tally: "Supplier Invoice No."). */
  REFERENCE?: string | number
  REFERENCEDATE?: string
  'ALLLEDGERENTRIES.LIST'?: TallyLedgerEntry | TallyLedgerEntry[]
  'LEDGERENTRIES.LIST'?: TallyLedgerEntry | TallyLedgerEntry[]
  ['@_VCHTYPE']?: string
}
interface TallyLedgerEntry {
  LEDGERNAME?: string
  AMOUNT?: string | number
  ISPARTYLEDGER?: string
}

const IGST_RE = /\bigst\b|integrated/i
const CGST_RE = /\bcgst\b|central\s*(gst|tax)/i
// Not bare "state": "Interstate Purchase" is a purchase ledger, not SGST.
const SGST_RE = /\b(sgst|utgst)\b|state\s*(gst|tax)|ut\s*tax/i
const CESS_RE = /\bcess\b/i
const isTax = (n: string) => IGST_RE.test(n) || CGST_RE.test(n) || SGST_RE.test(n) || CESS_RE.test(n) || /round\s*off|tds|tcs/i.test(n)

function pickAmount(entries: TallyLedgerEntry[], test: RegExp): number {
  return entries.filter((e) => e.LEDGERNAME && test.test(e.LEDGERNAME))
    .reduce((t, e) => { const n = Math.abs(Number(e.AMOUNT ?? 0)); return t + (Number.isFinite(n) ? toPaise(n) : 0) }, 0)
}

/**
 * Taxable value = every purchase ledger on the voucher — not the party
 * (supplier) ledger, which carries the gross amount, and not tax,
 * round-off, TDS or TCS ledgers.
 */
function isPartyEntry(e: TallyLedgerEntry, party: string): boolean {
  if (String(e.ISPARTYLEDGER ?? '').toLowerCase() === 'yes') return true
  return Boolean(party) && String(e.LEDGERNAME ?? '').trim().toLowerCase() === party.trim().toLowerCase()
}
/** The purchase / expense ledgers — everything that is neither the party nor a tax. */
function goodsEntries(entries: TallyLedgerEntry[], party: string): TallyLedgerEntry[] {
  return entries.filter((e) => {
    const n = String(e.LEDGERNAME ?? '')
    return Boolean(n) && !isTax(n) && !isPartyEntry(e, party)
  })
}
const paiseOf = (e: TallyLedgerEntry) => { const v = Math.abs(Number(e.AMOUNT ?? 0)); return Number.isFinite(v) ? toPaise(v) : 0 }
function taxableFromEntries(entries: TallyLedgerEntry[], party: string): number {
  return goodsEntries(entries, party).reduce((t, e) => t + paiseOf(e), 0)
}

function tallyDateToIso(v: string | number | undefined): string {
  if (v === undefined || v === null || v === '') return ''
  // YYYYMMDD → YYYY-MM-DD
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(v).trim())
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  return toIsoDate(String(v))
}

export function parsePurchaseRegisterTallyXml(bytes: Buffer): ParsedPurchaseRegister {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false,
    // Keep every value as text: dates (20260410) and invoice numbers (000123)
    // must not become numbers — leading zeros would be lost.
    parseTagValue: false,
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
    const type = v['@_VCHTYPE'] ?? ''
    // Purchases, and Debit Notes (purchase returns — the supplier's credit note in 2B).
    const isReturn = /debit\s*note/i.test(type)
    if (type && !/purchase/i.test(type) && !isReturn) continue
    // The supplier's invoice number is what GSTR-2B carries; Tally's own voucher number is internal.
    const invoiceNumber = String(v.REFERENCE ?? '').trim() || String(v.VOUCHERNUMBER ?? '').trim()
    const invoiceDate = tallyDateToIso(v.REFERENCEDATE) || tallyDateToIso(v.DATE)
    const gstin = String(v.PARTYGSTIN ?? '').trim()
    if (!invoiceNumber || !gstin) continue

    const raw = v['ALLLEDGERENTRIES.LIST'] ?? v['LEDGERENTRIES.LIST']
    const ledgerEntries: TallyLedgerEntry[] = Array.isArray(raw)
      ? (raw as TallyLedgerEntry[])
      : raw
        ? [raw as TallyLedgerEntry]
        : []
    const party = String(v.PARTYLEDGERNAME ?? v.PARTYNAME ?? '')
    const sign = isReturn ? -1 : 1
    // The ledgers it was booked to — what the s.17(5) blocked-credit check reads.
    const glCode = [...new Set(goodsEntries(ledgerEntries, party).map((e) => String(e.LEDGERNAME).trim()))].join(', ')
    const partyEntry = ledgerEntries.find((e) => isPartyEntry(e, party))
    const rcm = Object.entries(v).some(([k, val]) => /REVERSECHARGE/i.test(k) && /^(yes|y|true)$/i.test(String(val).trim()))

    entries.push({
      supplierGstin: gstin,
      supplierName: party.trim() || undefined,
      invoiceNumber,
      invoiceDate,
      docType: isReturn ? 'CRN' : 'INV',
      taxableValue: sign * taxableFromEntries(ledgerEntries, party),
      igst: sign * pickAmount(ledgerEntries, IGST_RE),
      cgst: sign * pickAmount(ledgerEntries, CGST_RE),
      sgst: sign * pickAmount(ledgerEntries, SGST_RE),
      cess: sign * pickAmount(ledgerEntries, CESS_RE),
      ...(glCode ? { glCode } : {}),
      ...(partyEntry ? { invoiceValue: sign * paiseOf(partyEntry) } : {}),
      ...(rcm ? { reverseCharge: true } : {}),
    })
  }

  return { entries }
}
