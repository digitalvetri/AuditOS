import { lazy, Suspense, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes, Navigate, useLocation, useParams } from 'react-router-dom';
import { AuthProvider } from '@/platform/auth/AuthContext';
import { ProtectedRoute } from '@/platform/auth/ProtectedRoute';
// New shell + dashboard per UI-BUILD-PROMPT.md. The v1 shell/dashboard still
// live at @/shell/AppShell and @/pages/Dashboard — kept for now so the diff
// is a swap, not a delete, and old modules render inside the new frame.
import { AppShellV2 as AppShell } from '@/shell/v2/AppShell';
import { LoginPage } from '@/pages/Login';
const SetPasswordPage = lazy(() => import('@/pages/SetPassword').then((m) => ({ default: m.SetPasswordPage })));
import { DashboardV2Page as DashboardPage } from '@/pages/DashboardV2';
// Workstation (AUDIT_OS_WORKSTATION.md §4) — replaces the reserved screen.
const WorkstationDashboardPage = lazy(() => import('@/pages/workstation/Dashboard').then((m) => ({ default: m.WorkstationDashboardPage })));
const LeadsPage = lazy(() => import('@/pages/workstation/Leads').then((m) => ({ default: m.LeadsPage })));
const LeadDetailPage = lazy(() => import('@/pages/workstation/LeadDetail').then((m) => ({ default: m.LeadDetailPage })));
const ClientsPage = lazy(() => import('@/pages/workstation/Clients').then((m) => ({ default: m.ClientsPage })));
const ClientWorkspacePage = lazy(() => import('@/pages/workstation/ClientWorkspace').then((m) => ({ default: m.ClientWorkspacePage })));
const ServicesPage = lazy(() => import('@/pages/workstation/Services').then((m) => ({ default: m.ServicesPage })));
const FollowUpsPage = lazy(() => import('@/pages/workstation/FollowUps').then((m) => ({ default: m.FollowUpsPage })));
const WorkstationCalendarPage = lazy(() => import('@/pages/workstation/Calendar').then((m) => ({ default: m.WorkstationCalendarPage })));
const WorkstationDocumentsPage = lazy(() => import('@/pages/workstation/Documents').then((m) => ({ default: m.DocumentsPage })));
const TaskListPage = lazy(() => import('@/pages/workstation/tasks/TaskList').then((m) => ({ default: m.TaskListPage })));
const TaskDetailPage = lazy(() => import('@/pages/workstation/tasks/TaskDetail').then((m) => ({ default: m.TaskDetailPage })));
const TaskReportsPage = lazy(() => import('@/pages/workstation/tasks/TaskReports').then((m) => ({ default: m.TaskReportsPage })));
const QuotationListPage = lazy(() => import('@/pages/workstation/quotations/QuotationList').then((m) => ({ default: m.QuotationListPage })));
const InvoiceListPage = lazy(() => import('@/pages/workstation/invoices/InvoiceList').then((m) => ({ default: m.InvoiceListPage })));
const InvoiceBuilderPage = lazy(() => import('@/pages/workstation/invoices/InvoiceBuilder').then((m) => ({ default: m.InvoiceBuilderPage })));
const InvoiceDetailPage = lazy(() => import('@/pages/workstation/invoices/InvoiceDetail').then((m) => ({ default: m.InvoiceDetailPage })));
const InvoicePreviewPage = lazy(() => import('@/pages/workstation/invoices/InvoicePreview').then((m) => ({ default: m.InvoicePreviewPage })));
const CreditNoteListPage = lazy(() => import('@/pages/workstation/creditNotes/CreditNoteList').then((m) => ({ default: m.CreditNoteListPage })));
const CreditNoteEditorPage = lazy(() => import('@/pages/workstation/creditNotes/CreditNoteEditor').then((m) => ({ default: m.CreditNoteEditorPage })));
const RecurringInvoicesPage = lazy(() => import('@/pages/workstation/recurring/RecurringInvoices').then((m) => ({ default: m.RecurringInvoicesPage })));
const QuotationBuilderPage = lazy(() => import('@/pages/workstation/quotations/QuotationBuilder').then((m) => ({ default: m.QuotationBuilderPage })));
const QuotationDetailPage = lazy(() => import('@/pages/workstation/quotations/QuotationDetail').then((m) => ({ default: m.QuotationDetailPage })));
const QuotationPreviewPage = lazy(() => import('@/pages/workstation/quotations/QuotationPreview').then((m) => ({ default: m.QuotationPreviewPage })));
const EngagementListPage = lazy(() => import('@/pages/workstation/engagement/EngagementList').then((m) => ({ default: m.EngagementListPage })));
const EngagementBuilderPage = lazy(() => import('@/pages/workstation/engagement/EngagementBuilder').then((m) => ({ default: m.EngagementBuilderPage })));
const EngagementPreviewPage = lazy(() => import('@/pages/workstation/engagement/EngagementPreview').then((m) => ({ default: m.EngagementPreviewPage })));
const DocHomePage = lazy(() => import('@/pages/workstation/doc/DocHome').then((m) => ({ default: m.DocHomePage })));
const DocListPage = lazy(() => import('@/pages/workstation/doc/DocList').then((m) => ({ default: m.DocListPage })));
const DocBuilderPage = lazy(() => import('@/pages/workstation/doc/DocBuilder').then((m) => ({ default: m.DocBuilderPage })));
const DocPreviewPage = lazy(() => import('@/pages/workstation/doc/DocPreview').then((m) => ({ default: m.DocPreviewPage })));
const ClientDocumentsPortalPage = lazy(() => import('@/pages/portal/ClientDocumentsPortal').then((m) => ({ default: m.ClientDocumentsPortalPage })));
// Tools (Converters & Utilities) — registry-driven; /tools/:toolId is one
// shared workspace and /tools/documents the output history.
const ToolsPage = lazy(() => import('@/pages/tools/Tools').then((m) => ({ default: m.ToolsPage })));
const ToolWorkspacePage = lazy(() => import('@/pages/tools/ToolWorkspace').then((m) => ({ default: m.ToolWorkspacePage })));
const ToolDocumentsPage = lazy(() => import('@/pages/tools/ToolDocuments').then((m) => ({ default: m.ToolDocumentsPage })));
// Audit Automation submodule (AMENDMENT-02-REPOTIC-GAPS.md).
const AuditAutomationLandingPage = lazy(() => import('@/pages/tools/AuditAutomation').then((m) => ({ default: m.AuditAutomationLandingPage })));
const BankJobsListPage = lazy(() => import('@/pages/tools/BankJobsList').then((m) => ({ default: m.BankJobsListPage })));
const BankNewUploadPage = lazy(() => import('@/pages/tools/BankNewUpload').then((m) => ({ default: m.BankNewUploadPage })));
const BankJobDetailPage = lazy(() => import('@/pages/tools/BankJobDetail').then((m) => ({ default: m.BankJobDetailPage })));
// GST reconciliation pipeline.
const GstJobsListPage = lazy(() => import('@/pages/tools/GstJobsList').then((m) => ({ default: m.GstJobsListPage })));
const GstNewReconPage = lazy(() => import('@/pages/tools/GstNewRecon').then((m) => ({ default: m.GstNewReconPage })));
const GstReconDetailPage = lazy(() => import('@/pages/tools/GstReconDetail').then((m) => ({ default: m.GstReconDetailPage })));
// Repotic · Ecommerce GSTR-1 pipeline (REPOTIC-MODULE.md Phase 1+).
const EcommerceGstr1HomePage = lazy(() => import('@/pages/tools/repotic/EcommerceGstr1Home').then((m) => ({ default: m.EcommerceGstr1HomePage })));
// Bookkeeping — native double-entry accounting (formerly Tally engine).
const BookkeepingHome = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingHome').then((m) => ({ default: m.BookkeepingHome })));
const BookkeepingCompanies = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingCompanies').then((m) => ({ default: m.BookkeepingCompanies })));
const BookkeepingWorkspace = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingWorkspace').then((m) => ({ default: m.BookkeepingWorkspace })));
const BookkeepingGroups = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingGroups').then((m) => ({ default: m.BookkeepingGroups })));
const BookkeepingLedgers = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingLedgers').then((m) => ({ default: m.BookkeepingLedgers })));
const BookkeepingDashboard = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingDashboard').then((m) => ({ default: m.BookkeepingDashboard })));
const BookkeepingVouchers = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingVouchers').then((m) => ({ default: m.BookkeepingVouchers })));
const BookkeepingVoucherEditor = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingVoucherEditor').then((m) => ({ default: m.BookkeepingVoucherEditor })));
const BookkeepingVoucherDetail = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingVoucherDetail').then((m) => ({ default: m.BookkeepingVoucherDetail })));
const BookkeepingReports = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingReports').then((m) => ({ default: m.BookkeepingReports })));
const BookkeepingReportPage = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingReportPage').then((m) => ({ default: m.BookkeepingReportPage })));
const BookkeepingRegisterPage = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingReportPage').then((m) => ({ default: m.BookkeepingRegisterPage })));
const BookkeepingBookPage = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingReportPage').then((m) => ({ default: m.BookkeepingBookPage })));
const BookkeepingLedgerStatement = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingReportPage').then((m) => ({ default: m.BookkeepingLedgerStatement })));
const BookkeepingInventory = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingInventory').then((m) => ({ default: m.BookkeepingInventory })));
const BookkeepingStockItemPage = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingInventory').then((m) => ({ default: m.BookkeepingStockItemPage })));
const BookkeepingBanking = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingBanking').then((m) => ({ default: m.BookkeepingBanking })));
const BookkeepingImportPage = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingImport').then((m) => ({ default: m.BookkeepingImportPage })));
const BookkeepingClientDashboardPage = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingClientDashboard').then((m) => ({ default: m.BookkeepingClientDashboardPage })));
const TallyExportPage = lazy(() => import('@/pages/workstation/services/tally-export/TallyExportPage').then((m) => ({ default: m.TallyExportPage })));
const BookkeepingGst = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingGst').then((m) => ({ default: m.BookkeepingGst })));
const BookkeepingTrade = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingTrade').then((m) => ({ default: m.BookkeepingTrade })));
const BookkeepingPayroll = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingPayroll').then((m) => ({ default: m.BookkeepingPayroll })));
const BookkeepingAudit = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingAudit').then((m) => ({ default: m.BookkeepingAudit })));
const BookkeepingUtilities = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingUtilities').then((m) => ({ default: m.BookkeepingUtilities })));
const BookkeepingSettings = lazy(() => import('@/pages/workstation/services/bookkeeping/BookkeepingSettings').then((m) => ({ default: m.BookkeepingSettings })));
// GST — dedicated landing page + per-service AssistedHandoff detail +
// shape-based workspace dispatcher (recurring period board / project case
// pipeline) + weekly notice-check discovery workflow.
// See docs/gst-services/README.md.
// GST compliance lives inside the GST Registration entry — see GstShell.
const PartnershipShell = lazy(() => import('@/pages/workstation/registration/partnership/PartnershipShell').then((m) => ({ default: m.PartnershipShell })));
const PartnershipDashboard = lazy(() => import('@/pages/workstation/registration/partnership/PartnershipDashboard').then((m) => ({ default: m.PartnershipDashboard })));
const PartnershipClients = lazy(() => import('@/pages/workstation/registration/partnership/PartnershipClients').then((m) => ({ default: m.PartnershipClients })));
const PartnershipCase = lazy(() => import('@/pages/workstation/registration/partnership/PartnershipCase').then((m) => ({ default: m.PartnershipCase })));
const ServiceProvider = lazy(() => import('@/pages/workstation/registration/partnership/shared').then((m) => ({ default: m.ServiceProvider })));
const PartnershipTemplate = lazy(() => import('@/pages/workstation/registration/partnership/PartnershipTemplate').then((m) => ({ default: m.PartnershipTemplate })));
const PostRegistrationOverview = lazy(() => import('@/modules/postRegistration/Overview').then((m) => ({ default: m.PostRegistrationOverview })));
const LlpCompliancePage = lazy(() => import('@/modules/postRegistration/RegistrationComplianceSection').then((m) => ({ default: m.LlpCompliancePage })));
const GstShell = lazy(() => import('@/pages/workstation/registration/gst/GstShell').then((m) => ({ default: m.GstShell })));
const GstRegistrationTab = lazy(() => import('@/pages/workstation/registration/gst/GstRegistrationTab').then((m) => ({ default: m.GstRegistrationTab })));
const GstDashboard = lazy(() => import('@/pages/workstation/registration/gst/GstDashboard').then((m) => ({ default: m.GstDashboard })));
const GstClients = lazy(() => import('@/pages/workstation/registration/gst/GstClients').then((m) => ({ default: m.GstClients })));
const GstClientView = lazy(() => import('@/pages/workstation/registration/gst/GstClientView').then((m) => ({ default: m.GstClientView })));
// GstStagePage + GstPeriodDetail deleted in §9-4 — the return tabs
// render PartnershipClients, and the dashboard's 1 › 2B › Recon › 3B
// chain nodes open the shared PartnershipCase directly.
const GstTemplateHub = lazy(() => import('@/pages/workstation/registration/gst/GstTemplateHub').then((m) => ({ default: m.GstTemplateHub })));
const RegistrationServiceDetail = lazy(() => import('@/pages/workstation/registration/RegistrationServiceDetail').then((m) => ({ default: m.RegistrationServiceDetail })));

// TDS — copied from the GST page structure per TDS-PAGE-PROMPT.md.
// Client + FY + TAN scope in the URL; six sub-services (Registration,
// Challan Payment, Return Filing, Correction, Form 16/16A, Notices).
const TdsServicesLanding = lazy(() => import('@/pages/workstation/tds/TdsServicesLanding').then((m) => ({ default: m.TdsServicesLanding })));
const TdsServiceHandoff = lazy(() => import('@/pages/workstation/tds/TdsServiceHandoff').then((m) => ({ default: m.TdsServiceHandoff })));
const TdsRegisterPage = lazy(() => import('@/pages/workstation/tds/TdsRegisterPage').then((m) => ({ default: m.TdsRegisterPage })));
// Compliance calendar, notices, DSC register, 26AS recon (docs/compliance) — code-split.
import { ComplianceCalendarRoute, DueDateExtensionsRoute, NoticesRegisterRoute, DscRegisterRoute, TdsReconRoute } from '@/modules/compliance/lazyPages';

// Books — Tools → Books, an Audit OS UI over Zoho Books (docs/books-zoho).
const BooksShell = lazy(() => import('@/pages/books/BooksShell').then((m) => ({ default: m.BooksShell })));
const BooksDashboardPage = lazy(() => import('@/pages/books/BooksDashboard').then((m) => ({ default: m.BooksDashboardPage })));
const BooksSettingsPage = lazy(() => import('@/pages/books/BooksSettings').then((m) => ({ default: m.BooksSettingsPage })));
const BankingPage = lazy(() => import('@/pages/books/BooksPages').then((m) => ({ default: m.BankingPage })));
const BulkUpdatePage = lazy(() => import('@/pages/books/BooksPages').then((m) => ({ default: m.BulkUpdatePage })));
const ContactDetailPage = lazy(() => import('@/pages/books/BooksPages').then((m) => ({ default: m.ContactDetailPage })));
const PaymentsPage = lazy(() => import('@/pages/books/BooksPages').then((m) => ({ default: m.PaymentsPage })));
const ReconciliationPage = lazy(() => import('@/pages/books/BooksPages').then((m) => ({ default: m.ReconciliationPage })));
const BooksReportsPage = lazy(() => import('@/pages/books/BooksPages').then((m) => ({ default: m.ReportsPage })));
const ResourcePage = lazy(() => import('@/pages/books/BooksPages').then((m) => ({ default: m.ResourcePage })));
const TaxesPage = lazy(() => import('@/pages/books/BooksPages').then((m) => ({ default: m.TaxesPage })));
const TransactionLockingPage = lazy(() => import('@/pages/books/BooksPages').then((m) => ({ default: m.TransactionLockingPage })));
const ZohoOnlyPage = lazy(() => import('@/pages/books/BooksPages').then((m) => ({ default: m.ZohoOnlyPage })));
const AttendancePage = lazy(() => import('@/pages/hrms/Attendance').then((m) => ({ default: m.AttendancePage })));
const LeavePage = lazy(() => import('@/pages/hrms/Leave').then((m) => ({ default: m.LeavePage })));
const EmployeesPage = lazy(() => import('@/pages/hrms/Employees').then((m) => ({ default: m.EmployeesPage })));
const EmployeeDetailPage = lazy(() => import('@/pages/hrms/EmployeeDetail').then((m) => ({ default: m.EmployeeDetailPage })));
const DocumentsPage = lazy(() => import('@/pages/hrms/Documents').then((m) => ({ default: m.DocumentsPage })));
const SettingsPage = lazy(() => import('@/pages/hrms/Settings').then((m) => ({ default: m.SettingsPage })));
const AuditLogPage = lazy(() => import('@/pages/hrms/AuditLog').then((m) => ({ default: m.AuditLogPage })));
const ZohoPaymentsIntegrationPage = lazy(() => import('@/pages/integrations/ZohoPayments').then((m) => ({ default: m.ZohoPaymentsIntegrationPage })));
const AiProviderIntegrationPage = lazy(() => import('@/pages/integrations/AiProvider').then((m) => ({ default: m.AiProviderIntegrationPage })));
const PayrollPage = lazy(() => import('@/pages/hrms/Payroll').then((m) => ({ default: m.PayrollPage })));
const PayrollRunDetailPage = lazy(() => import('@/pages/hrms/Payroll').then((m) => ({ default: m.PayrollRunDetailPage })));
const PayslipDetailPage = lazy(() => import('@/pages/hrms/PayslipDetail').then((m) => ({ default: m.PayslipDetailPage })));
const MyPayslipsPage = lazy(() => import('@/pages/MyPayslips').then((m) => ({ default: m.MyPayslipsPage })));
const ExpensesPage = lazy(() => import('@/pages/hrms/Expenses').then((m) => ({ default: m.ExpensesPage })));
const AccountsLayout = lazy(() => import('@/pages/hrms/Accounts').then((m) => ({ default: m.AccountsLayout })));
const AccountsOverviewPage = lazy(() => import('@/pages/hrms/Accounts').then((m) => ({ default: m.AccountsOverviewPage })));
const AccountsLedgerPage = lazy(() => import('@/pages/hrms/Accounts').then((m) => ({ default: m.AccountsLedgerPage })));
const AccountsPaymentsPage = lazy(() => import('@/pages/hrms/Accounts').then((m) => ({ default: m.AccountsPaymentsPage })));
const AccountsCollectionsPage = lazy(() => import('@/pages/hrms/Accounts').then((m) => ({ default: m.AccountsCollectionsPage })));
const MessagesPage = lazy(() => import('@/pages/hrms/Messages').then((m) => ({ default: m.MessagesPage })));
const ReportsPage = lazy(() => import('@/pages/hrms/Reports').then((m) => ({ default: m.ReportsPage })));
const PaymentSummaryPage = lazy(() => import('@/pages/hrms/PaymentSummary').then((m) => ({ default: m.PaymentSummaryPage })));
import { useAuth } from '@/platform/auth/AuthContext';
import { NotFoundPage } from '@/pages/NotFound';
const ComingSoonPage = lazy(() => import('@/pages/ComingSoon').then((m) => ({ default: m.ComingSoonPage })));
import { ErrorBoundary } from '@/components/ErrorBoundary';
const NotificationsPage = lazy(() => import('@/pages/Notifications').then((m) => ({ default: m.NotificationsPage })));
import { ToastProvider } from '@/components/Toast';
import { PwaProvider } from '@/platform/pwa/PwaProvider';
import { QuerySkeleton } from '@/modules/workstation/components';

// Audit files (docs/audit-files/README.md) — loaded on first visit, so the
// module adds nothing to the initial bundle.
const AuditListPage = lazy(() => import('@/pages/workstation/audits/AuditList').then((m) => ({ default: m.AuditListPage })));
const AuditFilePage = lazy(() => import('@/pages/workstation/audits/AuditFile').then((m) => ({ default: m.AuditFilePage })));
const UdinRegisterPage = lazy(() => import('@/pages/workstation/audits/UdinRegister').then((m) => ({ default: m.UdinRegisterPage })));
const ArticleshipPage = lazy(() => import('@/pages/hrms/Articleship').then((m) => ({ default: m.ArticleshipPage })));
const Lazy = ({ children }: { children: ReactNode }) => <Suspense fallback={<QuerySkeleton />}>{children}</Suspense>;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Preserve query string (?tab=finance etc) AND :id path params when
 * redirecting a legacy route. Every historical notification, bookmark
 * and shared deep-link keeps its filter after the nav merge.
 */
function LegacyRedirect({ to }: { to: string }) {
  const params = useParams()
  const location = useLocation()
  let path = to
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) path = path.replace(`:${k}`, v)
  }
  return <Navigate to={{ pathname: path, search: location.search }} replace />
}

function MyProfileRoute() {
  const { session } = useAuth();
  if (!session?.employee) return <NotFoundPage />;
  return <EmployeeDetailPage fixedId={session.employee.id} />;
}

export default function App() {
  return (
    <ErrorBoundary fullPage>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <PwaProvider>
        <AuthProvider>
          <BrowserRouter>
            {/* Pages are code-split; the shell has its own boundary around <Outlet/>. */}
            <Suspense fallback={<QuerySkeleton />}>
            <Routes>
            <Route path="/login" element={<LoginPage />} />
            {/* Public: a client's live document link. No login — the token in
                the URL is the authorization, and the firm can turn it off. */}
            <Route path="/portal/documents/:token" element={<ClientDocumentsPortalPage />} />
            <Route path="/set-password" element={<SetPasswordPage />} />

            {/* The quotation preview is a document, not a screen: it is
                declared OUTSIDE the AppShell route below so the sidebar,
                top bar and mobile bottom nav are never rendered around it.
                Still behind ProtectedRoute — only the chrome is dropped. */}
            <Route
              path="/workstation/doc/:id/preview"
              element={
                <ProtectedRoute>
                  <DocPreviewPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/workstation/engagement/:id/preview"
              element={
                <ProtectedRoute>
                  <EngagementPreviewPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/workstation/quotations/:id/preview"
              element={
                <ProtectedRoute>
                  <QuotationPreviewPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/workstation/invoices/:id/preview"
              element={
                <ProtectedRoute>
                  <InvoicePreviewPage />
                </ProtectedRoute>
              }
            />

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
              <Route path="hrms/articleship" element={<Lazy><ArticleshipPage /></Lazy>} />
              {/* Nested Accounts routes — Payroll and Expenses live inside
                  the single Accounts module now (§6.2). Legacy /hrms/payroll
                  and /hrms/expenses redirect below rather than 404. */}
              <Route path="hrms/accounts" element={<AccountsLayout />}>
                <Route index element={<Navigate to="/hrms/accounts/overview" replace />} />
                <Route path="overview" element={<AccountsOverviewPage />} />
                <Route path="payroll" element={<PayrollPage />} />
                <Route path="payroll/runs/:id" element={<PayrollRunDetailPage />} />
                <Route path="payroll/payslips/:id" element={<PayslipDetailPage />} />
                <Route path="expenses" element={<ExpensesPage />} />
                <Route path="payments" element={<AccountsPaymentsPage />} />
                <Route path="collections" element={<AccountsCollectionsPage />} />
                <Route path="collections/matching" element={<AccountsCollectionsPage />} />
                <Route path="ledger" element={<AccountsLedgerPage />} />
              </Route>

              {/* Redirects — every route that existed pre-consolidation
                  MUST forward, not 404 (§0 acceptance criterion). Search
                  string is preserved so ?tab=finance et al survive. */}
              <Route path="hrms/payroll" element={<LegacyRedirect to="/hrms/accounts/payroll" />} />
              <Route path="hrms/payroll/runs/:id" element={<LegacyRedirect to="/hrms/accounts/payroll/runs/:id" />} />
              <Route path="hrms/payroll/payslips/:id" element={<LegacyRedirect to="/hrms/accounts/payroll/payslips/:id" />} />
              <Route path="hrms/expenses" element={<LegacyRedirect to="/hrms/accounts/expenses" />} />
              <Route path="hrms/messages" element={<MessagesPage />} />
              <Route path="hrms/documents" element={<DocumentsPage />} />
              <Route path="hrms/payment-summary" element={<PaymentSummaryPage />} />
              <Route path="hrms/reports" element={<ReportsPage />} />
              <Route path="hrms/settings" element={<SettingsPage />} />
              <Route path="hrms/audit-log" element={<AuditLogPage />} />
              <Route path="integrations/zoho-payments" element={<ZohoPaymentsIntegrationPage />} />
              <Route path="integrations/ai-provider" element={<AiProviderIntegrationPage />} />

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
              {/* TDS module — copied from GST structure, wins over the
                  :category catch-all below. */}
              <Route path="workstation/services/tds" element={<TdsServicesLanding />} />
              {/* Declared before :slug so "register" is not read as a sub-service. */}
              <Route path="workstation/services/tds/register" element={<TdsRegisterPage />} />
              <Route path="workstation/services/tds/:slug" element={<TdsServiceHandoff />} />
              {/* Tally Export — its own Services module (docs/tally-export/README.md). */}
              <Route path="workstation/services/tally-export" element={<TallyExportPage />} />
              {/* Services → E-Invoice and Services → E-Way Bill are not built
                  yet. Their addresses are pinned to a Coming soon page so the
                  :category catch-all below cannot serve them as a generic Services page.
                  Registration → E-Invoice / E-Way Bill live under
                  workstation/services/registration/… and are unaffected. */}
              <Route path="workstation/services/e-invoice" element={<ComingSoonPage title="E-Invoice" body="Generating IRNs and e-invoices from here is coming soon." />} />
              <Route path="workstation/services/e-way-bill" element={<ComingSoonPage title="E-Way Bill" body="Generating e-way bills from here is coming soon." />} />
              {/* Service categories (TDS) — nav structure only for now, so
                  every remaining slug resolves to the same Services page. */}
              {/* Registration category — declared BEFORE the :category
                  catch-all below, or that would swallow the slug. */}
              {/* Registration has no page of its own — it is a sidebar group.
                  Old links to it land on the first registration. */}
              <Route path="workstation/services/registration" element={<Navigate to="/workstation/services/registration/gst" replace />} />
              {/* GST Registration is a real module, so it is declared BEFORE
                  the :slug catch-all below — which would otherwise swallow
                  /registration/gst/dashboard and render "not found". */}
              <Route path="workstation/services/registration/gst" element={<GstShell />}>
                {/* Landing on the module goes to today's work, not the
                    one-time registration reference. */}
                <Route index element={<Navigate to="dashboard" replace />} />
                <Route path="dashboard" element={<GstDashboard />} />
                <Route path="registration" element={<GstRegistrationTab />} />
                {/* /registration/clients aliases /registration so
                    PartnershipCase's "Back to GST Registration Clients"
                    link lands on the case list (which lives inside the
                    Registration tab). */}
                <Route path="registration/clients" element={<GstRegistrationTab />} />
                {/* Registration case screen — the shared PartnershipCase,
                    resolved through the GST ServiceProvider on GstShell.
                    Path mirrors Partnership/LLP (base + '/clients/:caseId')
                    so PartnershipClients.navigate hits the right route. */}
                <Route path="registration/clients/:caseId" element={<PartnershipCase />} />
                <Route path="clients" element={<GstClients />} />
                {/* Row-click landing from the client dashboard —
                    GST-CLIENT-DASHBOARD-TASKS §2. */}
                <Route path="clients/:clientId" element={<GstClientView />} />
                {/* Return-cycle client lists — unified with the dashboard so
                    a row click lands on the same client view regardless of
                    entry point, and the roster is every GST client (not just
                    those with an existing case for the period). The three
                    tabs render the same table as /dashboard with a header
                    that names the return in focus. Case detail is still one
                    click away from the client view's "Open case" action.

                    `/clients` aliases exist because PartnershipCase's
                    "Back to X Clients" link resolves to `${base}/clients`
                    — for return kinds that URL had no route registered
                    and 404'd from case detail. Both `/gst/gstr1` and
                    `/gst/gstr1/clients` land on the same focused list. */}
                <Route path="gstr1" element={<GstDashboard focusKind="GSTR1" />} />
                <Route path="gstr1/clients" element={<GstDashboard focusKind="GSTR1" />} />
                <Route path="gstr2b" element={<GstDashboard focusKind="GSTR2B" />} />
                <Route path="gstr2b/clients" element={<GstDashboard focusKind="GSTR2B" />} />
                <Route path="gstr3b" element={<GstDashboard focusKind="GSTR3B" />} />
                <Route path="gstr3b/clients" element={<GstDashboard focusKind="GSTR3B" />} />
                {/* Return-cycle cases (§9-2). The shared PartnershipCase
                    renders inside a per-return ServiceProvider so useSvc()
                    resolves to the right template, api and detailsLabel.
                    GstShell wraps the whole route tree in kind=GST — the
                    innermost provider wins. */}
                <Route path="gstr1/cases/:caseId" element={<ServiceProvider kind="GSTR1"><PartnershipCase /></ServiceProvider>} />
                <Route path="gstr2b/cases/:caseId" element={<ServiceProvider kind="GSTR2B"><PartnershipCase /></ServiceProvider>} />
                <Route path="gstr3b/cases/:caseId" element={<ServiceProvider kind="GSTR3B"><PartnershipCase /></ServiceProvider>} />
                {/* Checklist Template editor — hub with a sub-nav to switch
                    between GST Registration and the three return templates
                    (§7.2, §7.3, §7.4). Each uses the shared PartnershipTemplate
                    re-rooted in a ServiceProvider for the chosen kind. */}
                <Route path="template" element={<GstTemplateHub />} />
              </Route>
              {/* Partnership Firm Registration — a real case module, so it is
                  declared BEFORE the :slug catch-all, the same way GST is. */}
              <Route path="workstation/services/registration/partnership-firm" element={<PartnershipShell />}>
                <Route index element={<Navigate to="dashboard" replace />} />
                <Route path="dashboard" element={<PartnershipDashboard />} />
                <Route path="clients" element={<PartnershipClients />} />
                <Route path="clients/:caseId" element={<PartnershipCase />} />
                <Route path="template" element={<PartnershipTemplate />} />
                <Route path="registration" element={<RegistrationServiceDetail slug="partnership-firm" embedded />} />
                <Route path="about" element={<Navigate to="../registration" replace />} />
              </Route>
              {/* LLP Registration — the same case engine and screens, its own checklist. */}
              <Route path="workstation/services/registration/llp" element={<PartnershipShell kind="LLP" />}>
                <Route index element={<Navigate to="dashboard" replace />} />
                <Route path="dashboard" element={<PartnershipDashboard />} />
                <Route path="clients" element={<PartnershipClients />} />
                <Route path="clients/:caseId" element={<PartnershipCase />} />
                <Route path="template" element={<PartnershipTemplate />} />
                <Route path="registration" element={<RegistrationServiceDetail slug="llp" embedded />} />
                <Route path="compliance" element={<LlpCompliancePage />} />
                <Route path="about" element={<Navigate to="../registration" replace />} />
              </Route>
              {/* Private Limited Incorporation — the same case engine, its own checklist.
                  Restored: the #58 merge dropped this block (0393fc8 added it). */}
              <Route path="workstation/services/registration/private-limited" element={<PartnershipShell kind="PRIVATE_LIMITED" />}>
                <Route index element={<Navigate to="dashboard" replace />} />
                <Route path="dashboard" element={<PartnershipDashboard />} />
                <Route path="clients" element={<PartnershipClients />} />
                <Route path="clients/:caseId" element={<PartnershipCase />} />
                <Route path="template" element={<PartnershipTemplate />} />
                <Route path="registration" element={<RegistrationServiceDetail slug="private-limited" embedded />} />
                <Route path="compliance" element={<PostRegistrationOverview />} />
                <Route path="about" element={<Navigate to="../registration" replace />} />
              </Route>
              <Route path="workstation/services/registration/:slug" element={<RegistrationServiceDetail />} />
              <Route path="workstation/services/:category" element={<ServicesPage />} />
              <Route path="workstation/follow-ups" element={<FollowUpsPage />} />
              <Route path="workstation/calendar" element={<WorkstationCalendarPage />} />
              <Route path="workstation/compliance" element={<ComplianceCalendarRoute />} />
              <Route path="workstation/compliance/extensions" element={<DueDateExtensionsRoute />} />
              <Route path="workstation/notices" element={<NoticesRegisterRoute />} />
              <Route path="workstation/dsc" element={<DscRegisterRoute />} />
              <Route path="workstation/tds-recon" element={<TdsReconRoute />} />
              <Route path="workstation/documents" element={<WorkstationDocumentsPage />} />

              {/* Workstation → Task: assignment plus server-tracked work time. */}
              <Route path="workstation/quotations" element={<QuotationListPage />} />
              {/* Invoice — beside Quotation, inside Workstation (§52). The
                  builder handles both new and edit; the detail page is the
                  issued document. */}
              <Route path="workstation/invoices" element={<InvoiceListPage />} />
              <Route path="workstation/invoices/new" element={<InvoiceBuilderPage />} />
              <Route path="workstation/invoices/:id/edit" element={<InvoiceBuilderPage />} />
              <Route path="workstation/invoices/:id" element={<InvoiceDetailPage />} />
              <Route path="workstation/credit-notes" element={<CreditNoteListPage />} />
              <Route path="workstation/credit-notes/new" element={<CreditNoteEditorPage />} />
              <Route path="workstation/credit-notes/:id" element={<CreditNoteEditorPage />} />
              <Route path="workstation/recurring-invoices" element={<RecurringInvoicesPage />} />
              <Route path="workstation/quotations/new" element={<QuotationBuilderPage />} />
              <Route path="workstation/quotations/:id/edit" element={<QuotationBuilderPage />} />
              <Route path="workstation/quotations/:id" element={<QuotationDetailPage />} />
              <Route path="workstation/doc" element={<DocHomePage />} />
              <Route path="workstation/doc/t/:typeId" element={<DocListPage />} />
              <Route path="workstation/doc/t/:typeId/new" element={<DocBuilderPage />} />
              <Route path="workstation/doc/:id/edit" element={<DocBuilderPage />} />
              <Route path="workstation/engagement" element={<EngagementListPage />} />
              <Route path="workstation/engagement/new" element={<EngagementBuilderPage />} />
              <Route path="workstation/engagement/:id/edit" element={<EngagementBuilderPage />} />
              {/* Audit files — one per client × FY × audit type (SA 230). */}
              <Route path="workstation/audits" element={<Lazy><AuditListPage /></Lazy>} />
              <Route path="workstation/audits/udins" element={<Lazy><UdinRegisterPage /></Lazy>} />
              <Route path="workstation/audits/:id" element={<Lazy><AuditFilePage /></Lazy>} />
              <Route path="workstation/tasks" element={<TaskListPage />} />
              <Route path="workstation/tasks/reports" element={<TaskReportsPage />} />
              <Route path="workstation/tasks/:taskId" element={<TaskDetailPage />} />
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
              {/* Repotic Phase 1 — Ecommerce GSTR-1 landing. Phases 2+ add
                  the Build GSTR-1 flow and per-marketplace adapter screens. */}
              <Route path="audit-automation/ecommerce" element={<EcommerceGstr1HomePage />} />

              {/* Bookkeeping (formerly Tally engine) — native double-entry accounting.
                  Now under Services alongside TDS and Registration. */}
              <Route path="workstation/services/bookkeeping" element={<BookkeepingHome />} />
              <Route path="workstation/services/bookkeeping/companies" element={<BookkeepingCompanies />} />
              <Route path="workstation/services/bookkeeping/companies/:companyId" element={<BookkeepingWorkspace />}>
                <Route index element={<BookkeepingDashboard />} />
                <Route path="masters/groups" element={<BookkeepingGroups />} />
                <Route path="masters/ledgers" element={<BookkeepingLedgers />} />
                <Route path="vouchers" element={<BookkeepingVouchers />} />
                <Route path="vouchers/new" element={<BookkeepingVoucherEditor />} />
                <Route path="vouchers/:voucherId" element={<BookkeepingVoucherDetail />} />
                <Route path="vouchers/:voucherId/edit" element={<BookkeepingVoucherEditor />} />
                <Route path="sales" element={<BookkeepingTrade mode="sales" />} />
                <Route path="purchase" element={<BookkeepingTrade mode="purchase" />} />
                <Route path="inventory" element={<BookkeepingInventory />} />
                <Route path="inventory/items/:itemId" element={<BookkeepingStockItemPage />} />
                <Route path="banking" element={<BookkeepingBanking />} />
                <Route path="gst" element={<BookkeepingGst />} />
                <Route path="payroll" element={<BookkeepingPayroll />} />
                <Route path="audit" element={<BookkeepingAudit />} />
                <Route path="import" element={<BookkeepingImportPage />} />
                <Route path="client-dashboard" element={<BookkeepingClientDashboardPage />} />
                <Route path="utilities" element={<BookkeepingUtilities />} />
                <Route path="settings" element={<BookkeepingSettings />} />
                <Route path="reports" element={<BookkeepingReports />} />
                <Route path="reports/ledger/:ledgerId" element={<BookkeepingLedgerStatement />} />
                <Route path="reports/register/:typeCode" element={<BookkeepingRegisterPage />} />
                <Route path="reports/book/:kind" element={<BookkeepingBookPage />} />
                <Route path="reports/:reportId" element={<BookkeepingReportPage />} />
              </Route>

              {/* Books — Zoho Books through Audit OS. One shell; every
                  section is a nested route so each is deep-linkable. */}
              <Route path="books" element={<BooksShell />}>
                <Route index element={<BooksDashboardPage />} />
                <Route path="customers" element={<ResourcePage entity="customers" />} />
                <Route path="customers/:id" element={<ContactDetailPage kind="customer" />} />
                <Route path="vendors" element={<ResourcePage entity="vendors" />} />
                <Route path="vendors/:id" element={<ContactDetailPage kind="vendor" />} />
                <Route path="items" element={<ResourcePage entity="items" />} />
                <Route path="sales/estimates" element={<ResourcePage entity="estimates" />} />
                <Route path="sales/salesorders" element={<ResourcePage entity="salesorders" />} />
                <Route path="sales/invoices" element={<ResourcePage entity="invoices" />} />
                <Route path="purchases/purchaseorders" element={<ResourcePage entity="purchaseorders" />} />
                <Route path="purchases/bills" element={<ResourcePage entity="bills" />} />
                <Route path="expenses" element={<ResourcePage entity="expenses" />} />
                <Route path="payments" element={<PaymentsPage />} />
                <Route path="credit-notes" element={<ResourcePage entity="creditnotes" />} />
                <Route path="debit-notes" element={<ResourcePage entity="vendorcredits" />} />
                <Route path="banking" element={<BankingPage />} />
                <Route path="reconciliation" element={<ReconciliationPage />} />
                <Route path="taxes" element={<TaxesPage />} />
                <Route path="reports" element={<BooksReportsPage />} />
                {/* The rest of Zoho Books' navigation (docs/books-zoho/README.md › Navigation). */}
                <Route path="pricelists" element={<ResourcePage entity="pricebooks" />} />
                <Route path="inventory-adjustments" element={<ResourcePage entity="inventoryadjustments" />} />
                <Route path="sales/retainerinvoices" element={<ResourcePage entity="retainerinvoices" />} />
                <Route path="sales/deliverychallans" element={<ResourcePage entity="deliverychallans" />} />
                <Route path="sales/salesreceipts" element={<ResourcePage entity="salesreceipts" />} />
                <Route path="sales/paymentsreceived" element={<ResourcePage entity="customerpayments" />} />
                <Route path="sales/recurringinvoices" element={<ResourcePage entity="recurringinvoices" />} />
                <Route path="sales/ewaybills" element={<ZohoOnlyPage title="e-Way Bills" zohoPath="ewaybills" why="Zoho Books generates e-Way Bills from invoices, credit notes and delivery challans once e-Way Bills are enabled for the organisation (Zoho Books → Settings → e-Way Bills). Zoho does not list them through its API for this organisation." />} />
                <Route path="purchases/recurringexpenses" element={<ResourcePage entity="recurringexpenses" />} />
                <Route path="purchases/paymentsmade" element={<ResourcePage entity="vendorpayments" />} />
                <Route path="purchases/recurringbills" element={<ResourcePage entity="recurringbills" />} />
                <Route path="timetracking/projects" element={<ResourcePage entity="projects" />} />
                <Route path="timetracking/timesheet" element={<ResourcePage entity="timeentries" />} />
                <Route path="accountant/manualjournals" element={<ResourcePage entity="journals" />} />
                <Route path="accountant/bulkupdate" element={<BulkUpdatePage />} />
                <Route path="accountant/currencyadjustments" element={<ResourcePage entity="currencyadjustments" />} />
                <Route path="accountant/chartofaccounts" element={<ResourcePage entity="accounts" />} />
                <Route path="accountant/budgets" element={<ResourcePage entity="budgets" />} />
                <Route path="accountant/transactionlocking" element={<TransactionLockingPage />} />
                <Route path="documents" element={<ResourcePage entity="documents" />} />
                <Route path="settings" element={<BooksSettingsPage />} />
              </Route>

              <Route path="*" element={<NotFoundPage />} />
            </Route>
            </Routes>
            </Suspense>
          </BrowserRouter>
        </AuthProvider>
        </PwaProvider>
      </ToastProvider>
    </QueryClientProvider>
    </ErrorBoundary>
  );
}
