import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes, Navigate } from 'react-router-dom';
import { AuthProvider } from '@/platform/auth/AuthContext';
import { ProtectedRoute } from '@/platform/auth/ProtectedRoute';
import { AppShell } from '@/shell/AppShell';
import { LoginPage } from '@/pages/Login';
import { DashboardPage } from '@/pages/Dashboard';
import { WorkstationPage } from '@/pages/reserved/Workstation';
import { ToolsPage } from '@/pages/reserved/Tools';
import { ModulePlaceholder } from '@/pages/hrms/ModulePlaceholder';
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
              <Route path="hrms/messages" element={<ModulePlaceholder name="Messages" plannedIn="Part 2 (owned by Developer 2)" />} />
              <Route path="hrms/documents" element={<DocumentsPage />} />
              <Route path="hrms/reports" element={<ModulePlaceholder name="Reports" plannedIn="Part 2 (owned by Developer 2)" />} />
              <Route path="hrms/settings" element={<SettingsPage />} />

              <Route path="me/profile" element={<MyProfileRoute />} />
              <Route path="me/attendance" element={<AttendancePage />} />
              <Route path="me/leave" element={<LeavePage />} />
              <Route path="me/expenses" element={<ExpensesPage />} />
              <Route path="me/payslips" element={<MyPayslipsPage />} />
              <Route path="me/payslips/:id" element={<PayslipDetailPage />} />

              <Route path="notifications" element={<NotificationsPage />} />

              <Route path="workstation" element={<WorkstationPage />} />
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
