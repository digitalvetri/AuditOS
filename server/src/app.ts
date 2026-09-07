import cors from 'cors'
import cookieParser from 'cookie-parser'
import express from 'express'
import { env } from './lib/env.js'
import { errorMiddleware, ok } from './lib/http.js'
import { authenticate } from './platform/auth.js'
import { authRouter } from './modules/auth.routes.js'
import { employeesRouter } from './modules/employees.routes.js'
import { attendanceRouter } from './modules/attendance.routes.js'
import { leaveRouter } from './modules/leave.routes.js'
import { documentsRouter } from './modules/documents.routes.js'
import { settingsRouter } from './modules/settings.routes.js'
import { auditRouter, dashboardRouter, notificationsRouter } from './modules/platform.routes.js'
import { payrollRouter, salaryRouter } from './modules/payroll/routes.js'
import { expensesRouter } from './modules/expenses/routes.js'
import { accountsRouter, paymentsRouter } from './modules/accounts/routes.js'
import { chatsRouter } from './modules/messages/routes.js'
import { reportsRouter } from './modules/reports/routes.js'
import { signedRouter } from './modules/signed.routes.js'
// Workstation (AUDIT_OS_WORKSTATION.md §8) — the operational workspace.
import { leadsRouter } from './modules/workstation/leads.routes.js'
import { clientsRouter } from './modules/workstation/clients.routes.js'
import { servicesRouter, serviceCatalogRouter } from './modules/workstation/services.routes.js'
import { followUpsRouter } from './modules/workstation/followups.routes.js'
import {
  documentsRouter as wsDocumentsRouter,
  documentCategoriesRouter,
  workstationSignedRouter,
} from './modules/workstation/documents.routes.js'
import { workstationRouter } from './modules/workstation/workstation.routes.js'

/**
 * The HTTP surface. Every route below /api answers in the Part 1 envelope
 * ({ data } / { error }), so the React adapter in src/services/api.ts needs
 * no branch between mock mode and real mode.
 *
 * Pipeline per request: authenticate → authorize → validate → handle → audit.
 * `authenticate` is mounted once, here; authorization is per route because
 * the permission differs per route.
 */
export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)

  // Credentialed CORS: an explicit origin allow-list, never '*'. In the
  // default dev setup Vite proxies /api, so this only matters when the
  // frontend is served from a different origin.
  app.use(cors({
    origin(origin, callback) {
      if (!origin || env.webOrigins.includes(origin)) return callback(null, true)
      callback(new Error('Origin not allowed'))
    },
    credentials: true,
  }))
  app.use(cookieParser())
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: true }))

  app.get('/api/health', (_req, res) => ok(res, { status: 'up', at: new Date().toISOString() }))

  // Public: login. /me and /logout authenticate inside the router.
  app.use('/api/auth', authRouter)

  // Public: signed-URL downloads. The HMAC in the query string IS the
  // authorization, which is what lets a browser navigation fetch the file.
  app.use('/api', signedRouter)
  // Workstation document downloads authorise via the HMAC in the query
  // string, so they mount alongside the other signed routes — before
  // `authenticate`, which a browser navigation cannot satisfy.
  app.use('/api', workstationSignedRouter)

  // Everything else requires a session.
  app.use('/api', authenticate)

  app.use('/api/employees', employeesRouter)
  // Salary lives under an employee but is owned by payroll (§8.4).
  app.use('/api/employees/:id/salary', salaryRouter)
  app.use('/api/attendance', attendanceRouter)
  app.use('/api/leaves', leaveRouter)
  app.use('/api/documents', documentsRouter)
  app.use('/api/settings', settingsRouter)
  app.use('/api/notifications', notificationsRouter)
  app.use('/api/audit-logs', auditRouter)
  app.use('/api/dashboard', dashboardRouter)
  app.use('/api/payroll', payrollRouter)
  app.use('/api/expenses', expensesRouter)
  app.use('/api/accounts', accountsRouter)
  app.use('/api/payments', paymentsRouter)
  app.use('/api/chats', chatsRouter)
  app.use('/api/reports', reportsRouter)

  // ── Workstation ────────────────────────────────────────────────────────
  // Every route below runs authenticate → authorize(workstation.*, scope) →
  // validate → handle → activity/audit. A caller without a workstation grant
  // (hr_admin, finance_admin) gets 403 here, not an empty list.
  app.use('/api/workstation', workstationRouter)
  app.use('/api/leads', leadsRouter)
  app.use('/api/clients', clientsRouter)
  app.use('/api/services', servicesRouter)
  app.use('/api/service-catalog', serviceCatalogRouter)
  app.use('/api/follow-ups', followUpsRouter)
  // NOT '/api/documents': that path already belongs to the HRMS
  // EmployeeDocument router mounted above, and Express matches the first
  // mount — so mounting here would shadow the Workstation list and silently
  // serve employee documents instead. §16 of the build prompt named
  // /api/documents/:id; the platform owns it, so client documents are
  // namespaced. /api/clients/:id/documents is unchanged and unambiguous.
  app.use('/api/client-documents', wsDocumentsRouter)
  app.use('/api/document-categories', documentCategoriesRouter)

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint.' } })
  })
  app.use(errorMiddleware)
  return app
}
