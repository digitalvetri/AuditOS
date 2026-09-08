import type { Db } from './context.js'

const PREFIX: Record<string, string> = {
  journal: 'JV-', opening: 'OB-', invoice: 'INV-', retainer_invoice: 'RET-', credit_note: 'CN-',
  estimate: 'EST-', sales_order: 'SO-', purchase_order: 'PO-', bill: 'BILL-', vendor_credit: 'VC-',
  payment_in: 'PMT-', payment_out: 'VPMT-', transfer: 'TRF-', revaluation: 'REV-', retainer_apply: 'RAP-',
  credit_apply: 'CNA-', vendor_credit_apply: 'VCA-', void: 'VOID-',
}

/**
 * Next document / voucher number for a kind, inside the caller's
 * transaction. The sequence row is updated with an atomic increment so two
 * concurrent posts cannot draw the same number.
 */
export async function nextNumber(db: Db, booksOrgId: string, kind: string): Promise<string> {
  const existing = await db.booksNumberSequence.findUnique({ where: { booksOrgId_kind: { booksOrgId, kind } } })
  if (!existing) {
    const created = await db.booksNumberSequence.create({ data: { booksOrgId, kind, prefix: PREFIX[kind] ?? `${kind.toUpperCase()}-`, next: 2 } })
    return `${created.prefix}${String(1).padStart(5, '0')}`
  }
  const updated = await db.booksNumberSequence.update({ where: { id: existing.id }, data: { next: { increment: 1 } } })
  return `${updated.prefix}${String(updated.next - 1).padStart(5, '0')}`
}

export async function setPrefix(db: Db, booksOrgId: string, kind: string, prefix: string): Promise<void> {
  await db.booksNumberSequence.upsert({
    where: { booksOrgId_kind: { booksOrgId, kind } },
    update: { prefix },
    create: { booksOrgId, kind, prefix, next: 1 },
  })
}
