import { api } from '@/services/api';
import type { LedgerTransaction, Payment } from '@/data/models';

export interface LedgerRowWithEmp extends LedgerTransaction {
  employee: { id: string; full_name: string; employee_code: string } | null;
}

export interface PaymentWithEmp extends Payment {
  employee: { id: string; full_name: string; employee_code: string } | null;
}

export interface AccountsSummary {
  totals: { debit_paise: number; credit_paise: number; balance_paise: number; balanced: boolean };
  this_month: { debit_paise: number; credit_paise: number };
  by_type: { type: string; debit: number; credit: number; count: number }[];
}

export type LedgerSort = 'date' | 'amount' | 'type' | 'employee';
export type LedgerDir = 'asc' | 'desc';

export interface LedgerListResponse {
  items: LedgerRowWithEmp[];
  count: number;
  sort: LedgerSort;
  dir: LedgerDir;
  running_balance_available: boolean;
}

export interface HeldLiability {
  category: 'PF Payable' | 'ESI Payable' | 'Professional Tax Payable' | 'TDS Payable';
  balance_paise: number;
}

export interface OverviewNeedsYouItem {
  id: string;
  kind: string;
  message: string;
  amount_paise: number | null;
  count: number | null;
  action_url: string;
  action_label: string;
}

export interface AccountsOverview {
  month: string;
  month_label: string;
  this_month: {
    salary_cost_paise: number;
    salary_employee_count: number;
    expense_claims_paise: number;
    expense_claim_count: number;
    paid_out_paise: number;
    payment_count: number;
    collected_paise: number;
    zpay_connected: boolean;
  };
  needs_you: OverviewNeedsYouItem[];
  held_liabilities: HeldLiability[];
  ledger: {
    debit_paise: number;
    credit_paise: number;
    balance_paise: number;
    balanced: boolean;
  };
}

export const accountsApi = {
  ledger: (
    filters: {
      type?: string; employeeId?: string; from?: string; to?: string;
      sort?: LedgerSort; dir?: LedgerDir;
    } = {},
  ) => {
    const p = new URLSearchParams();
    if (filters.type) p.set('type', filters.type);
    if (filters.employeeId) p.set('employeeId', filters.employeeId);
    if (filters.from) p.set('from', filters.from);
    if (filters.to) p.set('to', filters.to);
    if (filters.sort) p.set('sort', filters.sort);
    if (filters.dir) p.set('dir', filters.dir);
    const qs = p.toString();
    return api.get<LedgerListResponse>(
      `/api/accounts/ledger${qs ? `?${qs}` : ''}`,
    );
  },
  summary: () => api.get<AccountsSummary>('/api/accounts/summary'),
  overview: (month?: string) =>
    api.get<AccountsOverview>(`/api/accounts/overview${month ? `?month=${month}` : ''}`),
  heldLiabilities: () =>
    api.get<{ items: HeldLiability[] }>('/api/accounts/liabilities/held'),
  remit: (body: {
    category: HeldLiability['category'];
    amount_paise: number;
    reference: string;
    date?: string;
    notes?: string;
  }) => api.post<{ payment: Payment; ledger_rows: LedgerTransaction[] }>(
    '/api/accounts/liabilities/remit', body,
  ),
  reverse: (id: string, reason: string) =>
    api.post<{
      originals: LedgerTransaction[];
      contras: LedgerTransaction[];
      reason: string;
      cluster_size: number;
    }>(`/api/accounts/ledger/${id}/reverse`, { reason }),
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
