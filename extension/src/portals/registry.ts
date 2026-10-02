/**
 * Portal registry (extension side). Mirrors the backend registry
 * (backend/src/modules/portal-autofill/registry.ts). Identity of a
 * credential is client + registration + portal — the domain alone never
 * selects a credential (MCA hosts both PRIVATE_LIMITED and LLP_REGISTRATION).
 *
 * Every portal's login page was inspected (02 Oct 2026) and has exact
 * selectors. SUPPORTED = fill also tested live; PARTIAL = login sits in a
 * pop-up / dialog, or the live fill was not tested by us (MCA, EPFO).
 * Every portal responds by itself once its login form appears.
 */
import type { PortalStatus } from '../types';

export interface PortalEntry {
  portalId: string;
  registrationIds: string[];
  name: string;
  launchUrls: string[];
  domains: string[];
  status: PortalStatus;
}

export const REGISTRY: PortalEntry[] = [
  // Statuses from inspecting each real login page on 02 Oct 2026 (see adapters).
  { portalId: 'GST', registrationIds: ['GST_REGISTRATION'], name: 'GST Portal', launchUrls: ['https://www.gst.gov.in/'], domains: ['gst.gov.in'], status: 'SUPPORTED' },
  { portalId: 'MCA', registrationIds: ['PRIVATE_LIMITED', 'LLP_REGISTRATION'], name: 'MCA Portal', launchUrls: ['https://www.mca.gov.in/content/mca/global/en/home.html'], domains: ['mca.gov.in'], status: 'PARTIAL' },
  { portalId: 'TNREGINET', registrationIds: ['PARTNERSHIP_FIRM'], name: 'TNREGINET', launchUrls: ['https://tnreginet.gov.in/portal/'], domains: ['tnreginet.gov.in'], status: 'PARTIAL' },
  { portalId: 'UDYAM', registrationIds: ['MSME_UDYAM'], name: 'UDYAM Registration', launchUrls: ['https://www.udyamregistration.gov.in/'], domains: ['udyamregistration.gov.in'], status: 'PARTIAL' },
  { portalId: 'LABOUR_TN', registrationIds: ['SHOPS_ESTABLISHMENT'], name: 'Labour Department TN', launchUrls: ['https://labour.tn.gov.in/services/shop-establishments/registration'], domains: ['labour.tn.gov.in'], status: 'SUPPORTED' },
  { portalId: 'DGFT', registrationIds: ['IEC_REGISTRATION'], name: 'DGFT', launchUrls: ['https://www.dgft.gov.in/CP/'], domains: ['dgft.gov.in'], status: 'PARTIAL' },
  { portalId: 'EPFO', registrationIds: ['PF_EPFO'], name: 'EPFO', launchUrls: ['https://www.epfo.gov.in/'], domains: ['epfo.gov.in', 'epfindia.gov.in'], status: 'PARTIAL' },
  { portalId: 'ESIC', registrationIds: ['ESI_ESIC'], name: 'ESIC', launchUrls: ['https://esic.gov.in/'], domains: ['esic.gov.in'], status: 'SUPPORTED' },
  { portalId: 'EINVOICE', registrationIds: ['E_INVOICE'], name: 'E-Invoice Portal', launchUrls: ['https://einvoice.gst.gov.in/'], domains: ['einvoice.gst.gov.in', 'services.gst.gov.in'], status: 'SUPPORTED' },
  { portalId: 'EWAYBILL', registrationIds: ['E_WAY_BILL'], name: 'E-Way Bill Portal', launchUrls: ['https://ewaybillgst.gov.in/'], domains: ['ewaybillgst.gov.in'], status: 'SUPPORTED' },
  { portalId: 'ITD', registrationIds: ['INCOME_TAX_EFILING'], name: 'Income Tax e-Filing Portal', launchUrls: ['https://www.incometax.gov.in/iec/foportal/'], domains: ['incometax.gov.in'], status: 'PARTIAL' },
];

export const entryFor = (portalId: string) => REGISTRY.find((e) => e.portalId === portalId) ?? null;

export function hostAllowed(host: string, domains: string[]): boolean {
  const h = host.toLowerCase();
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Is `url` a page this portal's login may be on? https on an allowed domain
 * (after any redirect — the final page is what counts).
 */
export function pageBelongsTo(url: URL, portalId: string): boolean {
  const e = entryFor(portalId);
  return !!e && url.protocol === 'https:' && hostAllowed(url.hostname, e.domains);
}
