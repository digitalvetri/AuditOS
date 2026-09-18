/**
 * Frontend client for the Zoho Payments integration
 * (docs/zoho-payments/README.md). The shape mirrors the server routes
 * added in step 2 (server/src/modules/zpay/routes.ts); every call rides
 * the same `{data}/{error}` envelope as the rest of the app.
 */
import { api } from '@/services/api';

export type ZpayStatus =
  | 'not_connected'
  | 'consent_pending'
  | 'connected'
  | 'revoked'
  | 'expired'
  | 'error';

export interface ZpayAccountSummary {
  id: string;
  accountId: string;
  label: string;
  isGstRegistered: boolean;
  gstin: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  isActive: boolean;
}

export interface ZpayConnectionSummary {
  id: string;
  zohoOrgLabel: string;
  status: ZpayStatus;
  connectedAt: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  scopesGranted: string[];
  accounts: ZpayAccountSummary[];
}

export interface CreateConnectionInput {
  zohoOrgLabel: string;
}

export interface AuthorizeResult {
  authorizeUrl: string;
}

export interface CreateAccountInput {
  accountId: string;
  label: string;
  isGstRegistered: boolean;
  legalEntityName: string;
  gstin: string | null;
  invoiceSeriesPrefix: string;
}

export interface SyncOutcome {
  syncRunId: string;
  status: 'success' | 'partial' | 'failed';
  paymentsFetched: number;
  refundsFetched: number;
  errorCode: string | null;
  errorDetail: string | null;
}

export interface SyncRunSummary {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  paymentsFetched: number;
  refundsFetched: number;
  errorCode: string | null;
  errorDetail: string | null;
  windowFrom: string;
  windowTo: string;
}

export type EntityFilter = 'all' | 'gst' | 'non-gst';
export type MatchFilter = 'unmatched' | 'proposed' | 'matched';
export type MatchType = 'exact' | 'probable' | 'manual' | 'unmatched';

export interface QueuePayment {
  id: string;
  paidAt: string;
  amountPaise: number;
  customerName: string | null;
  referenceNumber: string | null;
  matchType: MatchType;
  matchedInvoiceRef: string | null;
  matchedClientId: string | null;
  matchConfirmedAt: string | null;
  account: {
    id: string;
    label: string;
    isGstRegistered: boolean;
    invoiceSeriesPrefix: string;
  };
}

export interface QueueResponse {
  items: QueuePayment[];
  counts: { unmatched: number; proposed: number; matched: number };
}

export interface BillingSlice {
  billingAccount: {
    id: string;
    label: string;
    isGstRegistered: boolean;
    legalEntityName: string;
  } | null;
  financialYear: string;
  paidThisFyPaise: number;
  paymentCountThisFy: number;
  lastPayment: {
    id: string;
    paidAt: string;
    amountPaise: number;
    matchedInvoiceRef: string | null;
  } | null;
  outstandingPaise: number | null;
  oldestOpenInvoice: null;
}


export interface CollectionsTile {
  amountPaise: number;
  count: number;
}

export interface CollectionsAccountRow {
  accountId: string;
  label: string;
  isGstRegistered: boolean;
  gstin: string | null;
  amountPaise: number;
  count: number;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
}

export interface CollectionsAggregate {
  period: { yearMonth: string; from: string; to: string };
  entity: EntityFilter;
  collected: CollectionsTile;
  matched: CollectionsTile;
  unmatched: CollectionsTile;
  refunded: CollectionsTile;
  accounts: CollectionsAccountRow[];
}

export const zpayApi = {
  list: () =>
    api.get<{ items: ZpayConnectionSummary[]; count: number }>('/api/zpay/connections'),
  create: (body: CreateConnectionInput) =>
    api.post<{ id: string; zohoOrgLabel: string; status: ZpayStatus; createdAt: string }>(
      '/api/zpay/connections',
      body,
    ),
  authorize: (id: string) =>
    api.post<AuthorizeResult>(`/api/zpay/connections/${id}/authorize`),
  createAccount: (connectionId: string, body: CreateAccountInput) =>
    api.post<ZpayAccountSummary>(`/api/zpay/connections/${connectionId}/accounts`, body),
  syncAccount: (connectionId: string, accountId: string) =>
    api.post<SyncOutcome>(
      `/api/zpay/connections/${connectionId}/accounts/${accountId}/sync`,
    ),
  listSyncRuns: (connectionId: string, accountId: string) =>
    api.get<{ items: SyncRunSummary[]; count: number }>(
      `/api/zpay/connections/${connectionId}/accounts/${accountId}/sync-runs`,
    ),
  collections: (period: string, entity: EntityFilter) => {
    const q = new URLSearchParams({ period, entity });
    return api.get<CollectionsAggregate>(`/api/zpay/collections?${q}`);
  },
  queue: (period: string, entity: EntityFilter, filter: MatchFilter) => {
    const q = new URLSearchParams({ period, entity, filter });
    return api.get<QueueResponse>(`/api/zpay/payments?${q}`);
  },
  matchPayment: (paymentId: string, body: { invoiceRef: string; clientId?: string }) =>
    api.post<{ paymentId: string; matchType: 'manual'; invoiceRef: string }>(
      `/api/zpay/payments/${paymentId}/match`,
      body,
    ),
  unmatchPayment: (paymentId: string) =>
    api.post<{ paymentId: string; matchType: 'unmatched' }>(
      `/api/zpay/payments/${paymentId}/unmatch`,
    ),
  billingSlice: (clientId: string) =>
    api.get<BillingSlice>(`/api/zpay/clients/${clientId}/billing-slice`),
  setBillingAccount: (clientId: string, accountId: string | null) =>
    api.patch<{ billingAccountId: string | null }>(
      `/api/zpay/clients/${clientId}/billing-account`,
      { accountId },
    ),
};
