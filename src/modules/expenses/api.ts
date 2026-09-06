import { api } from '@/services/api';
import type { Expense, ExpenseApproval, ExpensePaymentMethod, ExpenseStage } from '@/data/models';

export interface ExpenseWithRefs extends Expense {
  employee: { id: string; full_name: string; employee_code: string; department_id: string } | null;
  category: { id: string; name: string; code: string } | null;
}

export interface ExpenseListResponse {
  items: ExpenseWithRefs[];
  count: number;
  scope: 'self' | 'department' | 'organisation';
}

export interface ExpenseDetail {
  expense: ExpenseWithRefs;
  approvals: ExpenseApproval[];
}

export const expensesApi = {
  list: (opts: { stage?: ExpenseStage; scope?: 'mine' | 'team-queue' | 'finance-queue' } = {}) => {
    const p = new URLSearchParams();
    if (opts.stage) p.set('stage', opts.stage);
    if (opts.scope) p.set('scope', opts.scope);
    const qs = p.toString();
    return api.get<ExpenseListResponse>(`/api/expenses${qs ? `?${qs}` : ''}`);
  },
  get: (id: string) => api.get<ExpenseDetail>(`/api/expenses/${id}`),
  create: (body: {
    title: string;
    category_id: string;
    amount_paise: number;
    expense_date: string;
    description?: string;
    payment_method?: ExpensePaymentMethod;
    notes?: string;
  }) => api.post<{ expense: Expense }>('/api/expenses', body),
  update: (id: string, body: Partial<Expense>) => api.patch<{ expense: Expense }>(`/api/expenses/${id}`, body),
  submit: (id: string) => api.post<{ expense: Expense }>(`/api/expenses/${id}/submit`),
  approve: (id: string) => api.post<{ expense: Expense }>(`/api/expenses/${id}/approve`),
  reject: (id: string, reason: string) => api.post<{ expense: Expense }>(`/api/expenses/${id}/reject`, { reason }),
  pay: (id: string) => api.post<{ expense: Expense; payment_id: string }>(`/api/expenses/${id}/pay`),
};

export const STAGE_LABEL: Record<ExpenseStage, string> = {
  draft: 'Draft',
  pending_manager: 'Awaiting Manager',
  pending_finance: 'Awaiting Finance',
  approved: 'Approved',
  paid: 'Paid',
  rejected: 'Rejected',
};
