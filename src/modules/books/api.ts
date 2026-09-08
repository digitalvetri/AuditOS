import { api } from '@/services/api';
import type {
  Ageing, AuditEvent, BalanceSheet, BankTransfer, Bill, BillAllocation, BooksDocument, BooksListResponse, BooksOrg,
  CashFlow, Contact, Dashboard, DocKind, ExchangeRate, GeneralLedger, Gstr1, Gstr3b, Item, Journal, Ledger,
  AccountGroup, Payment, ProfitAndLoss, Reconciliation, RecurringProfile, Revaluation, TaxRate, TrialBalance,
} from './types';

/**
 * Books API client. Every call inside a set of books is scoped by its id in
 * the path; the server resolves membership from the session, so nothing
 * here decides access.
 */
function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export interface DocFilters { status?: string; contact_id?: string; from?: string; to?: string; q?: string }

export const booksApi = {
  list: () => api.get<BooksListResponse>('/api/books'),
  create: (body: Record<string, unknown>) => api.post<BooksOrg>('/api/books', body),
  firmUsers: () => api.get<{ items: { id: string; email: string; name: string; role: string }[] }>('/api/books/users'),

  org: (id: string) => ({
    get: () => api.get<BooksOrg>(`/api/books/${id}`),
    update: (body: Record<string, unknown>) => api.patch<BooksOrg>(`/api/books/${id}`, body),
    dashboard: () => api.get<Dashboard>(`/api/books/${id}/dashboard`),
    sequences: () => api.get<{ items: { kind: string; prefix: string; next: number }[] }>(`/api/books/${id}/sequences`),

    members: {
      list: () => api.get<{ items: { id: string; user_id: string; role: string; name: string; email: string | null }[] }>(`/api/books/${id}/members`),
      set: (user_id: string, role: string) => api.post(`/api/books/${id}/members`, { user_id, role }),
      remove: (userId: string) => api.delete<void>(`/api/books/${id}/members/${userId}`),
    },

    contacts: {
      list: (f: { type?: string; q?: string } = {}) => api.get<{ items: Contact[] }>(`/api/books/${id}/contacts${qs(f)}`),
      get: (cid: string) => api.get<{ contact: Contact; documents: BooksDocument[]; open_items: Bill[]; receivable: number; payable: number }>(`/api/books/${id}/contacts/${cid}`),
      create: (body: Record<string, unknown>) => api.post<Contact>(`/api/books/${id}/contacts`, body),
      update: (cid: string, body: Record<string, unknown>) => api.patch<Contact>(`/api/books/${id}/contacts/${cid}`, body),
      setActive: (cid: string, is_active: boolean) => api.post<Contact>(`/api/books/${id}/contacts/${cid}/status`, { is_active }),
    },

    items: {
      list: (f: { q?: string } = {}) => api.get<{ items: Item[] }>(`/api/books/${id}/items${qs(f)}`),
      create: (body: Record<string, unknown>) => api.post<Item>(`/api/books/${id}/items`, body),
      update: (iid: string, body: Record<string, unknown>) => api.patch<Item>(`/api/books/${id}/items/${iid}`, body),
    },

    taxRates: {
      list: (type?: string) => api.get<{ items: TaxRate[] }>(`/api/books/${id}/tax-rates${qs({ type })}`),
      create: (body: Record<string, unknown>) => api.post<TaxRate>(`/api/books/${id}/tax-rates`, body),
      update: (tid: string, body: Record<string, unknown>) => api.patch<TaxRate>(`/api/books/${id}/tax-rates/${tid}`, body),
    },

    chart: {
      groups: () => api.get<{ items: AccountGroup[] }>(`/api/books/${id}/chart/groups`),
      createGroup: (body: Record<string, unknown>) => api.post<AccountGroup>(`/api/books/${id}/chart/groups`, body),
      ledgers: (f: { root?: string; q?: string; bank?: boolean } = {}) => api.get<{ items: Ledger[] }>(`/api/books/${id}/chart/ledgers${qs({ root: f.root, q: f.q, bank: f.bank ? 1 : undefined })}`),
      ledger: (lid: string) => api.get<Ledger>(`/api/books/${id}/chart/ledgers/${lid}`),
      createLedger: (body: Record<string, unknown>) => api.post<Ledger>(`/api/books/${id}/chart/ledgers`, body),
      updateLedger: (lid: string, body: Record<string, unknown>) => api.patch<Ledger>(`/api/books/${id}/chart/ledgers/${lid}`, body),
      deleteLedger: (lid: string) => api.delete<void>(`/api/books/${id}/chart/ledgers/${lid}`),
    },

    documents: {
      list: (kind: DocKind, f: DocFilters = {}) => api.get<{ items: BooksDocument[] }>(`/api/books/${id}/documents/${kind}${qs({ ...f })}`),
      get: (kind: DocKind, did: string) => api.get<{ document: BooksDocument; contact: Contact; journal: Journal | null; open_item: Bill | null; applications: BillAllocation[]; audit: AuditEvent[] }>(`/api/books/${id}/documents/${kind}/${did}`),
      create: (kind: DocKind, body: Record<string, unknown>) => api.post<BooksDocument>(`/api/books/${id}/documents/${kind}`, body),
      update: (kind: DocKind, did: string, body: Record<string, unknown>) => api.patch<BooksDocument>(`/api/books/${id}/documents/${kind}/${did}`, body),
      post: (kind: DocKind, did: string) => api.post<BooksDocument>(`/api/books/${id}/documents/${kind}/${did}/post`),
      void: (kind: DocKind, did: string, reason?: string) => api.post<BooksDocument>(`/api/books/${id}/documents/${kind}/${did}/void`, { reason }),
      setStatus: (kind: DocKind, did: string, status: string) => api.post<BooksDocument>(`/api/books/${id}/documents/${kind}/${did}/status`, { status }),
      convert: (kind: DocKind, did: string, to: DocKind) => api.post<BooksDocument>(`/api/books/${id}/documents/${kind}/${did}/convert`, { to }),
      applyCredit: (kind: DocKind, did: string, applications: { document_id: string; amount: number }[], date?: string) => api.post<BooksDocument>(`/api/books/${id}/documents/${kind}/${did}/apply-credit`, { applications, date }),
      applyRetainer: (did: string, applications: { document_id: string; amount: number }[], date?: string) => api.post<BooksDocument>(`/api/books/${id}/documents/retainer_invoice/${did}/apply-retainer`, { applications, date }),
    },

    openItems: (f: { side?: 'debit' | 'credit'; contact_id?: string } = {}) => api.get<{ items: Bill[] }>(`/api/books/${id}/open-items${qs(f)}`),

    payments: {
      list: (kind: 'received' | 'made', f: { contact_id?: string; from?: string; to?: string } = {}) => api.get<{ items: Payment[] }>(`/api/books/${id}/payments/${kind}${qs(f)}`),
      get: (kind: 'received' | 'made', pid: string) => api.get<{ payment: Payment; allocations: BillAllocation[]; audit: AuditEvent[] }>(`/api/books/${id}/payments/${kind}/${pid}`),
      create: (kind: 'received' | 'made', body: Record<string, unknown>) => api.post<Payment>(`/api/books/${id}/payments/${kind}`, body),
      void: (kind: 'received' | 'made', pid: string, reason?: string) => api.post<Payment>(`/api/books/${id}/payments/${kind}/${pid}/void`, { reason }),
    },

    journals: {
      list: (f: { status?: string; voucher_type?: string; from?: string; to?: string; q?: string } = {}) => api.get<{ items: Journal[] }>(`/api/books/${id}/journals${qs(f)}`),
      get: (jid: string) => api.get<Journal & { audit: AuditEvent[] }>(`/api/books/${id}/journals/${jid}`),
      create: (body: Record<string, unknown>) => api.post<Journal>(`/api/books/${id}/journals`, body),
      update: (jid: string, body: Record<string, unknown>) => api.patch<Journal>(`/api/books/${id}/journals/${jid}`, body),
      post: (jid: string) => api.post<Journal>(`/api/books/${id}/journals/${jid}/post`),
      void: (jid: string, reason?: string) => api.post(`/api/books/${id}/journals/${jid}/void`, { reason }),
      remove: (jid: string) => api.delete<void>(`/api/books/${id}/journals/${jid}`),
    },

    audit: (f: { entity_type?: string; entity_id?: string } = {}) => api.get<{ items: AuditEvent[] }>(`/api/books/${id}/audit${qs(f)}`),

    banking: {
      accounts: () => api.get<{ items: Ledger[] }>(`/api/books/${id}/banking/accounts`),
      transfers: () => api.get<{ items: BankTransfer[] }>(`/api/books/${id}/banking/transfers`),
      transfer: (body: Record<string, unknown>) => api.post<BankTransfer>(`/api/books/${id}/banking/transfers`, body),
      voidTransfer: (tid: string, reason?: string) => api.post(`/api/books/${id}/banking/transfers/${tid}/void`, { reason }),
      reconciliation: (ledgerId: string, f: { from?: string; to?: string } = {}) => api.get<Reconciliation>(`/api/books/${id}/banking/${ledgerId}/reconciliation${qs(f)}`),
      addStatementLines: (ledgerId: string, lines: { date: string; description: string; amount: number; reference?: string }[]) => api.post(`/api/books/${id}/banking/${ledgerId}/statement-lines`, { lines }),
      deleteStatementLine: (lineId: string) => api.delete<void>(`/api/books/${id}/banking/statement-lines/${lineId}`),
      match: (statement_line_id: string, journal_line_id: string) => api.post<void>(`/api/books/${id}/banking/match`, { statement_line_id, journal_line_id }),
      unmatch: (statement_line_id: string) => api.post<void>(`/api/books/${id}/banking/unmatch`, { statement_line_id }),
    },

    fx: {
      rates: (currency?: string) => api.get<{ items: ExchangeRate[] }>(`/api/books/${id}/fx/rates${qs({ currency })}`),
      setRate: (body: { currency: string; date: string; rate: number }) => api.post<ExchangeRate>(`/api/books/${id}/fx/rates`, body),
      exposure: (currency: string, rate?: number) => api.get<{ items: (Bill & { revalued: number | null; delta: number | null })[] }>(`/api/books/${id}/fx/exposure${qs({ currency, rate })}`),
      revalue: (body: { currency: string; rate: number; date: string }) => api.post<{ revaluation: Revaluation }>(`/api/books/${id}/fx/revalue`, body),
      revaluations: () => api.get<{ items: Revaluation[] }>(`/api/books/${id}/fx/revaluations`),
    },

    recurring: {
      list: (kind?: string) => api.get<{ items: RecurringProfile[] }>(`/api/books/${id}/recurring${qs({ kind })}`),
      create: (body: Record<string, unknown>) => api.post<RecurringProfile>(`/api/books/${id}/recurring`, body),
      setStatus: (rid: string, status: string) => api.post<RecurringProfile>(`/api/books/${id}/recurring/${rid}/status`, { status }),
      run: (today?: string) => api.post<{ created: { document_id: string; number: string; date: string; posted: boolean }[] }>(`/api/books/${id}/recurring/run`, { today }),
    },

    reports: {
      trialBalance: (as_of?: string) => api.get<TrialBalance>(`/api/books/${id}/reports/trial-balance${qs({ as_of })}`),
      profitAndLoss: (from?: string, to?: string) => api.get<ProfitAndLoss>(`/api/books/${id}/reports/profit-and-loss${qs({ from, to })}`),
      balanceSheet: (as_of?: string) => api.get<BalanceSheet>(`/api/books/${id}/reports/balance-sheet${qs({ as_of })}`),
      cashFlow: (from?: string, to?: string) => api.get<CashFlow>(`/api/books/${id}/reports/cash-flow${qs({ from, to })}`),
      generalLedger: (ledger_id: string, from?: string, to?: string) => api.get<GeneralLedger>(`/api/books/${id}/reports/general-ledger${qs({ ledger_id, from, to })}`),
      ageing: (kind: 'ar' | 'ap', as_of?: string) => api.get<Ageing>(`/api/books/${id}/reports/${kind}-ageing${qs({ as_of })}`),
      gstr1: (from?: string, to?: string) => api.get<Gstr1>(`/api/books/${id}/reports/gstr-1${qs({ from, to })}`),
      gstr3b: (from?: string, to?: string) => api.get<Gstr3b>(`/api/books/${id}/reports/gstr-3b${qs({ from, to })}`),
      tds: (from?: string, to?: string) => api.get<{ items: { bill: string; date: string; vendor: string; pan: string | null; section: string | null; rate_bp: number | null; taxable: number; tds: number }[] }>(`/api/books/${id}/reports/tds${qs({ from, to })}`),
    },
  }),
};
