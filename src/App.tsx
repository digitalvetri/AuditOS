import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes, Navigate } from 'react-router-dom';
import { AuthProvider } from '@/platform/auth/AuthContext';
import { ProtectedRoute } from '@/platform/auth/ProtectedRoute';
// New shell + dashboard per UI-BUILD-PROMPT.md. The v1 shell/dashboard still
// live at @/shell/AppShell and @/pages/Dashboard — kept for now so the diff
// is a swap, not a delete, and old modules render inside the new frame.
import { AppShellV2 as AppShell } from '@/shell/v2/AppShell';
import { LoginPage } from '@/pages/Login';
import { DashboardV2Page as DashboardPage } from '@/pages/DashboardV2';
// Workstation (AUDIT_OS_WORKSTATION.md §4) — replaces the reserved screen.
import { WorkstationDashboardPage } from '@/pages/workstation/Dashboard';
import { LeadsPage } from '@/pages/workstation/Leads';
import { LeadDetailPage } from '@/pages/workstation/LeadDetail';
import { ClientsPage } from '@/pages/workstation/Clients';
import { ClientWorkspacePage } from '@/pages/workstation/ClientWorkspace';
import { ServicesPage } from '@/pages/workstation/Services';
import { FollowUpsPage } from '@/pages/workstation/FollowUps';
import { DocumentsPage as WorkstationDocumentsPage } from '@/pages/workstation/Documents';
// Tools (Converters & Utilities) — registry-driven; /tools/:toolId is one
// shared workspace and /tools/documents the output history.
import { ToolsPage } from '@/pages/tools/Tools';
import { ToolWorkspacePage } from '@/pages/tools/ToolWorkspace';
import { ToolDocumentsPage } from '@/pages/tools/ToolDocuments';
// Audit Automation submodule (AMENDMENT-02-REPOTIC-GAPS.md).
import { AuditAutomationLandingPage } from '@/pages/tools/AuditAutomation';
import { BankJobsListPage } from '@/pages/tools/BankJobsList';
import { BankNewUploadPage } from '@/pages/tools/BankNewUpload';
import { BankJobDetailPage } from '@/pages/tools/BankJobDetail';
// GST reconciliation pipeline.
import { GstJobsListPage } from '@/pages/tools/GstJobsList';
import { GstNewReconPage } from '@/pages/tools/GstNewRecon';
import { GstReconDetailPage } from '@/pages/tools/GstReconDetail';
// TDS reconciliation pipeline.
import { TdsJobsListPage } from '@/pages/tools/TdsJobsList';
import { TdsNewReconPage } from '@/pages/tools/TdsNewRecon';
import { TdsReconDetailPage } from '@/pages/tools/TdsReconDetail';
// Tally — native double-entry accounting (Preview, Slice 1: Foundation).
import { TallyHome } from '@/pages/tools/tally/TallyHome';
import { TallyCompanies } from '@/pages/tools/tally/TallyCompanies';
import { TallyWorkspace } from '@/pages/tools/tally/TallyWorkspace';
import { TallyGroups } from '@/pages/tools/tally/TallyGroups';
import { TallyLedgers } from '@/pages/tools/tally/TallyLedgers';
// Bookkeeping Service — Workstation → Services → Bookkeeping. Manages the
// service workflow; all accounting stays in Books.
import { BookkeepingShell } from '@/pages/workstation/bookkeeping/BookkeepingShell';
import { BookkeepingOverviewPage } from '@/pages/workstation/bookkeeping/Overview';
import { BookkeepingClientsPage, BookkeepingClientDetailPage } from '@/pages/workstation/bookkeeping/Clients';
import { BookkeepingMonthlyWorkPage, BookkeepingPeriodDetailPage } from '@/pages/workstation/bookkeeping/MonthlyWork';
import {
  BookkeepingTasksPage, BookkeepingPendingItemsPage, BookkeepingDocumentsPage,
  BookkeepingDeliverablesPage, BookkeepingRemindersPage, BookkeepingSettingsPage,
} from '@/pages/workstation/bookkeeping/Lists';
// Incorporation Service — Workstation → Services → Incorporation. Case
// management for company/LLP/firm formation; contacts no external portal.
import { IncorporationShell } from '@/pages/workstation/incorporation/IncorporationShell';
import { IncorporationOverviewPage } from '@/pages/workstation/incorporation/Overview';
import { IncorporationCasesPage } from '@/pages/workstation/incorporation/Cases';
import { IncorporationCreateCasePage } from '@/pages/workstation/incorporation/CreateCase';
import { IncorporationCaseDetailPage } from '@/pages/workstation/incorporation/CaseDetail';
import {
  IncorporationTasksPage, IncorporationPendingItemsPage,
  IncorporationDeliverablesPage, IncorporationSettingsPage,
} from '@/pages/workstation/incorporation/Lists';

// GST — dedicated landing page + per-service AssistedHandoff detail +
// shape-based workspace dispatcher (recurring period board / project case
// pipeline) + weekly notice-check discovery workflow.
// See docs/gst-services/README.md.
// Registration — Workstation → Services → Registration. Nav structure and
// reference only; nothing files a registration yet.
import { RegistrationServicesLanding } from '@/pages/workstation/registration/RegistrationServicesLanding';
import { RegistrationServiceDetail } from '@/pages/workstation/registration/RegistrationServiceDetail';
import { GstServicesLanding } from '@/pages/workstation/gst/GstServicesLanding';
import { GstServiceHandoff } from '@/pages/workstation/gst/GstServiceHandoff';
// E-Invoice & E-Way Bill monitoring page (E-INVOICE-EWAYBILL.md). Both
// sidebar entries route here, but `mode` splits them: each screen shows only
// its own monitors, setup row and reconciliation column.
import EInvoiceEwbPage from '@/pages/workstation/einvoice-ewb/EInvoiceEwbPage';
import { GstWorkspace } from '@/pages/workstation/gst/GstWorkspace';
import { GstNoticeCheck } from '@/pages/workstation/gst/NoticeCheck';

// TDS — copied from the GST page structure per TDS-PAGE-PROMPT.md.
// Client + FY + TAN scope in the URL; six sub-services (Registration,
// Challan Payment, Return Filing, Correction, Form 16/16A, Notices).
import { TdsServicesLanding } from '@/pages/workstation/tds/TdsServicesLanding';
import { TdsServiceHandoff } from '@/pages/workstation/tds/TdsServiceHandoff';

// Books — native bookkeeping, one set of books per client.
import { BooksListPage } from '@/pages/books/BooksList';
import { BooksShell } from '@/pages/books/BooksShell';
import { BooksOverviewPage } from '@/pages/books/BooksOverview';
import { BooksDocumentsPage } from '@/pages/books/BooksDocuments';
import { BooksContactsPage } from '@/pages/books/BooksContacts';
import { BooksJournalsPage } from '@/pages/books/BooksJournals';
import { BooksBankingPage } from '@/pages/books/BooksBanking';
import { BooksReportsPage } from '@/pages/books/BooksReports';
import { BooksSettingsPage } from '@/pages/books/BooksSettings';
import { AttendancePage } from '@/pages/hrms/Attendance';
import { LeavePage } from '@/pages/hrms/Leave';
import { EmployeesPage } from '@/pages/hrms/Employees';
import { EmployeeDetailPage } from '@/pages/hrms/EmployeeDetail';
import { DocumentsPage } from '@/pages/hrms/Documents';
import { SettingsPage } from '@/pages/hrms/Settings';
import { PayrollPage, PayrollRunDetailPage } from '@/pages/hrms/Payroll';
import { PayslipDetailPage } from '@/pages/hrms/PayslipDetail';
import { MyPayslipsPage } from '@/pages/MyPayslips';
import { ExpensesPage } from '@/pages/hrms/Expenses';
import { AccountsPage } from '@/pages/hrms/Accounts';
import { MessagesPage } from '@/pages/hrms/Messages';
import { ReportsPage } from '@/pages/hrms/Reports';
import { useAuth } from '@/platform/auth/AuthContext';
import { NotFoundPage } from '@/pages/NotFound';
import { NotificationsPage } from '@/pages/Notifications';
import { ToastProvider } from '@/components/Toast';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function MyProfileRoute() {
  const { session } = useAuth();
  if (!session?.employee) return <NotFoundPage />;
  return <EmployeeDetailPage fixedId={session.employee.id} />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
            <Route path="/login" element={<LoginPage />} />

            <Route
              element={
                <ProtectedRoute>
                  <AppShell />
                </ProtectedRoute>
              }
            >
              <Route index element={<DashboardPage />} />
              <Route path="hrms" element={<Navigate to="/hrms/employees" replace />} />
              <Route path="hrms/employees" element={<EmployeesPage />} />
              <Route path="hrms/employees/:id" element={<EmployeeDetailPage />} />
              <Route path="hrms/attendance" element={<AttendancePage />} />
              <Route path="hrms/leave" element={<LeavePage />} />
              <Route path="hrms/payroll" element={<PayrollPage />} />
              <Route path="hrms/payroll/runs/:id" element={<PayrollRunDetailPage />} />
              <Route path="hrms/payroll/payslips/:id" element={<PayslipDetailPage />} />
              <Route path="hrms/expenses" element={<ExpensesPage />} />
              <Route path="hrms/accounts" element={<AccountsPage />} />
              <Route path="hrms/messages" element={<MessagesPage />} />
              <Route path="hrms/documents" element={<DocumentsPage />} />
              <Route path="hrms/reports" element={<ReportsPage />} />
              <Route path="hrms/settings" element={<SettingsPage />} />

              <Route path="me/profile" element={<MyProfileRoute />} />
              <Route path="me/attendance" element={<AttendancePage />} />
              <Route path="me/leave" element={<LeavePage />} />
              <Route path="me/expenses" element={<ExpensesPage />} />
              <Route path="me/payslips" element={<MyPayslipsPage />} />
              <Route path="me/payslips/:id" element={<PayslipDetailPage />} />

              <Route path="notifications" element={<NotificationsPage />} />

              {/* Workstation — the operational workspace. The Client
                  Workspace's tabs are nested route segments so each tab is
                  deep-linkable and the breadcrumb reads correctly. */}
              <Route path="workstation" element={<WorkstationDashboardPage />} />
              <Route path="workstation/leads" element={<LeadsPage />} />
              <Route path="workstation/leads/:id" element={<LeadDetailPage />} />
              <Route path="workstation/clients" element={<ClientsPage />} />
              <Route path="workstation/clients/:id" element={<ClientWorkspacePage />} />
              <Route path="workstation/clients/:id/:tab" element={<ClientWorkspacePage />} />
              <Route path="workstation/services" element={<ServicesPage />} />
              {/* Bookkeeping Service — a real module, so it is declared
                  BEFORE the :category catch-all below that renders every
                  other service slug as the placeholder Services page. */}
              <Route path="workstation/services/bookkeeping" element={<BookkeepingShell />}>
                <Route index element={<BookkeepingOverviewPage />} />
                <Route path="clients" element={<BookkeepingClientsPage />} />
                <Route path="clients/:clientId" element={<BookkeepingClientDetailPage />} />
                <Route path="monthly-work" element={<BookkeepingMonthlyWorkPage />} />
                <Route path="monthly-work/:periodId" element={<BookkeepingPeriodDetailPage />} />
                <Route path="tasks" element={<BookkeepingTasksPage />} />
                <Route path="pending-items" element={<BookkeepingPendingItemsPage />} />
                <Route path="documents" element={<BookkeepingDocumentsPage />} />
                <Route path="deliverables" element={<BookkeepingDeliverablesPage />} />
                <Route path="reminders" element={<BookkeepingRemindersPage />} />
                <Route path="settings" element={<BookkeepingSettingsPage />} />
              </Route>
              {/* Incorporation Service — a real module, so it too is
                  declared BEFORE the :category catch-all below. */}
              <Route path="workstation/services/incorporation" element={<IncorporationShell />}>
                <Route index element={<IncorporationOverviewPage />} />
                <Route path="cases" element={<IncorporationCasesPage />} />
                <Route path="cases/new" element={<IncorporationCreateCasePage />} />
                <Route path="cases/:caseId" element={<IncorporationCaseDetailPage />} />
                <Route path="tasks" element={<IncorporationTasksPage />} />
                <Route path="pending-items" element={<IncorporationPendingItemsPage />} />
                <Route path="deliverables" element={<IncorporationDeliverablesPage />} />
                <Route path="settings" element={<IncorporationSettingsPage />} />
              </Route>
              {/* TDS module — copied from GST structure, wins over the
                  :category catch-all below. */}
              <Route path="workstation/services/tds" element={<TdsServicesLanding />} />
              <Route path="workstation/services/tds/:slug" element={<TdsServiceHandoff />} />
              {/* GST module landing + per-service AssistedHandoff detail —
                  see docs/gst-services/README.md. Declared BEFORE the
                  :category catch-all so they win. */}
              <Route path="workstation/services/gst" element={<GstServicesLanding />} />
              {/* Weekly notice-check comes BEFORE the /:slug catch to avoid
                  being treated as a service slug. */}
              <Route path="workstation/services/gst/notice-check" element={<GstNoticeCheck />} />
              <Route path="workstation/services/gst/:slug" element={<GstServiceHandoff />} />
              <Route path="workstation/services/gst/:slug/workspace" element={<GstWorkspace />} />
              {/* E-Invoice & E-Way Bill — one page for both sidebar entries.
                  Declared BEFORE the :category catch-all so both slugs resolve
                  here instead of the generic Services page. */}
              <Route path="workstation/services/e-invoice" element={<EInvoiceEwbPage mode="einvoice" />} />
              <Route path="workstation/services/e-way-bill" element={<EInvoiceEwbPage mode="ewb" />} />
              {/* Service categories (TDS) — nav structure only for now, so
                  every remaining slug resolves to the same Services page. */}
              {/* Registration category — declared BEFORE the :category
                  catch-all below, or that would swallow the slug. */}
              <Route path="workstation/services/registration" element={<RegistrationServicesLanding />} />
              <Route path="workstation/services/registration/:slug" element={<RegistrationServiceDetail />} />
              <Route path="workstation/services/:category" element={<ServicesPage />} />
              <Route path="workstation/follow-ups" element={<FollowUpsPage />} />
              <Route path="workstation/documents" element={<WorkstationDocumentsPage />} />
              <Route path="tools" element={<ToolsPage />} />
              <Route path="tools/documents" element={<ToolDocumentsPage />} />
              <Route path="tools/:toolId" element={<ToolWorkspacePage />} />

              {/* Audit Automation — top-level module, sibling of Tools. */}
              <Route path="audit-automation" element={<AuditAutomationLandingPage />} />
              <Route path="audit-automation/bank" element={<BankJobsListPage />} />
              <Route path="audit-automation/bank/new" element={<BankNewUploadPage />} />
              <Route path="audit-automation/bank/jobs/:jobId" element={<BankJobDetailPage />} />
              <Route path="audit-automation/gst" element={<GstJobsListPage />} />
              <Route path="audit-automation/gst/new" element={<GstNewReconPage />} />
              <Route path="audit-automation/gst/jobs/:jobId" element={<GstReconDetailPage />} />
              <Route path="audit-automation/tds" element={<TdsJobsListPage />} />
              <Route path="audit-automation/tds/new" element={<TdsNewReconPage />} />
              <Route path="audit-automation/tds/jobs/:jobId" element={<TdsReconDetailPage />} />

              {/* Tally — native double-entry accounting. Sits alongside
                  Tools, Repotic and Books in the TOOLS sidebar section. */}
              <Route path="tally" element={<TallyHome />} />
              <Route path="tally/companies" element={<TallyCompanies />} />
              <Route path="tally/companies/:companyId" element={<TallyWorkspace />}>
                <Route path="masters/groups" element={<TallyGroups />} />
                <Route path="masters/ledgers" element={<TallyLedgers />} />
              </Route>

              {/* Books — the client list, then one shell per set of books
                  whose tabs are nested routes so each is deep-linkable. */}
              <Route path="books" element={<BooksListPage />} />
              <Route path="books/:orgId" element={<BooksShell />}>
                <Route index element={<BooksOverviewPage />} />
                <Route path="sales" element={<BooksDocumentsPage side="sales" />} />
                <Route path="purchases" element={<BooksDocumentsPage side="purchases" />} />
                <Route path="contacts" element={<BooksContactsPage />} />
                <Route path="banking" element={<BooksBankingPage />} />
                <Route path="journals" element={<BooksJournalsPage />} />
                <Route path="reports" element={<BooksReportsPage />} />
                <Route path="settings" element={<BooksSettingsPage />} />
              </Route>

              <Route path="*" element={<NotFoundPage />} />
            </Route>
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
