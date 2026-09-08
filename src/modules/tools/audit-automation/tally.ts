import { api } from '@/services/api';

/**
 * Tally API client (Slice 1: Foundation).
 * Mirror of the audit-automation api.ts shape. Everything JSON —
 * Tally uploads (import/export) don't ship in Slice 1.
 */

export interface TallyCompany {
  id: string;
  name: string;
  mailing_name: string | null;
  address: string | null;
  country: string;
  state: string | null;
  pin: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  base_currency: string;
  gst_registration_type: string;
  gstin: string | null;
  pan: string | null;
  tan: string | null;
  fy_begin_month: number;
  books_begin_from: string;
  active: boolean;
  created_at: string;
}

export interface TallyFinancialYear {
  id: string;
  label: string;
  start_date: string;
  end_date: string;
  closed: boolean;
  created_at: string;
}

export interface TallyGroup {
  id: string;
  name: string;
  parent_group_id: string | null;
  nature: 'assets' | 'liabilities' | 'income' | 'expenses';
  affects_pl: boolean;
  is_primary: boolean;
}

export interface TallyGroupTreeNode extends TallyGroup {
  children: TallyGroupTreeNode[];
}

export interface TallyLedger {
  id: string;
  name: string;
  group_id: string;
  opening_balance_paise: number;
  opening_balance_type: 'dr' | 'cr';
  opening_balance_as_of_fy_id: string | null;
  address: string | null;
  contact: string | null;
  gstin: string | null;
  pan: string | null;
  state: string | null;
  gst_registration_type: string | null;
  credit_period_days: number | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  tax_config: unknown;
  active: boolean;
}

export interface CreateTallyCompanyInput {
  name: string;
  mailing_name?: string;
  address?: string;
  state?: string;
  pin?: string;
  phone?: string;
  email?: string;
  website?: string;
  gst_registration_type?: 'regular' | 'composition' | 'unregistered' | 'sez' | 'overseas';
  gstin?: string;
  pan?: string;
  tan?: string;
  fy_begin_month?: number;
  books_begin_from: string;
}

export interface CreateTallyLedgerInput {
  name: string;
  group_id: string;
  opening_balance_paise?: number;
  opening_balance_type?: 'dr' | 'cr';
  opening_balance_as_of_fy_id?: string | null;
  address?: string;
  contact?: string;
  gstin?: string;
  pan?: string;
  state?: string;
  gst_registration_type?: string;
  credit_period_days?: number;
  bank_account_name?: string;
  bank_account_number?: string;
  bank_ifsc?: string;
}

export const tallyApi = {
  // Companies
  listCompanies: () => api.get<{ items: TallyCompany[] }>('/api/tally/companies'),
  getCompany: (id: string) => api.get<TallyCompany>(`/api/tally/companies/${id}`),
  createCompany: (input: CreateTallyCompanyInput) => api.post<TallyCompany>('/api/tally/companies', input),
  updateCompany: (id: string, patch: Partial<CreateTallyCompanyInput> & { active?: boolean }) =>
    api.patch<TallyCompany>(`/api/tally/companies/${id}`, patch),

  // Financial years
  listFinancialYears: (companyId: string) =>
    api.get<{ items: TallyFinancialYear[] }>(`/api/tally/companies/${companyId}/financial-years`),
  createFinancialYear: (companyId: string, input: { label: string; start_date: string; end_date: string }) =>
    api.post<TallyFinancialYear>(`/api/tally/companies/${companyId}/financial-years`, input),
  closeFinancialYear: (companyId: string, fyId: string) =>
    api.patch<TallyFinancialYear>(`/api/tally/companies/${companyId}/financial-years/${fyId}/close`, {}),

  // Groups
  listGroups: (companyId: string) => api.get<{ items: TallyGroup[] }>(`/api/tally/companies/${companyId}/groups`),
  groupTree: (companyId: string) =>
    api.get<{ tree: TallyGroupTreeNode[] }>(`/api/tally/companies/${companyId}/groups?tree=1`),
  createGroup: (companyId: string, input: {
    name: string; parent_group_id?: string | null;
    nature?: 'assets' | 'liabilities' | 'income' | 'expenses'; affects_pl?: boolean;
  }) => api.post<TallyGroup>(`/api/tally/companies/${companyId}/groups`, input),
  updateGroup: (companyId: string, groupId: string, patch: {
    name?: string; parent_group_id?: string | null; affects_pl?: boolean;
  }) => api.patch<TallyGroup>(`/api/tally/companies/${companyId}/groups/${groupId}`, patch),
  deleteGroup: (companyId: string, groupId: string) =>
    api.delete<void>(`/api/tally/companies/${companyId}/groups/${groupId}`),

  // Ledgers
  listLedgers: (companyId: string, filter: { group_id?: string; q?: string } = {}) => {
    const sp = new URLSearchParams();
    if (filter.group_id) sp.set('group_id', filter.group_id);
    if (filter.q) sp.set('q', filter.q);
    const s = sp.toString();
    return api.get<{ items: TallyLedger[] }>(`/api/tally/companies/${companyId}/ledgers${s ? `?${s}` : ''}`);
  },
  getLedger: (companyId: string, ledgerId: string) =>
    api.get<TallyLedger>(`/api/tally/companies/${companyId}/ledgers/${ledgerId}`),
  createLedger: (companyId: string, input: CreateTallyLedgerInput) =>
    api.post<TallyLedger>(`/api/tally/companies/${companyId}/ledgers`, input),
  updateLedger: (companyId: string, ledgerId: string, patch: Partial<CreateTallyLedgerInput> & { active?: boolean }) =>
    api.patch<TallyLedger>(`/api/tally/companies/${companyId}/ledgers/${ledgerId}`, patch),
  deleteLedger: (companyId: string, ledgerId: string) =>
    api.delete<void>(`/api/tally/companies/${companyId}/ledgers/${ledgerId}`),
};
