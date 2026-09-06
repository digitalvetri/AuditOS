import { api } from '@/services/api';
import type {
  PayrollItem,
  PayrollRun,
  PayrollStage,
  Payment,
  Payslip,
  SalaryStructure,
} from '@/data/models';

export interface PayrollItemWithEmp extends PayrollItem {
  employee: { id: string; full_name: string; employee_code: string; department_id: string } | null;
}

export interface PayrollRunDetail {
  run: PayrollRun;
  items: PayrollItemWithEmp[];
}

export interface PayslipListItem extends Payslip {
  period_start: string | null;
  period_end: string | null;
  gross_paise: number;
  net_paise: number;
  employee: { id: string; full_name: string; employee_code: string } | null;
}

export interface PayslipDetail {
  payslip: Payslip;
  run: PayrollRun | null;
  item: PayrollItem | null;
  structure: SalaryStructure | null;
  employee: { id: string; full_name: string; employee_code: string; email: string } | null;
  department: { id: string; name: string } | null;
  designation: { id: string; name: string } | null;
}

export const payrollApi = {
  runs: {
    list: () => api.get<{ items: PayrollRun[] }>('/api/payroll/runs'),
    get: (id: string) => api.get<PayrollRunDetail>(`/api/payroll/runs/${id}`),
    create: (period_start: string, period_end: string) =>
      api.post<{ run: PayrollRun }>('/api/payroll/runs', { period_start, period_end }),
    calculate: (id: string) =>
      api.post<{ run: PayrollRun; items: PayrollItem[] }>(`/api/payroll/runs/${id}/calculate`),
    review: (id: string) => api.post<{ run: PayrollRun }>(`/api/payroll/runs/${id}/review`),
    approve: (id: string) => api.post<{ run: PayrollRun }>(`/api/payroll/runs/${id}/approve`),
    process: (id: string) =>
      api.post<{ run: PayrollRun; payments: Payment[]; payslips: Payslip[] }>(`/api/payroll/runs/${id}/process`),
  },
  payslips: {
    list: (opts: { employeeId?: string; runId?: string } = {}) => {
      const p = new URLSearchParams();
      if (opts.employeeId) p.set('employeeId', opts.employeeId);
      if (opts.runId) p.set('runId', opts.runId);
      const qs = p.toString();
      return api.get<{ items: PayslipListItem[] }>(`/api/payroll/payslips${qs ? `?${qs}` : ''}`);
    },
    get: (id: string) => api.get<PayslipDetail>(`/api/payroll/payslips/${id}`),
    downloadUrl: (id: string) =>
      api.get<{ url: string; expires_at: string }>(`/api/payroll/payslips/${id}/download-url`),
  },
  salary: {
    get: (employeeId: string) =>
      api.get<{ current: SalaryStructure | null; history: SalaryStructure[] }>(
        `/api/employees/${employeeId}/salary`,
      ),
    patch: (
      employeeId: string,
      body: { effective_from: string } & Partial<
        Pick<
          SalaryStructure,
          | 'monthly_ctc_paise'
          | 'basic_paise'
          | 'hra_paise'
          | 'conveyance_paise'
          | 'special_allowance_paise'
        >
      >,
    ) => api.patch<{ structure: SalaryStructure }>(`/api/employees/${employeeId}/salary`, body),
  },
};

export const STAGE_LABEL: Record<PayrollStage, string> = {
  draft: 'Draft',
  hr_review: 'HR Review',
  finance_review: 'Finance Review',
  approved: 'Approved',
  processed: 'Processed',
};
