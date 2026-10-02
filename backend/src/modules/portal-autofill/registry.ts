/**
 * Government-portal registry for the CRM autofill extension (Phase 1).
 *
 * The identity of a credential is ALWAYS client + registration + portal.
 * Private Limited and LLP share the MCA portal (same domain) but are two
 * registrations with two separate credential records — never pick a
 * credential from the domain alone.
 *
 * `status` is honest: SUPPORTED — login page inspected and the fill tested live;
 * PARTIAL — page inspected (selectors known) but the login opens from a pop-up
 * or dialog, or the live fill was not tested by us (MCA, EPFO). Launch URLs are the official starting URLs the firm uses
 * (frontend/src/pages/workstation/registration/services.ts) — not login URLs.
 */
export type PortalStatus = 'SUPPORTED' | 'PARTIAL' | 'NOT_SUPPORTED' | 'MAINTENANCE' | 'NOT_VERIFIED'

export interface PortalConfig {
  registrationId: string
  /** The CRM's registration slug — also the RegistrationCredential.typeCode. */
  slug: string
  portalId: string
  name: string
  portalName: string
  launchUrl: string
  /** Hostnames (and their subdomains) a login page for this entry may be on. */
  allowedDomains: string[]
  status: PortalStatus
  /** Login has no password (UDYAM: number + mobile, then OTP). */
  passwordless?: boolean
}

export const PORTAL_REGISTRY: PortalConfig[] = [
  // Verified 02 Oct 2026 — login at services.gst.gov.in/services/login (#username, #user_pass).
  { registrationId: 'GST_REGISTRATION', slug: 'gst', portalId: 'GST', name: 'GST Registration', portalName: 'GST Portal — Government of India', launchUrl: 'https://www.gst.gov.in/', allowedDomains: ['gst.gov.in'], status: 'SUPPORTED' },
  // Inspected 02 Oct 2026 — FO login (fologin.html) is an Adobe AEM form: User ID
  // `…-guidetextbox___widget`, Password `…-guidepasswordbox___widget` in #guideContainerForm.
  { registrationId: 'PRIVATE_LIMITED', slug: 'private-limited', portalId: 'MCA', name: 'Private Limited Company Registration', portalName: 'MCA Portal — Ministry of Corporate Affairs', launchUrl: 'https://www.mca.gov.in/content/mca/global/en/home.html', allowedDomains: ['mca.gov.in'], status: 'PARTIAL' },
  { registrationId: 'LLP_REGISTRATION', slug: 'llp', portalId: 'MCA', name: 'LLP Registration', portalName: 'MCA Portal — Ministry of Corporate Affairs', launchUrl: 'https://www.mca.gov.in/content/mca/global/en/home.html', allowedDomains: ['mca.gov.in'], status: 'PARTIAL' },
  // Verified — a hidden #LoginForm on the home page (#username, #password) shown when the user opens login.
  { registrationId: 'PARTNERSHIP_FIRM', slug: 'partnership-firm', portalId: 'TNREGINET', name: 'Partnership Firm Registration', portalName: 'TNREGINET — Inspector General of Registration, Tamil Nadu', launchUrl: 'https://tnreginet.gov.in/portal/', allowedDomains: ['tnreginet.gov.in'], status: 'PARTIAL' },
  // Verified — Udyami Login has no password: Udyam number + mobile, then OTP (user).
  { registrationId: 'MSME_UDYAM', slug: 'msme-udyam', portalId: 'UDYAM', name: 'MSME UDYAM Registration', portalName: 'UDYAM Registration — Ministry of MSME', launchUrl: 'https://www.udyamregistration.gov.in/', allowedDomains: ['udyamregistration.gov.in'], status: 'PARTIAL', passwordless: true },
  // Verified — login at labour.tn.gov.in/services/users/login (#username, #password).
  { registrationId: 'SHOPS_ESTABLISHMENT', slug: 'shops-establishment', portalId: 'LABOUR_TN', name: 'Shops and Establishment Registration', portalName: 'Labour Department — Government of Tamil Nadu', launchUrl: 'https://labour.tn.gov.in/services/shop-establishments/registration', allowedDomains: ['labour.tn.gov.in'], status: 'SUPPORTED' },
  // Verified — login is a pop-up (#LoginForm: #username, #password, #txt_Captcha).
  { registrationId: 'IEC_REGISTRATION', slug: 'import-export-code', portalId: 'DGFT', name: 'Import Export Code Registration', portalName: 'DGFT — Ministry of Commerce and Industry', launchUrl: 'https://www.dgft.gov.in/CP/', allowedDomains: ['dgft.gov.in'], status: 'PARTIAL' },
  // Inspected 02 Oct 2026 — employer login at unifiedportal-emp.epfindia.gov.in/epfo/ (#AuthenticationForm: #username1, #password).
  { registrationId: 'PF_EPFO', slug: 'pf', portalId: 'EPFO', name: 'PF Registration', portalName: 'EPFO — Ministry of Labour & Employment', launchUrl: 'https://www.epfo.gov.in/', allowedDomains: ['epfo.gov.in', 'epfindia.gov.in'], status: 'PARTIAL' },
  // Verified — Employer Login at portal.esic.gov.in (#txtUserName, #txtPassword).
  { registrationId: 'ESI_ESIC', slug: 'esi', portalId: 'ESIC', name: 'ESI Registration', portalName: 'ESIC — Ministry of Labour & Employment', launchUrl: 'https://esic.gov.in/', allowedDomains: ['esic.gov.in'], status: 'SUPPORTED' },
  // Verified — "Login" goes to services.gst.gov.in/services/login?flag=einvoice (GST login page).
  { registrationId: 'E_INVOICE', slug: 'e-invoice', portalId: 'EINVOICE', name: 'E-Invoice Registration', portalName: 'E-Invoice Portal — Goods and Services Tax', launchUrl: 'https://einvoice.gst.gov.in/', allowedDomains: ['einvoice.gst.gov.in', 'services.gst.gov.in'], status: 'SUPPORTED' },
  // Verified — ewaybillgst.gov.in/Login.aspx (#txt_username, #txt_password).
  { registrationId: 'E_WAY_BILL', slug: 'e-way-bill', portalId: 'EWAYBILL', name: 'E-Way Bill Registration', portalName: 'E-Way Bill Portal — Goods and Services Tax', launchUrl: 'https://ewaybillgst.gov.in/', allowedDomains: ['ewaybillgst.gov.in'], status: 'SUPPORTED' },
  // Inspected 02 Oct 2026 — "Login" goes to eportal.incometax.gov.in/iec/foservices/#/login,
  // a two-step login: #panAdhaarUserId → Continue → password page (step 2 not inspected).
  { registrationId: 'INCOME_TAX_EFILING', slug: 'income-tax-efiling', portalId: 'ITD', name: 'Income Tax e-Filing Registration', portalName: 'Income Tax e-Filing Portal — Income Tax Department', launchUrl: 'https://www.incometax.gov.in/iec/foportal/', allowedDomains: ['incometax.gov.in'], status: 'PARTIAL' },
]

export const byRegistrationId = (id: string) => PORTAL_REGISTRY.find((p) => p.registrationId === id) ?? null

/** True when `host` is one of `domains` or a subdomain of one. */
export function hostAllowed(host: string, domains: string[]): boolean {
  const h = host.toLowerCase()
  return domains.some((d) => h === d || h.endsWith(`.${d}`))
}
