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
import { TaskListPage } from '@/pages/workstation/tasks/TaskList';
import { TaskDetailPage } from '@/pages/workstation/tasks/TaskDetail';
import { TaskReportsPage } from '@/pages/workstation/tasks/TaskReports';
import { QuotationListPage } from '@/pages/workstation/quotations/QuotationList';
import { InvoiceListPage } from '@/pages/workstation/invoices/InvoiceList';
import { InvoiceBuilderPage } from '@/pages/workstation/invoices/InvoiceBuilder';
import { InvoiceDetailPage } from '@/pages/workstation/invoices/InvoiceDetail';
import { InvoicePreviewPage } from '@/pages/workstation/invoices/InvoicePreview';
import { QuotationBuilderPage } from '@/pages/workstation/quotations/QuotationBuilder';
import { QuotationDetailPage } from '@/pages/workstation/quotations/QuotationDetail';
import { QuotationPreviewPage } from '@/pages/workstation/quotations/QuotationPreview';
import { EngagementListPage } from '@/pages/workstation/engagement/EngagementList';
import { EngagementBuilderPage } from '@/pages/workstation/engagement/EngagementBuilder';
import { EngagementPreviewPage } from '@/pages/workstation/engagement/EngagementPreview';
import { DocHomePage } from '@/pages/workstation/doc/DocHome';
import { DocListPage } from '@/pages/workstation/doc/DocList';
import { DocBuilderPage } from '@/pages/workstation/doc/DocBuilder';
import { DocPreviewPage } from '@/pages/workstation/doc/DocPreview';
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
// Bookkeeping — native double-entry accounting (formerly Tally engine).
import { BookkeepingHome } from '@/pages/workstation/services/bookkeeping/BookkeepingHome';
import { BookkeepingCompanies } from '@/pages/workstation/services/bookkeeping/BookkeepingCompanies';
import { BookkeepingWorkspace } from '@/pages/workstation/services/bookkeeping/BookkeepingWorkspace';
import { BookkeepingGroups } from '@/pages/workstation/services/bookkeeping/BookkeepingGroups';
import { BookkeepingLedgers } from '@/pages/workstation/services/bookkeeping/BookkeepingLedgers';
import { BookkeepingDashboard } from '@/pages/workstation/services/bookkeeping/BookkeepingDashboard';
import { BookkeepingVouchers } from '@/pages/workstation/services/bookkeeping/BookkeepingVouchers';
import { BookkeepingVoucherEditor } from '@/pages/workstation/services/bookkeeping/BookkeepingVoucherEditor';
import { BookkeepingVoucherDetail } from '@/pages/workstation/services/bookkeeping/BookkeepingVoucherDetail';
import { BookkeepingReports } from '@/pages/workstation/services/bookkeeping/BookkeepingReports';
import { BookkeepingReportPage, BookkeepingRegisterPage, BookkeepingBookPage, BookkeepingLedgerStatement } from '@/pages/workstation/services/bookkeeping/BookkeepingReportPage';
import { BookkeepingInventory, BookkeepingStockItemPage } from '@/pages/workstation/services/bookkeeping/BookkeepingInventory';
import { BookkeepingBanking } from '@/pages/workstation/services/bookkeeping/BookkeepingBanking';
import { BookkeepingTallyExport } from '@/pages/workstation/services/bookkeeping/BookkeepingTallyExport';
import { BookkeepingGst } from '@/pages/workstation/services/bookkeeping/BookkeepingGst';
import { BookkeepingTrade } from '@/pages/workstation/services/bookkeeping/BookkeepingTrade';
import { BookkeepingPayroll } from '@/pages/workstation/services/bookkeeping/BookkeepingPayroll';
import { BookkeepingAudit } from '@/pages/workstation/services/bookkeeping/BookkeepingAudit';
import { BookkeepingUtilities } from '@/pages/workstation/services/bookkeeping/BookkeepingUtilities';
import { BookkeepingSettings } from '@/pages/workstation/services/bookkeeping/BookkeepingSettings';
// GST — dedicated landing page + per-service AssistedHandoff detail +
// shape-based workspace dispatcher (recurring period board / project case
// pipeline) + weekly notice-check discovery workflow.
// See docs/gst-services/README.md.
// Registration — Workstation → Services → Registration. Nav structure and
// reference only; nothing files a registration yet.
import { RegistrationServicesLanding } from '@/pages/workstation/registration/RegistrationServicesLanding';
// GST compliance lives inside the GST Registration entry — see GstShell.
import { PartnershipShell } from '@/pages/workstation/registration/partnership/PartnershipShell';
import { PartnershipDashboard } from '@/pages/workstation/registration/partnership/PartnershipDashboard';
import { PartnershipClients } from '@/pages/workstation/registration/partnership/PartnershipClients';
import { PartnershipCase } from '@/pages/workstation/registration/partnership/PartnershipCase';
import { ServiceProvider } from '@/pages/workstation/registration/partnership/shared';
import { PartnershipTemplate } from '@/pages/workstation/registration/partnership/PartnershipTemplate';
import { GstShell } from '@/pages/workstation/registration/gst/GstShell';
import { GstRegistrationTab } from '@/pages/workstation/registration/gst/GstRegistrationTab';
import { GstDashboard } from '@/pages/workstation/registration/gst/GstDashboard';
import { GstClients } from '@/pages/workstation/registration/gst/GstClients';
import { GstClientView } from '@/pages/workstation/registration/gst/GstClientView';
// GstStagePage + GstPeriodDetail deleted in §9-4 — the return tabs
// render PartnershipClients, and the dashboard's 1 › 2B › Recon › 3B
// chain nodes open the shared PartnershipCase directly.
import { GstTemplateHub } from '@/pages/workstation/registration/gst/GstTemplateHub';
import { RegistrationServiceDetail } from '@/pages/workstation/registration/RegistrationServiceDetail';

// TDS — copied from the GST page structure per TDS-PAGE-PROMPT.md.
// Client + FY + TAN scope in the URL; six sub-services (Registration,
// Challan Payment, Return Filing, Correction, Form 16/16A, Notices).
import { TdsServicesLanding } from '@/pages/workstation/tds/TdsServicesLanding';
import { TdsServiceHandoff } from '@/pages/workstation/tds/TdsServiceHandoff';

// Books — Tools → Books, an Audit OS UI over Zoho Books (docs/books-zoho).
import { BooksShell } from '@/pages/books/BooksShell';
import { BooksDashboardPage } from '@/pages/books/BooksDashboard';
import { BooksSettingsPage } from '@/pages/books/BooksSettings';
import { BankingPage, ContactDetailPage, PaymentsPage, ReconciliationPage, ReportsPage as BooksReportsPage, ResourcePage, TaxesPage } from '@/pages/books/BooksPages';
import { AttendancePage } from '@/pages/hrms/Attendance';
import { LeavePage } from '@/pages/hrms/Leave';
import { EmployeesPage } from '@/pages/hrms/Employees';
import { EmployeeDetailPage } from '@/pages/hrms/EmployeeDetail';
import { DocumentsPage } from '@/pages/hrms/Documents';
import { SettingsPage } from '@/pages/hrms/Settings';
import { ZohoPaymentsIntegrationPage } from '@/pages/integrations/ZohoPayments';
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
              <Route path="hrms/payroll" element={<PayrollPage />} />
              <Route path="hrms/payroll/runs/:id" element={<PayrollRunDetailPage />} />
              <Route path="hrms/payroll/payslips/:id" element={<PayslipDetailPage />} />
              <Route path="hrms/expenses" element={<ExpensesPage />} />
              <Route path="hrms/accounts" element={<AccountsPage />} />
              <Route path="hrms/messages" element={<MessagesPage />} />
              <Route path="hrms/documents" element={<DocumentsPage />} />
              <Route path="hrms/reports" element={<ReportsPage />} />
              <Route path="hrms/settings" element={<SettingsPage />} />
              <Route path="integrations/zoho-payments" element={<ZohoPaymentsIntegrationPage />} />

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
              <Route path="workstation/services/tds/:slug" element={<TdsServiceHandoff />} />
              {/* Services → E-Invoice and Services → E-Way Bill were removed.
                  Their old addresses are pinned to Not Found so the :category
                  catch-all below cannot serve them as a generic Services page.
                  Registration → E-Invoice / E-Way Bill live under
                  workstation/services/registration/… and are unaffected. */}
              <Route path="workstation/services/e-invoice" element={<NotFoundPage />} />
              <Route path="workstation/services/e-way-bill" element={<NotFoundPage />} />
              {/* Service categories (TDS) — nav structure only for now, so
                  every remaining slug resolves to the same Services page. */}
              {/* Registration category — declared BEFORE the :category
                  catch-all below, or that would swallow the slug. */}
              <Route path="workstation/services/registration" element={<RegistrationServicesLanding />} />
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
                <Route path="about" element={<Navigate to="../registration" replace />} />
              </Route>
              <Route path="workstation/services/registration/:slug" element={<RegistrationServiceDetail />} />
              <Route path="workstation/services/:category" element={<ServicesPage />} />
              <Route path="workstation/follow-ups" element={<FollowUpsPage />} />
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
              <Route path="audit-automation/tds" element={<TdsJobsListPage />} />
              <Route path="audit-automation/tds/new" element={<TdsNewReconPage />} />
              <Route path="audit-automation/tds/jobs/:jobId" element={<TdsReconDetailPage />} />

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
                <Route path="tally-export" element={<BookkeepingTallyExport />} />
                <Route path="gst" element={<BookkeepingGst />} />
                <Route path="payroll" element={<BookkeepingPayroll />} />
                <Route path="audit" element={<BookkeepingAudit />} />
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
