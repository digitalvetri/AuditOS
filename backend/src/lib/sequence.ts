import type { Prisma } from '@prisma/client'

/**
 * Serialise a read-max-then-insert number allocation.
 *
 * Every human-readable number in Audit OS (PMT-00012, LT sequence, PS-…,
 * EXP-…, QT-2026-0001, …) is allocated by reading the current maximum and
 * adding one, then inserting into an @unique column. Running that inside a
 * transaction is NOT enough: under READ COMMITTED two transactions read the
 * same maximum and the second insert dies on the unique index (a 500 to the
 * user). A transaction-scoped advisory lock keyed on the sequence name makes
 * the second allocator wait until the first commits, after which its read
 * sees the new row.
 *
 * Rules:
 *  - Call it FIRST, before reading the maximum, and only with the client
 *    of an interactive `prisma.$transaction`: an xact lock taken in
 *    autocommit is released at once and protects nothing. The parameter
 *    type documents this but cannot enforce it (PrismaClient is
 *    structurally assignable), so callers must pass `tx`.
 *  - The lock is re-entrant within one transaction, so allocating several
 *    numbers in a loop is fine.
 *  - Lock order, to avoid deadlocks, when one transaction takes several:
 *      liability:<category>  →  payslip_no  →  payment_no  →  ledger
 *    Never take `ledger` and then `payment_no`.
 *  - Locks are held until commit, so keep the work after them short.
 */
export async function lockSequence(tx: Prisma.TransactionClient, name: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${name}))`
}

/** The highest numeric suffix after `prefix`, ignoring codes that do not parse (test fixtures). */
export function maxSuffix(codes: string[], prefix: string): number {
  let max = 0
  for (const c of codes) {
    if (!c.startsWith(prefix)) continue
    const n = Number(c.slice(prefix.length))
    if (Number.isInteger(n) && n > max) max = n
  }
  return max
}

/**
 * Next employee code 'AO-0001'. Locked, then the first free code at or
 * above the number of employees — the same probing rule the two creating
 * routes used, now race-free. Call inside the creating transaction.
 */
export async function nextEmployeeCode(tx: Prisma.TransactionClient): Promise<string> {
  await lockSequence(tx, 'employee_code')
  let n = (await tx.employee.count()) + 1
  for (;;) {
    const code = `AO-${String(n).padStart(4, '0')}`
    if (!(await tx.employee.findUnique({ where: { employeeCode: code }, select: { id: true } }))) return code
    n += 1
  }
}
