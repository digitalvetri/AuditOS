import { api } from '@/services/api';
import type { LedgerTransaction, Payment } from '@/data/models';

export interface LedgerRowWithEmp extends LedgerTransaction {
  employee: { id: string; full_name: string; employee_code: string } | null;
}

export interface PaymentWithEmp extends Payment {
  employee: { id: string; full_name: string; employee_code: string } | null;
}

export interface AccountsSummary {
  totals: { debit_paise: number; credit_paise: number; balance_paise: number };
  this_month: { debit_paise: number; credit_paise: number };
  by_type: { type: string; debit: number; credit: number; count: number }[];
}

export const accountsApi = {
  ledger: (filters: { type?: string; employeeId?: string; from?: string; to?: string } = {}) => {
    const p = new URLSearchParams();
    if (filters.type) p.set('type', filters.type);
    if (filters.employeeId) p.set('employeeId', filters.employeeId);
    if (filters.from) p.set('from', filters.from);
    if (filters.to) p.set('to', filters.to);
    const qs = p.toString();
    return api.get<{ items: LedgerRowWithEmp[]; count: number }>(
      `/api/accounts/ledger${qs ? `?${qs}` : ''}`,
    );
  },
  summary: () => api.get<AccountsSummary>('/api/accounts/summary'),
  reverse: (id: string) =>
    api.post<{ original: LedgerTransaction; reverse: LedgerTransaction }>(
      `/api/accounts/ledger/${id}/reverse`,
    ),
  payments: {
    list: (filters: { employeeId?: string; status?: string } = {}) => {
      const p = new URLSearchParams();
      if (filters.employeeId) p.set('employeeId', filters.employeeId);
      if (filters.status) p.set('status', filters.status);
      const qs = p.toString();
      return api.get<{ items: PaymentWithEmp[]; count: number }>(
        `/api/payments${qs ? `?${qs}` : ''}`,
      );
    },
    create: (body: {
      employee_id: string;
      amount_paise: number;
      method?: Payment['method'];
      reference?: string;
      ledger_type?: LedgerTransaction['type'];
      description?: string;
    }) => api.post<{ payment: Payment }>('/api/payments', body),
  },
};

export const LEDGER_TYPES: LedgerTransaction['type'][] = [
  'Payroll', 'Expense Reimbursement', 'Office Expense', 'Employee Advance', 'Advance Recovery', 'Payment',
];
