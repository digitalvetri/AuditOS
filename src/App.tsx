import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes, Navigate } from 'react-router-dom';
import { AuthProvider } from '@/platform/auth/AuthContext';
import { ProtectedRoute } from '@/platform/auth/ProtectedRoute';
import { AppShell } from '@/shell/AppShell';
import { LoginPage } from '@/pages/Login';
import { DashboardPage } from '@/pages/Dashboard';
// Workstation (AUDIT_OS_WORKSTATION.md §4) — replaces the reserved screen.
import { WorkstationDashboardPage } from '@/pages/workstation/Dashboard';
import { LeadsPage } from '@/pages/workstation/Leads';
import { LeadDetailPage } from '@/pages/workstation/LeadDetail';
import { ClientsPage } from '@/pages/workstation/Clients';
import { ClientWorkspacePage } from '@/pages/workstation/ClientWorkspace';
import { ServicesPage } from '@/pages/workstation/Services';
import { FollowUpsPage } from '@/pages/workstation/FollowUps';
import { DocumentsPage as WorkstationDocumentsPage } from '@/pages/workstation/Documents';
import { ToolsPage } from '@/pages/reserved/Tools';
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
// Side-effect import — triggers module widget registration at boot.
import '@/modules';

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
              <Route path="workstation/follow-ups" element={<FollowUpsPage />} />
              <Route path="workstation/documents" element={<WorkstationDocumentsPage />} />
              <Route path="tools" element={<ToolsPage />} />

              <Route path="*" element={<NotFoundPage />} />
            </Route>
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
