/**
 * Government-portal autofill (Phase 1) — CRM side.
 *
 * openGovernmentPortal({ clientId, portalId, registrationId }) asks the
 * backend for a short-lived launch token and hands it to the AuditOS Chrome
 * extension, which opens the official portal in a new tab bound to THIS
 * client + registration and fills the login there. Nothing secret goes in a
 * URL. Without the extension, the portal simply opens with no autofill.
 *
 * Remove this folder (and its two uses) to drop the feature from the CRM.
 */
import { useEffect, useState } from 'react';
import { api } from '@/services/api';

export type PortalStatus = 'SUPPORTED' | 'PARTIAL' | 'NOT_SUPPORTED' | 'MAINTENANCE' | 'NOT_VERIFIED';

/** CRM registration slug → autofill registration + portal (mirrors the backend registry). */
export const PORTALS: { slug: string; registrationId: string; portalId: string; label: string; launchUrl: string }[] = [
  { slug: 'gst', registrationId: 'GST_REGISTRATION', portalId: 'GST', label: 'GST', launchUrl: 'https://www.gst.gov.in/' },
  { slug: 'private-limited', registrationId: 'PRIVATE_LIMITED', portalId: 'MCA', label: 'Private Limited', launchUrl: 'https://www.mca.gov.in/content/mca/global/en/home.html' },
  { slug: 'llp', registrationId: 'LLP_REGISTRATION', portalId: 'MCA', label: 'LLP', launchUrl: 'https://www.mca.gov.in/content/mca/global/en/home.html' },
  { slug: 'partnership-firm', registrationId: 'PARTNERSHIP_FIRM', portalId: 'TNREGINET', label: 'Partnership Firm', launchUrl: 'https://tnreginet.gov.in/portal/' },
  { slug: 'msme-udyam', registrationId: 'MSME_UDYAM', portalId: 'UDYAM', label: 'MSME UDYAM', launchUrl: 'https://www.udyamregistration.gov.in/' },
  { slug: 'shops-establishment', registrationId: 'SHOPS_ESTABLISHMENT', portalId: 'LABOUR_TN', label: 'Shops & Establishment', launchUrl: 'https://labour.tn.gov.in/services/shop-establishments/registration' },
  { slug: 'import-export-code', registrationId: 'IEC_REGISTRATION', portalId: 'DGFT', label: 'Import Export Code', launchUrl: 'https://www.dgft.gov.in/CP/' },
  { slug: 'pf', registrationId: 'PF_EPFO', portalId: 'EPFO', label: 'PF', launchUrl: 'https://www.epfo.gov.in/' },
  { slug: 'esi', registrationId: 'ESI_ESIC', portalId: 'ESIC', label: 'ESI', launchUrl: 'https://esic.gov.in/' },
  { slug: 'e-invoice', registrationId: 'E_INVOICE', portalId: 'EINVOICE', label: 'E-Invoice', launchUrl: 'https://einvoice.gst.gov.in/' },
  { slug: 'e-way-bill', registrationId: 'E_WAY_BILL', portalId: 'EWAYBILL', label: 'E-Way Bill', launchUrl: 'https://ewaybillgst.gov.in/' },
  { slug: 'income-tax-efiling', registrationId: 'INCOME_TAX_EFILING', portalId: 'ITD', label: 'Income Tax e-Filing', launchUrl: 'https://www.incometax.gov.in/iec/foportal/' },
];
export const portalForSlug = (slug: string) => PORTALS.find((p) => p.slug === slug) ?? null;

interface LaunchResponse {
  launch_token: string; launch_url: string; expires_at: string;
  client: { id: string; name: string; code: string };
  registration_id: string; registration_name: string; portal_id: string; portal_name: string;
  status: PortalStatus; credential_ready: boolean;
}

/** Is the AuditOS extension installed in this browser? (It announces itself.) */
export function useAutofillExtension(): boolean {
  const [present, setPresent] = useState(false);
  useEffect(() => {
    const on = (ev: MessageEvent) => {
      if (ev.source === window && ev.origin === window.location.origin && ev.data?.source === 'auditos-extension' && ev.data.type === 'AUDITOS_EXTENSION_READY') setPresent(true);
    };
    window.addEventListener('message', on);
    window.postMessage({ source: 'auditos-crm', type: 'AUDITOS_PING' }, window.location.origin);
    return () => window.removeEventListener('message', on);
  }, []);
  return present;
}

export type LaunchOutcome =
  | { kind: 'autofill'; credentialReady: boolean; status: PortalStatus; clientName: string; registrationName: string }
  | { kind: 'plain' }                         // no extension: portal opened without autofill
  | { kind: 'error'; message: string };

/** The common CRM action behind every registration button. */
export async function openGovernmentPortal(o: { clientId: string; portalId: string; registrationId: string; extension: boolean }): Promise<LaunchOutcome> {
  const entry = PORTALS.find((p) => p.registrationId === o.registrationId);
  if (!entry || entry.portalId !== o.portalId) return { kind: 'error', message: 'This portal is not configured.' };
  if (!o.extension) {
    window.open(entry.launchUrl, '_blank', 'noopener,noreferrer');
    return { kind: 'plain' };
  }
  let r: LaunchResponse;
  try {
    r = await api.post<LaunchResponse>('/api/portal-autofill/launch', { client_id: o.clientId, portal_id: o.portalId, registration_id: o.registrationId });
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : 'Could not start the portal launch.' };
  }
  const requestId = crypto.randomUUID();
  const result = await new Promise<{ ok: boolean; error: string | null }>((resolve) => {
    const t = setTimeout(() => { window.removeEventListener('message', on); resolve({ ok: false, error: 'The extension did not respond.' }); }, 4000);
    function on(ev: MessageEvent) {
      if (ev.source !== window || ev.data?.source !== 'auditos-extension' || ev.data.type !== 'AUDITOS_PORTAL_LAUNCH_RESULT' || ev.data.requestId !== requestId) return;
      clearTimeout(t); window.removeEventListener('message', on); resolve({ ok: ev.data.ok, error: ev.data.error });
    }
    window.addEventListener('message', on);
    window.postMessage({ source: 'auditos-crm', type: 'AUDITOS_PORTAL_LAUNCH', requestId, payload: r }, window.location.origin);
  });
  if (!result.ok) return { kind: 'error', message: result.error ?? 'The extension could not open the portal.' };
  return { kind: 'autofill', credentialReady: r.credential_ready, status: r.status, clientName: r.client.name, registrationName: r.registration_name };
}

