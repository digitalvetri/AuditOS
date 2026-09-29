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

export interface PayrollBlocker {
  employee: { id: string; full_name: string; employee_code: string; department_id: string } | null;
  reason: 'no_salary_structure' | 'tds_plan_missing';
  message: string;
}

export interface TdsPlan {
  annual_tds_plan_paise: number;
  monthly_tds_paise: number;
  exempt_reason: string | null;
  threshold_paise: number;
}

export interface PayrollVariance {
  previous_run_id: string;
  previous_label: string;
  previous_gross_paise: number;
  delta_paise: number;
  same_headcount: boolean;
}

export interface PayrollRunDetail {
  run: PayrollRun & { label: string };
  items: PayrollItemWithEmp[];
  blockers: PayrollBlocker[];
  variance: PayrollVariance | null;
  can_process: boolean;
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
    create: (year: number, month: number) =>
      api.post<{ run: PayrollRun }>('/api/payroll/runs', { year, month }),
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
      api.get<{
        current: SalaryStructure | null;
        history: SalaryStructure[];
        tds_plan: TdsPlan | null;
      }>(
        `/api/employees/${employeeId}/salary`,
      ),
    setTdsPlan: (
      employeeId: string,
      body: { annual_tds_plan_paise: number; exempt_reason?: string | null },
    ) => api.patch<{
      employee_id: string;
      annual_tds_plan_paise: number;
      monthly_tds_paise: number;
      exempt_reason: string | null;
    }>(`/api/employees/${employeeId}/salary/tds-plan`, body),
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
