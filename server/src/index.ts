import { createServer } from 'node:http'
import { env } from './lib/env.js'
import { createApp } from './app.js'
import { attachRealtime } from './modules/messages/realtime.js'
import { prisma } from './lib/prisma.js'
import { applyBooksInvariants } from './modules/books/db/invariants.js'
import { startEinvoiceEwbScheduler } from './modules/workstation/einvoice-ewb/scheduler.js'

const app = createApp()
const http = createServer(app)
attachRealtime(http)

// The Books ledger invariants are database triggers; make sure they exist
// before the first request, whatever created the tables.
applyBooksInvariants(prisma).then((n) => console.log(`Books invariants applied (${n} statements)`)).catch((e) => console.error('[books] invariants', e))

// E-Invoice & E-Way Bill monthly pull (E-INVOICE-EWAYBILL.md §2.4 / §3.4).
startEinvoiceEwbScheduler(prisma)

http.listen(env.port, () => {
  console.log(`Audit OS HRMS API on http://localhost:${env.port} (${env.nodeEnv})`)
  console.log(`CORS origins: ${env.webOrigins.join(', ')}`)
})
