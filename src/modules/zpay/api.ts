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
};
