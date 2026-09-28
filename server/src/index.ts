import { createServer } from 'node:http'
import { env } from './lib/env.js'
import { createApp } from './app.js'
import { attachRealtime } from './modules/messages/realtime.js'
import { prisma } from './lib/prisma.js'
import { applyTaskInvariants } from './modules/task/db/invariants.js'
import { startEinvoiceEwbScheduler } from './modules/workstation/einvoice-ewb/scheduler.js'
import { AaExtractService } from './modules/audit-automation/services/AaExtractService.js'

const app = createApp()
const http = createServer(app)
attachRealtime(http)

// Task work-session invariants: one open session per task, one per employee.
applyTaskInvariants(prisma).then((n) => console.log(`Task invariants applied (${n} statements)`)).catch((e) => console.error('[task] invariants', e))

// E-Invoice & E-Way Bill monthly pull (E-INVOICE-EWAYBILL.md §2.4 / §3.4).
startEinvoiceEwbScheduler(prisma)

http.listen(env.port, () => {
  // Bank statements a restart interrupted mid-read are read again, not left "queued".
  void AaExtractService.recoverStuck().catch((e) => console.warn('[audit-automation] recovery failed', e instanceof Error ? e.message : e))
  console.log(`Audit OS HRMS API on http://localhost:${env.port} (${env.nodeEnv})`)
  console.log(`CORS origins: ${env.webOrigins.join(', ')}`)
})
