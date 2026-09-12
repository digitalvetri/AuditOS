/**
 * Handoff configs for E-Invoice & E-Way Bill.
 *
 * The five operations named in the spec. Every one MENTIONS MFA and states
 * whose phone the OTP goes to — a stored password alone will not get anyone
 * into either portal since 1 April 2025. Guards are pure predicates against
 * the page context; when they return false, the handoff modal disables the
 * action and shows the reason.
 */
import type { EinvEwbApplicability, EinvEwbProfile, EwbAlertItem } from './types';

export type HandoffOperationId =
  | 'einv.irp.register'
  | 'einv.cancel'
  | 'ewb.api.enable'
  | 'ewb.extend'
  | 'ewb.cancel';

export interface HandoffContext {
  clientId: string;
  profile?: EinvEwbProfile;
  applicability?: EinvEwbApplicability;
  /** Alert item being acted upon, when relevant (e.g. an EWB being extended). */
  target?: EwbAlertItem;
  now?: Date;
}

export interface HandoffGuardResult {
  allowed: boolean;
  /** Present when disallowed — shown to the operator in place of the primary CTA. */
  reason?: string;
}

export interface CaptureField {
  key: string;
  label: string;
  type: 'text' | 'date';
  required?: boolean;
  hint?: string;
}

export interface HandoffConfig {
  operationId: HandoffOperationId;
  title: string;
  /** URL to open when the operator clicks the primary CTA. */
  targetUrl: (ctx: HandoffContext) => string;
  targetLabel: string;
  navPath: string[];
  preLogin: boolean;
  mfaNote: string;
  instructions: string[];
  guard?: (ctx: HandoffContext) => HandoffGuardResult;
  fields?: CaptureField[];
  capture?: CaptureField[];
}

/**
 * The IRP a client uses drives the URL for e-invoice actions. All six IRPs
 * are registered here so `einv.irp.register` and `einv.cancel` open the
 * right endpoint per client. See spec §3.1.
 */
const IRP_URL: Record<string, string> = {
  einvoice1: 'https://einvoice1.gst.gov.in/',
  einvoice2: 'https://einvoice2.gst.gov.in/',
  einvoice3: 'https://einvoice3.gst.gov.in/',
  einvoice4: 'https://einvoice4.gst.gov.in/',
  einvoice5: 'https://einvoice5.gst.gov.in/',
  einvoice6: 'https://einvoice6.gst.gov.in/',
};

const EWB_PORTAL = 'https://www.ewaybillgst.gov.in/Login.aspx';

const MFA_UNIVERSAL =
  'MFA has been mandatory on both portals since 1 April 2025. The OTP is sent to the CLIENT\'s registered mobile / Sandes / NIC-GST Shield — coordinate with them before starting.';

export const HANDOFF_CONFIGS: Record<HandoffOperationId, HandoffConfig> = {
  'einv.irp.register': {
    operationId: 'einv.irp.register',
    title: 'Register the client on the IRP',
    targetUrl: (ctx) => IRP_URL[ctx.profile?.irp ?? 'einvoice1'] ?? IRP_URL.einvoice1,
    targetLabel: 'Invoice Registration Portal',
    navPath: ['Registration', 'Portal Login'],
    preLogin: true,
    mfaNote: MFA_UNIVERSAL,
    guard: (ctx) => {
      if (!ctx.applicability?.applicable) return {
        allowed: false,
        reason: 'E-invoicing is not applicable to this client (AATO has not crossed the ₹5 Cr threshold in any FY since 2017-18 at PAN level).',
      };
      return { allowed: true };
    },
    instructions: [
      'Check enablement status first at einvoice1.gst.gov.in → Taxpayer Search.',
      'Registration requires only the GSTIN.',
      'OTP verification is done against the registered mobile and email.',
      'Six IRPs exist — pick the one this client uses; the URL above is set for their IRP.',
    ],
    capture: [
      { key: 'irp',           label: 'IRP used',      type: 'text', required: true, hint: 'e.g. einvoice1' },
      { key: 'registeredOn',  label: 'Registered on', type: 'date', required: true },
    ],
  },

  'einv.cancel': {
    operationId: 'einv.cancel',
    title: 'Cancel an IRN',
    targetUrl: (ctx) => IRP_URL[ctx.profile?.irp ?? 'einvoice1'] ?? IRP_URL.einvoice1,
    targetLabel: 'Invoice Registration Portal',
    navPath: ['E-invoice', 'Cancel'],
    preLogin: false,
    mfaNote: MFA_UNIVERSAL,
    // Cancellation is only permitted within 24 hours of IRN generation.
    guard: () => ({
      allowed: true, // real check requires the specific IRN's reportedAt — enforce in the caller.
    }),
    instructions: [
      'Cancellation is only permitted within 24 hours of IRN generation.',
      'After 24 hours the ONLY remedy is a credit note against the original invoice, reported in GSTR-1.',
      'Once an IRN is generated the invoice cannot be edited on the IRP at all.',
    ],
    fields: [
      { key: 'irn',           label: 'IRN to cancel', type: 'text', required: true },
      { key: 'reason',        label: 'Reason',        type: 'text', required: true },
    ],
    capture: [
      { key: 'cancelledOn',   label: 'Cancellation confirmed on', type: 'date', required: true },
    ],
  },

  'ewb.api.enable': {
    operationId: 'ewb.api.enable',
    title: 'Enable E-Way Bill API access (client-side action)',
    targetUrl: () => EWB_PORTAL,
    targetLabel: 'E-Way Bill Portal',
    navPath: ['Registration', 'For GSP', 'Add/New GSP'],
    preLogin: true,
    mfaNote: MFA_UNIVERSAL,
    instructions: [
      'The CLIENT must do this, logged in with their own credentials.',
      'Registration → For GSP → an OTP is sent to the registered mobile.',
      'Enter the OTP, then Add/New GSP.',
      'Select the GSP, then set a username and password.',
      'Send us that username and password — we use them to authenticate.',
    ],
    capture: [
      { key: 'apiUsername', label: 'API username', type: 'text', required: true },
      { key: 'gspName',     label: 'GSP selected', type: 'text', required: true },
      { key: 'enabledOn',   label: 'Date enabled', type: 'date', required: true },
    ],
  },

  'ewb.extend': {
    operationId: 'ewb.extend',
    title: 'Extend an E-Way Bill',
    targetUrl: () => EWB_PORTAL,
    targetLabel: 'E-Way Bill Portal',
    navPath: ['e-Waybill', 'Extend Validity'],
    preLogin: true,
    mfaNote: MFA_UNIVERSAL,
    guard: (ctx) => {
      const t = ctx.target;
      if (!t) return { allowed: true };
      // Past the 360-day cap: no remedy.
      if ((t.days_to_cap ?? 0) <= 0) return {
        allowed: false,
        reason: 'Past the 360-day extension cap. No extension possible — the goods need a fresh e-way bill against a fresh document (and the 180-day rule may block that too).',
      };
      // Outside the 8h-before / 8h-after window.
      const h = t.hours_to_expiry ?? 0;
      if (h > 8) return {
        allowed: false,
        reason: `Extension can only be raised 8 hours before expiry — currently ${Math.floor(h)} h away.`,
      };
      if (h < -8) return {
        allowed: false,
        reason: `Extension window closed — expired ${Math.abs(Math.ceil(h))} h ago.`,
      };
      return { allowed: true };
    },
    instructions: [
      'Extension is permitted 8 hours BEFORE expiry to 8 hours AFTER.',
      'Each extension issues a NEW e-way bill number — the original is chained via the "Original EWB No." field so the 360-day cap can still be tracked.',
      'Update the distance and Part B details before submitting.',
    ],
    fields: [
      { key: 'ewbNo',            label: 'Existing EWB No.',   type: 'text', required: true },
      { key: 'reason',           label: 'Reason for extension', type: 'text', required: true },
      { key: 'updatedDistance',  label: 'Updated distance (km)', type: 'text', required: true },
    ],
    capture: [
      { key: 'newEwbNo',   label: 'New e-way bill number', type: 'text', required: true },
      { key: 'newValidTo', label: 'New validity',          type: 'date', required: true },
    ],
  },

  'ewb.cancel': {
    operationId: 'ewb.cancel',
    title: 'Cancel an E-Way Bill',
    targetUrl: () => EWB_PORTAL,
    targetLabel: 'E-Way Bill Portal',
    navPath: ['e-Waybill', 'Cancel'],
    preLogin: true,
    mfaNote: MFA_UNIVERSAL,
    instructions: [
      'Cancellation is permitted only within the portal-permitted window (typically 24 hours of generation) and only if the goods have not moved.',
      'After cancellation the EWB No. cannot be re-used.',
    ],
    fields: [
      { key: 'ewbNo',  label: 'EWB No. to cancel', type: 'text', required: true },
      { key: 'reason', label: 'Reason',            type: 'text', required: true },
    ],
    capture: [
      { key: 'cancelledOn', label: 'Cancellation confirmed on', type: 'date', required: true },
    ],
  },
};
