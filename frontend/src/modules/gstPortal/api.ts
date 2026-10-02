/**
 * GST portal access client — GST-RETURNS-CASE-SCREEN §9-5. Fetches the
 * masked record, upserts it, and reveals one password field at a time
 * (each reveal writes an audit row server-side).
 *
 * `PortalRecord` never carries a plaintext password. `portal_password_present`
 * is a boolean the server sets on GET so the UI knows whether a Reveal
 * button should be enabled.
 */
import { api } from '@/services/api';

export interface PortalRecord {
  portal_username: string | null;
  portal_password_present: boolean;
  password_held_by: 'firm' | 'client';
  registered_mobile_masked: string | null;
  otp_contact_name: string | null;
  otp_contact_number: string | null;      // ALREADY masked by the server
  otp_contact_number_masked: boolean;      // false when no number is stored
  mfa_method: 'otp_mobile' | 'authenticator' | 'none';
  ewb_username: string | null;
  ewb_password_present: boolean;
  irp_name: string | null;
  irp_username: string | null;
  irp_password_present: boolean;
  last_verified_at: string | null;
  last_verified_by_employee_id: string | null;
}

export type PasswordField = 'portal_password' | 'ewb_password' | 'irp_password';
export type AccessAction = 'show' | 'copy';

export const gstPortalApi = {
  get: (gstProfileId: string) =>
    api.get<{ record: PortalRecord | null }>(`/api/gst-portal/${gstProfileId}`),
  save: (gstProfileId: string, input: Partial<{
    portal_username: string | null;
    portal_password: string | null;
    password_held_by: 'firm' | 'client';
    registered_mobile: string | null;
    otp_contact_name: string | null;
    otp_contact_number: string | null;
    mfa_method: 'otp_mobile' | 'authenticator' | 'none';
    ewb_username: string | null;
    ewb_password: string | null;
    irp_name: string | null;
    irp_username: string | null;
    irp_password: string | null;
  }>) => api.put<{ record: PortalRecord }>(`/api/gst-portal/${gstProfileId}`, input),
  /** Reveal a password field. `action` distinguishes "operator looked at
   *  it" from "operator put it on the clipboard" in the audit trail. */
  reveal: (gstProfileId: string, field: PasswordField, action: AccessAction = 'show') =>
    api.post<{ field: PasswordField; action: AccessAction; value: string | null }>(
      `/api/gst-portal/${gstProfileId}/reveal`, { field, action },
    ),
  /** Log a username access. Usernames aren't secret, but the PortalPanel
   *  audit-every-copy contract lives here. `.view` scope, no decryption. */
  logAccess: (gstProfileId: string, input: { field: 'portal_username'; action: AccessAction }) =>
    api.post<{ field: string; action: AccessAction; logged: true }>(
      `/api/gst-portal/${gstProfileId}/log-access`, input,
    ),
};
