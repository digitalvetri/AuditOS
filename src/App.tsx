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
              {/* Service categories (GST, TDS, E-Way Bill, Bookkeeping,
                  Incorporation, E-Invoice) — nav structure only for now, so
                  every slug resolves to the same Services page. */}
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
              <Route path="audit-automation/tally" element={<TallyHome />} />
              <Route path="audit-automation/tally/companies" element={<TallyCompanies />} />
              <Route path="audit-automation/tally/companies/:companyId" element={<TallyWorkspace />}>
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
