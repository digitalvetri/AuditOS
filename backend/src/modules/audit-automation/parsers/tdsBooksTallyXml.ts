import { XMLParser } from 'fast-xml-parser'
import {
  type NormalizedTdsEntry,
  type ParsedTdsBooks,
  normalizeSection,
  normalizeTan,
  normalizeQuarter,
  tdsDate,
  toPaise,
  TAN_RE,
} from './tdsTypes.js'

/**
 * The client's own books, as a Tally XML voucher export — the TDS its
 * customers deducted, which 26AS must show as credits.
 *
 * In the books that is a debit to a TDS-receivable ledger, usually in the
 * receipt that settles the customer's invoice:
 *
 *   <VOUCHER VCHTYPE="Receipt">
 *     <DATE>20260615</DATE> <VOUCHERNUMBER>RC-12</VOUCHERNUMBER>
 *     <PARTYLEDGERNAME>Acme Steel Pvt Ltd</PARTYLEDGERNAME>
 *     <ALLLEDGERENTRIES.LIST> Acme Steel Pvt Ltd    AMOUNT  100000.00  (credit — the gross settled)
 *     <ALLLEDGERENTRIES.LIST> HDFC Bank             AMOUNT  -90000.00  (debit)
 *     <ALLLEDGERENTRIES.LIST> TDS Receivable 194J   AMOUNT  -10000.00  (debit — the credit to claim)
 *   </VOUCHER>
 *
 * Tally writes debits as negative amounts. A credit to the receivable
 * ledger (a reversal) comes through as a negative entry. TDS the client
 * itself deducted (TDS payable, credited in purchases) is not a 26AS
 * credit and is skipped.
 *
 * The deductor's TAN is read from the voucher when Tally carries it
 * (PARTYTAN / DEDUCTORTAN / TANNUMBER); a GSTIN is never taken for a TAN.
 * Without a TAN the matcher pairs by the deductor's name.
 */

type Val = string | number | undefined
interface TallyLedgerEntry {
  LEDGERNAME?: Val
  AMOUNT?: Val
  ISDEEMEDPOSITIVE?: Val
  ISPARTYLEDGER?: Val
  [k: string]: unknown
}
interface TallyVoucher {
  DATE?: Val
  EFFECTIVEDATE?: Val
  VOUCHERNUMBER?: Val
  REFERENCE?: Val
  PARTYNAME?: Val
  PARTYLEDGERNAME?: Val
  PARTYTAN?: Val
  DEDUCTORTAN?: Val
  TANNUMBER?: Val
  NARRATION?: Val
  'ALLLEDGERENTRIES.LIST'?: TallyLedgerEntry | TallyLedgerEntry[]
  'LEDGERENTRIES.LIST'?: TallyLedgerEntry | TallyLedgerEntry[]
  ['@_VCHTYPE']?: string
  [k: string]: unknown
}

const TDS_RE = /\b(tds|tcs)\b|tax\s*(deducted|collected)\s*at\s*source/i
const PAYABLE_RE = /payable|\bpay\b|deducted\s*by\s*us|on\s*purchase/i
const RECEIVABLE_RE = /receivable|recoverable|\brec\b|advance|claim|asset/i

const str = (v: Val) => (v === undefined || v === null ? '' : String(v).trim())
const amt = (v: Val) => { const n = Number(str(v).replace(/,/g, '')); return Number.isFinite(n) ? n : 0 }

export function parseTdsBooksTallyXml(bytes: Buffer): ParsedTdsBooks {
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '@_',
    parseAttributeValue: false, parseTagValue: false, trimValues: true,
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
    const vchType = str(v['@_VCHTYPE'] as Val)
    if (/purchase|payment/i.test(vchType)) continue
    const raw = v['ALLLEDGERENTRIES.LIST'] ?? v['LEDGERENTRIES.LIST']
    const ledger: TallyLedgerEntry[] = Array.isArray(raw) ? raw : raw ? [raw] : []
    const date = tdsDate(str(v.DATE) || str(v.EFFECTIVEDATE))
    if (!date) continue

    const party = str(v.PARTYLEDGERNAME) || str(v.PARTYNAME)
    const isTds = (e: TallyLedgerEntry) => TDS_RE.test(str(e.LEDGERNAME)) && !PAYABLE_RE.test(str(e.LEDGERNAME))
    const partyEntry = ledger.find((e) => str(e.ISPARTYLEDGER).toLowerCase() === 'yes' || (party && str(e.LEDGERNAME).toLowerCase() === party.toLowerCase()))
    const tanRaw = normalizeTan(str(v.PARTYTAN) || str(v.DEDUCTORTAN) || str(v.TANNUMBER))
    const tan = TAN_RE.test(tanRaw) ? tanRaw : ''
    // Section: from the TDS ledger's name, else anywhere on the voucher (a TDS nature-of-payment field, the narration).
    const voucherSection = normalizeSection(Object.entries(v)
      .filter(([k, val]) => typeof val === 'string' && /TDS|NATURE|SECTION|NARRATION/i.test(k)).map(([, val]) => val as string).join(' '))

    for (const e of ledger) {
      const name = str(e.LEDGERNAME)
      if (!name || !isTds(e)) continue
      const a = amt(e.AMOUNT)
      if (!a) continue
      const debit = a < 0 || str(e.ISDEEMEDPOSITIVE).toLowerCase() === 'yes'
      // A credit to a plain "TDS" ledger in a receipt is ambiguous; only a named receivable ledger is reversed.
      if (!debit && !RECEIVABLE_RE.test(name)) continue
      const sign = debit ? 1 : -1
      const gross = partyEntry ? Math.abs(amt(partyEntry.AMOUNT)) : ledger.filter((x) => x !== e && amt(x.AMOUNT) > 0).reduce((t, x) => t + amt(x.AMOUNT), 0)
      entries.push({
        section: normalizeSection(name) || voucherSection,
        deductorTan: tan,
        deductorName: party || undefined,
        quarter: normalizeQuarter(date),
        amountPaid: sign * toPaise(gross),
        tdsAmount: sign * toPaise(Math.abs(a)),
        tdsDate: date,
        glCode: name,
        reference: str(v.REFERENCE) || str(v.VOUCHERNUMBER) || undefined,
        voucherType: vchType || undefined,
      })
    }
  }

  return { entries }
}
