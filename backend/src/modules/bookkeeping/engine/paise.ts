import { numify, type Numified } from '../../../lib/money.js'

/**
 * The Bookkeeping money columns are BigInt (int8) so a client's ₹30 crore
 * capital or loan fits. Prisma hands those back as `bigint`; the engines
 * and the API work in `number` (exact for integer paise up to 2^53).
 * These mappers convert a loaded row once, where it is loaded — only the
 * listed fields that were actually selected are touched.
 */
function mapper<const Keys extends readonly string[]>(keys: Keys) {
  return <T extends object>(row: T): Numified<T, Extract<keyof T, Keys[number]>> =>
    numify(row, ...(keys.filter((k) => k in row) as Extract<keyof T, Keys[number]>[]))
}

/** BookkeepingVoucher header totals. */
export const voucherNums = mapper([
  'totalDebitPaise', 'totalCreditPaise', 'taxableValuePaise', 'cgstPaise', 'sgstPaise',
  'igstPaise', 'cessPaise', 'roundOffPaise', 'grandTotalPaise',
])
/** BookkeepingVoucherItem line. */
export const itemNums = mapper(['ratePaise', 'discountPaise', 'amountPaise', 'cgstPaise', 'sgstPaise', 'igstPaise', 'cessPaise'])
/** BookkeepingVoucherEntry line. */
export const entryNums = mapper(['amountPaise', 'foreignAmountMinor'])
/** BookkeepingBankStatementLine. */
export const statementLineNums = mapper(['debitPaise', 'creditPaise', 'balancePaise'])
/** BookkeepingLedger master. */
export const ledgerNums = mapper(['openingBalancePaise'])
