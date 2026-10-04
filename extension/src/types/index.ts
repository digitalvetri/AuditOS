/** Shared types for the AuditOS portal autofill extension. */
export type PortalStatus = 'SUPPORTED' | 'PARTIAL' | 'NOT_SUPPORTED' | 'MAINTENANCE' | 'NOT_VERIFIED';

/**
 * What the CRM hands the extension for ONE tab. Bound to that tab for its
 * life: switching clients in the CRM never changes an already-open portal.
 * Holds a short-lived single-use token — never a password.
 */
export interface LaunchContext {
  launchToken: string;
  clientId: string;
  clientName: string;
  clientCode: string;
  registrationId: string;
  registrationName: string;
  portalId: string;
  portalName: string;
  status: PortalStatus;
  /** CRM origin the launch came from — the API is called there (/api/...). */
  crmOrigin: string;
  expiresAt: string;
  /** 'ready' until every fill this launch allows has been used. */
  state: 'ready' | 'filled' | 'failed';
  /** Fills already used: the login, and (GST, DGFT) the registration form — each once. */
  used?: FillPurpose[];
  lastError?: string;
}

export type FillPurpose = 'login' | 'registration';

/** CRM page → bridge → service worker. */
export interface LaunchMessage {
  type: 'AUDITOS_PORTAL_LAUNCH';
  payload: {
    launch_token: string;
    launch_url: string;
    expires_at: string;
    client: { id: string; name: string; code: string };
    registration_id: string;
    registration_name: string;
    portal_id: string;
    portal_name: string;
    status: PortalStatus;
  };
}

export type ContentState =
  | { kind: 'none' }                                   // no CRM context for this tab
  | { kind: 'expired' }
  | { kind: 'mismatch'; expected: string }             // context is for another portal
  | { kind: 'used' }
  | { kind: 'ready'; ctx: Omit<LaunchContext, 'launchToken'>; autoFill: boolean };

/** One login. `mobile` only for password-less portals (UDYAM: number + mobile, then OTP). */
export interface Credential {
  username: string; password: string; mobile?: string
  /** A registration form (GST New Registration, DGFT Register): saved first-time details, not a login. */
  details?: Record<string, string>
}

/** What the GST portal's New Registration form (Part A) asks for. */
export interface GstNewRegistrationDetails {
  applicant_type: string; state: string; district: string; legal_name: string; pan: string; email: string; mobile: string
}

/**
 * The Repotic Ecommerce GSTR-1 scope the AuditOS Ecommerce page is pointed
 * at — one client × GSTIN × period. Written to chrome.storage.local by
 * crm-bridge when the user picks a scope on the AuditOS Ecommerce page,
 * read by marketplace content scripts (sellercentral.amazon.in and later
 * Flipkart / Meesho / etc.) to pre-fill uploads.
 *
 * Only the scope — never a credential. The marketplace FAB uploads with
 * `credentials: 'include'` so AuditOS session cookies attach from the
 * crmOrigin automatically; nothing sensitive is persisted here.
 */
export interface EcommerceScope {
  clientId: string;
  clientName: string;
  gstin: string;
  period: string;        // YYYY-MM
  /** AuditOS origin to POST the upload to (defaults to the last set origin). */
  crmOrigin: string;
  updatedAt: string;     // ISO
}
