/**
 * E-Invoice & E-Way Bill page types.
 *
 * Mirrors the server envelope from
 * `GET /api/clients/:id/einvoice-ewb`.
 */

export interface EinvEwbClient {
  id: string;
  client_code: string;
  company_name: string;
  gstin: string | null;
  pan: string | null;
}

export interface EinvEwbProfile {
  exists: boolean;
  irp: string | null;
  irp_registered_on: string | null;
  einvoice_api_route: string;
  ewb_api_enabled: boolean;
  ewb_api_username: string | null;
  ewb_gsp: string | null;
  ewb_verified_at: string | null;
  mfa_active: boolean;
  reconciled_through: string | null;
  aato_by_year: { fy: string; aato_paise: string }[];
  created_at?: string | null;
  updated_at?: string | null;
}

export interface EinvEwbApplicability {
  applicable: boolean;
  applicable_since_fy: string | null;
  thirty_day_applies: boolean;
  direct_api_eligible: boolean;
  thresholds: {
    aatoPaise: string;
    thirtyDayPaise: string;
    directApiPaise: string;
    scanFromFy: string;
    thirtyDayEffectiveFrom: string;
  };
}

export interface AlertBucket<T> {
  code: string;
  count: number;
  items: T[];
  windowLabel: string;
  actionable: boolean;
  status: 'attention' | 'problem' | 'awaiting' | 'ok';
}

export interface IrnAlertItem {
  irn_id: string;
  document_no: string;
  document_date: string;
  document_type: string;
  total_value_paise: number;
  days_since_document: number;
  days_left: number;
}

export interface EwbAlertItem {
  ewb_id: string;
  ewb_no: string;
  original_ewb_no: string;
  document_no: string;
  document_date: string;
  generated_at: string;
  original_generated_at: string;
  expires_at: string | null;
  hours_to_expiry: number | null;
  days_to_cap: number | null;
  status: string;
  value_paise: number;
}

export interface MissingIrnItem {
  document_no: string;
  document_date: string;
  buyer_gstin: string | null;
  total_value_paise: number;
}

/**
 * Monitor counts. Each half is OPTIONAL because `GET ...?mode=` omits the half
 * that was not asked for — the server skips that query rather than returning a
 * zero that could not be told apart from a real one. Read a half only after
 * checking it is there.
 */
export interface EinvEwbMonitors {
  einvoice?: {
    reported_this_month: number;
    cancelled_total: number;
    cancelled_within_window: number;
    reconciled_through: string | null;
  };
  ewb?: {
    generated_this_month: number;
    cancelled_or_rejected: number;
    reconciled_through: string | null;
  };
}

export interface EinvEwbSetup {
  /** E-Invoice screen only. */
  irp_registration?: { state: 'ready' | 'pending' | 'attention'; label: string };
  /** E-Way Bill screen only. */
  ewb_api_access?:   { state: 'ready' | 'pending' | 'attention'; label: string };
  /** Both screens: MFA guards the portal login behind either obligation. */
  mfa:               { state: 'ready' | 'pending' | 'attention'; label: string };
}

export interface EinvEwbPullRunItem {
  kind: 'ewb' | 'einvoice';
  period_month: string;
  run_at: string;
  record_count: number;
  source: 'scheduled' | 'manual';
  status: string;
}

/** Which half the server was asked for, echoed back on the response. */
export type EinvEwbMode = 'einvoice' | 'ewb' | 'both';

export interface EinvEwbResponse {
  mode: EinvEwbMode;
  client: EinvEwbClient;
  current_fy: string;
  today: string;
  profile: EinvEwbProfile;
  applicability: EinvEwbApplicability;
  // Optional for the same reason as the monitors above: only the requested
  // half's buckets are present.
  alerts: {
    einvoice_30day_countdown?: AlertBucket<IrnAlertItem>;
    b2b_invoices_without_irn?: AlertBucket<MissingIrnItem>;
    ewb_expiring_24h?: AlertBucket<EwbAlertItem>;
    ewb_approaching_360_cap?: AlertBucket<EwbAlertItem>;
  };
  monitors: EinvEwbMonitors;
  setup: EinvEwbSetup;
  pulls: { items: EinvEwbPullRunItem[] };
  connection: { status: string; is_simulated: boolean; notice: string };
}
