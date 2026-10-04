import { createServer } from 'node:http'
import { env } from './lib/env.js'
import { createApp } from './app.js'
import { attachRealtime } from './modules/messages/realtime.js'
import { prisma } from './lib/prisma.js'
import { applyTaskInvariants } from './modules/task/db/invariants.js'
import { applyPayrollInvariants } from './modules/payroll/db/invariants.js'
import { backfillInvoicePayments } from './modules/invoice/payments.js'
import { startEinvoiceEwbScheduler } from './modules/workstation/einvoice-ewb/scheduler.js'
import { startTdsReminderScheduler } from './modules/tds/reminders.js'
import { startGstReminderScheduler } from './modules/gst/reminders.js'
import { startPostRegistrationReminderScheduler } from './modules/partnership/postRegReminders.js'
import { startBooksSyncScheduler } from './modules/books/scheduler.js'
import { AaExtractService } from './modules/audit-automation/services/AaExtractService.js'

const app = createApp()
const http = createServer(app)
attachRealtime(http)

// Task work-session invariants: one open session per task, one per employee.
applyTaskInvariants(prisma).then((n) => console.log(`Task invariants applied (${n} statements)`)).catch((e) => console.error('[task] invariants', e))

// Payroll period invariant: a monthly run's period is (day 1) → (last day
// of the same month). Backstops the application-level derivation for any
// caller that skips it (§3 fix for the malformed 2026-12-30 → 2027-01-30
// row).
applyPayrollInvariants(prisma).then((n) => console.log(`Payroll invariants applied (${n} statements)`)).catch((e) => console.error('[payroll] invariants', e))
// Invoices paid before payment history was kept get one history row each.
backfillInvoicePayments(prisma).then((n) => { if (n) console.log(`Invoice payment history backfilled (${n} invoices)`) }).catch((e) => console.error('[invoice] payment backfill', e))

// E-Invoice & E-Way Bill monthly pull (E-INVOICE-EWAYBILL.md §2.4 / §3.4).
startEinvoiceEwbScheduler(prisma)
startTdsReminderScheduler(prisma)
startGstReminderScheduler(prisma)
startPostRegistrationReminderScheduler(prisma)
startBooksSyncScheduler()

http.listen(env.port, () => {
  // Bank statements a restart interrupted mid-read are read again, not left "queued".
  void AaExtractService.recoverStuck().catch((e) => console.warn('[audit-automation] recovery failed', e instanceof Error ? e.message : e))
  console.log(`Audit OS HRMS API on http://localhost:${env.port} (${env.nodeEnv})`)
  console.log(`CORS origins: ${env.webOrigins.join(', ')}`)
})
