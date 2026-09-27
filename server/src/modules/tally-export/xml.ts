/**
 * Tally XML writer — docs/tally-export/README.md, Appendix A.
 *
 * Emits the `ENVELOPE` shape TallyPrime expects for a Vouchers import.
 * One `<TALLYMESSAGE>` per voucher, two `<ALLLEDGERENTRIES.LIST>` blocks
 * per voucher (Dr + Cr), sign convention from the doc's sample:
 *
 *   Debit line   ISDEEMEDPOSITIVE=Yes, AMOUNT is NEGATIVE
 *   Credit line  ISDEEMEDPOSITIVE=No,  AMOUNT is POSITIVE
 *
 * The spec (§1.1 / Appendix A) explicitly warns Tally's documentation
 * contradicts itself on this three ways, so this needs to be checked
 * against a real exported voucher before large imports. If a test import
 * comes back inverted, flip the two `signFor()` branches below and
 * leave a comment naming the fixture.
 *
 * XML escaping: only the five entities that must be escaped, applied on
 * every user-supplied string (ledger names, narrations, voucher numbers,
 * bank ledger name). Indian bank narrations routinely contain `&`
 * (e.g. "SRI VARI TRADERS & CO") so this is not optional.
 */
import type { PreviewRow, VoucherType } from './types.js'

/** Payment | Receipt | Contra | Journal — Tally uses title case. */
function tallyVoucherType(t: VoucherType | null): string {
  switch (t) {
    case 'payment': return 'Payment'
    case 'receipt': return 'Receipt'
    case 'contra':  return 'Contra'
    case 'journal': return 'Journal'
    default:        return 'Payment' // preflight rejects rows with no type, so this is unreachable in a valid export
  }
}

/** YYYYMMDD, no separators. Rejects the row if the input date is bad. */
function tallyDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) throw new Error(`Bad row date ${iso} — expected YYYY-MM-DD.`)
  return m[1] + m[2] + m[3]
}

/** Paise → "-124000.00" style. Two decimals always. */
function tallyAmount(paise: number, negative: boolean): string {
  const abs = (Math.abs(paise) / 100).toFixed(2)
  return negative ? `-${abs}` : abs
}

const ESC_MAP: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC_MAP[c])
}

/** Two ledger lines per voucher. Order is: counter first, bank second. */
function ledgerLines(row: PreviewRow, bankLedgerName: string): {
  ledgerName: string; isDeemedPositive: 'Yes' | 'No'; amountPaise: number; negative: boolean;
}[] {
  const amountPaise = row.debit_paise > 0 ? row.debit_paise : row.credit_paise
  const counter = row.ledger_name ?? ''
  const bank = bankLedgerName

  if (row.direction === 'withdrawal') {
    // Payment / Contra: counter Dr, bank Cr
    return [
      { ledgerName: counter, isDeemedPositive: 'Yes', amountPaise, negative: true  },
      { ledgerName: bank,    isDeemedPositive: 'No',  amountPaise, negative: false },
    ]
  }
  // Receipt / Contra deposit: bank Dr, counter Cr
  return [
    { ledgerName: bank,    isDeemedPositive: 'Yes', amountPaise, negative: true  },
    { ledgerName: counter, isDeemedPositive: 'No',  amountPaise, negative: false },
  ]
}

/**
 * Serialise the resolved preview rows into a Tally-XML import envelope.
 * Caller guarantees every row has a `ledger_name` and a `voucher_type` —
 * preflight blocks export otherwise, so this function does not re-check.
 */
export function formatVouchersXml(input: {
  rows: PreviewRow[]
  bankLedgerName: string
}): string {
  const messages: string[] = []
  for (const row of input.rows) {
    const vchType = tallyVoucherType(row.voucher_type)
    const date = tallyDate(row.date)
    const lines = ledgerLines(row, input.bankLedgerName)

    const entries = lines.map((l) => `
          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>${esc(l.ledgerName)}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>${l.isDeemedPositive}</ISDEEMEDPOSITIVE>
            <AMOUNT>${tallyAmount(l.amountPaise, l.negative)}</AMOUNT>
          </ALLLEDGERENTRIES.LIST>`).join('')

    messages.push(`
      <TALLYMESSAGE>
        <VOUCHER VCHTYPE="${esc(vchType)}" ACTION="Create">
          <DATE>${date}</DATE>
          <VOUCHERTYPENAME>${esc(vchType)}</VOUCHERTYPENAME>
          <VOUCHERNUMBER>${esc(row.voucher_number)}</VOUCHERNUMBER>
          <NARRATION>${esc(row.description || '')}</NARRATION>${entries}
        </VOUCHER>
      </TALLYMESSAGE>`)
  }

  // The envelope shape is from Appendix A. No `<STATICVARIABLES>` — we
  // rely on the operator to have the correct company open in Tally when
  // they import. Tally has no way to name a company in the file.
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Import</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>Vouchers</ID>
  </HEADER>
  <BODY>
    <DESC></DESC>
    <DATA>${messages.join('')}
    </DATA>
  </BODY>
</ENVELOPE>
`
}
