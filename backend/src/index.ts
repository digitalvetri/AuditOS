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
import { startRecurringInvoiceScheduler } from './modules/recurring/scheduler.js'
import { startDunningScheduler } from './modules/invoice/reminders.js'
import { startComplianceScheduler } from './modules/compliance/scheduler.js'
import { startAuditReminderScheduler } from './modules/audit/reminders.js'
import { startAuditChainScheduler } from './modules/data-protection/chain-check.js'
import { AaExtractService } from './modules/audit-automation/services/AaExtractService.js'
import { reportError } from './lib/errorReport.js'

// A stray rejection or throw outside a request must leave a trace with a
// stack, not vanish (or kill the process with nothing in the log).
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection', reason instanceof Error ? (reason.stack ?? reason.message) : reason)
  reportError(reason, 'unhandledRejection')
})
process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException', err.stack ?? err.message)
  reportError(err, 'uncaughtException')
  // State after an uncaught throw is unknown: exit (the container restarts
  // us) after a moment for the log line and report to flush.
  setTimeout(() => process.exit(1), 1000).unref()
})

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
// Retainer invoices (each run under an advisory lock) and, when INVOICE_DUNNING=on, overdue reminders.
startRecurringInvoiceScheduler()
startDunningScheduler()
startComplianceScheduler(prisma)
startAuditReminderScheduler(prisma)
// Daily audit-log hash-chain verification; Admins are alerted if it breaks.
startAuditChainScheduler(prisma)

http.listen(env.port, () => {
  // Bank statements a restart interrupted mid-read are read again, not left "queued".
  void AaExtractService.recoverStuck().catch((e) => console.warn('[audit-automation] recovery failed', e instanceof Error ? e.message : e))
  console.log(`Audit OS HRMS API on http://localhost:${env.port} (${env.nodeEnv})`)
  console.log(`CORS origins: ${env.webOrigins.join(', ')}`)
})

// Graceful shutdown (a deploy or `docker stop` sends SIGTERM): stop taking
// new connections, let in-flight requests finish, close the pool. Socket.IO
// and keep-alive connections can hold server.close() open indefinitely, so a
// force-exit timer caps the wait.
let shuttingDown = false
function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[process] ${signal} received — shutting down`)
  setTimeout(() => {
    console.warn('[process] forced exit after 10s')
    process.exit(1)
  }, 10_000).unref()
  http.close(() => {
    prisma.$disconnect()
      .catch((e) => console.error('[process] prisma disconnect', e instanceof Error ? e.message : e))
      .finally(() => process.exit(0))
  })
  // Idle keep-alive sockets would otherwise keep close() waiting.
  http.closeIdleConnections?.()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
