/**
 * Registration service catalogue — Workstation → Services → Registration.
 *
 * Single source of truth for the twelve registrations the firm files for its
 * clients, mirroring the shape gst/services.ts uses so both categories read
 * and behave the same way.
 *
 * NAV STRUCTURE ONLY. Nothing here files anything or talks to a portal. The
 * links open the official site in a new tab; the employee does the work there
 * and brings the result back.
 *
 * PORTAL LINKS — the exact destinations the firm uses, supplied by the firm.
 * Do not "tidy" these back to bare domains: several are deep links to the
 * form itself rather than the site root, which is where the employee needs
 * to land.
 *   gst.gov.in .................. "Goods and Services Tax, Government of India,
 *                                 States and Union Territories"
 *   mca.gov.in .................. Ministry of Corporate Affairs; SPICe+ and
 *                                 FiLLiP are its own incorporation forms
 *   tnreginet.gov.in ............ Inspector General of Registration, Tamil Nadu
 *   udyamregistration.gov.in .... "official website of Govt. of India,
 *                                 Ministry of MSME"
 *   labour.tn.gov.in ............ Labour Department, Government of Tamil Nadu
 *   dgft.gov.in ................. "belongs to Directorate General of Foreign
 *                                 Trade, Ministry of Commerce and Industry"
 *   epfo.gov.in ................. EPFO, Ministry of Labour & Employment
 *   esic.gov.in ................. ESIC, Ministry of Labour & Employment
 *   einvoice.gst.gov.in ......... e-invoice portal (enablement status and the
 *                                 choice of IRP); the six IRPs themselves are
 *                                 einvoice1..6.gst.gov.in, held separately in
 *                                 einvoice-ewb/handoffs.ts
 *   ewaybillgst.gov.in .......... e-way bill portal, NIC
 *
 * PROPRIETORSHIP still has no registry — India keeps no proprietorship
 * register and there is no certificate of proprietorship. Its link points at
 * the GST portal because that is where the identity is actually established;
 * its portalLabel says so, so the row never reads as a registry that exists.
 */
import {
  Building2,
  Factory,
  Handshake,
  HeartPulse,
  Landmark,
  QrCode,
  ReceiptIndianRupee,
  Ship,
  Truck,
  Store,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react';

/**
 * What kind of thing the registration brings into being. Drives the tint on
 * the card chip, so the grid groups visually without needing sections.
 */
export type RegistrationKind = 'tax' | 'entity' | 'licence' | 'labour';

/**
 * Whose portal it is. Tamil Nadu registrations go to a state department; the
 * rest are central. `none` is retained for a registration that genuinely has
 * nowhere to go — nothing uses it today, since Proprietorship now points at
 * the GST portal.
 */
export type PortalScope = 'tamil-nadu' | 'india' | 'none';

export interface RegistrationService {
  slug: string;
  name: string;
  /** Short name for tight spaces — the sidebar and mobile rail. */
  shortName: string;
  kind: RegistrationKind;
  icon: LucideIcon;
  /** The statute or department the registration is made under. */
  authority: string;
  /** The form or certificate the client ends up holding. */
  form: string;
  summary: string;
  /** Long-form description shown on the detail page. */
  description: string;
  portalScope: PortalScope;
  /**
   * The official portal, exactly as the firm supplied it — see the header
   * note. Null is still permitted for a registration with nowhere to go, and
   * the detail page and run panel both handle it.
   */
  portalUrl: string | null;
  portalLabel: string;
  /** What the employee uploads back once the portal work is done. */
  outputDocument: string;
}

/** Chip tints, drawn from the platform palette — no new colours. */
export const KIND_TINT: Record<RegistrationKind, { bg: string; fg: string; label: string }> = {
  tax:     { bg: 'rgb(38 100 231 / 0.10)',  fg: 'rgb(29 84 199)',   label: 'Tax' },
  entity:  { bg: 'rgb(15 34 73 / 0.10)',    fg: 'rgb(15 34 73)',    label: 'Entity' },
  licence: { bg: 'rgb(200 149 46 / 0.14)',  fg: 'rgb(146 106 24)',  label: 'Licence' },
  labour:  { bg: 'rgb(79 107 82 / 0.14)',   fg: 'rgb(58 82 61)',    label: 'Labour' },
};

/**
 * Order is the order the firm is asked for them, not alphabetical: GST first
 * because it is the most requested, then the entity formations from most to
 * least formal, then the licences, then the two labour registrations that
 * only apply once a headcount threshold is crossed.
 */
export const REGISTRATION_SERVICES: RegistrationService[] = [
  {
    slug: 'gst',
    name: 'GST Registration',
    shortName: 'GST',
    kind: 'tax',
    icon: ReceiptIndianRupee,
    authority: 'CGST Act, 2017',
    form: 'REG-01 → GSTIN',
    summary:
      'Registers the client for Goods and Services Tax and obtains the 15-digit GSTIN against the PAN and principal place of business.',
    description:
      'The client is registered under the CGST/SGST Acts and issued a 15-digit GSTIN keyed to their PAN and state. Registration is compulsory past the turnover threshold, and immediately for inter-state supply, e-commerce operators and most reverse-charge cases. The application is REG-01; the department may raise a query in REG-03, which must be answered in REG-04 before the certificate issues.',
    portalScope: 'india',
    portalUrl: 'https://www.gst.gov.in/',
    portalLabel: 'GST Portal · Government of India',
    outputDocument: 'GST Registration Certificate (REG-06)',

  },
  {
    slug: 'private-limited',
    name: 'Private Limited Company Registration',
    shortName: 'Private Limited',
    kind: 'entity',
    icon: Building2,
    authority: 'MCA · Companies Act, 2013',
    form: 'SPICe+ → CoI',
    summary:
      'Incorporates a private limited company — name approval, DSC and DIN for the directors, and the Certificate of Incorporation with PAN and TAN.',
    description:
      'A private limited company is incorporated through SPICe+ on the MCA portal. Part A reserves the name; Part B carries incorporation, DIN for the directors, PAN, TAN, EPFO and ESIC registration, professional tax where it applies, and the bank account opening request. Each subscriber and director needs a DSC before filing. The Registrar issues the Certificate of Incorporation with the CIN.',
    portalScope: 'india',
    portalUrl: 'https://www.mca.gov.in/content/mca/global/en/home.html',
    portalLabel: 'MCA Portal · Ministry of Corporate Affairs',
    outputDocument: 'Certificate of Incorporation (with PAN and TAN)',

  },
  {
    slug: 'llp',
    name: 'LLP Registration',
    shortName: 'LLP',
    kind: 'entity',
    icon: Users,
    authority: 'MCA · LLP Act, 2008',
    form: 'FiLLiP → CoI',
    summary:
      'Incorporates a Limited Liability Partnership, including DPIN for the designated partners and the LLP agreement filed in Form 3.',
    description:
      'A Limited Liability Partnership is incorporated through FiLLiP on the MCA portal, which also allots DPIN to the designated partners. The LLP agreement is filed separately in Form 3 within thirty days of incorporation — miss that window and the LLP carries a default from the day it was formed.',
    portalScope: 'india',
    portalUrl: 'https://www.mca.gov.in/content/mca/global/en/mca/llp-e-filling.html',
    portalLabel: 'MCA Portal · Ministry of Corporate Affairs',
    outputDocument: 'LLP Certificate of Incorporation',

  },
  {
    slug: 'partnership-firm',
    name: 'Partnership Firm Registration',
    shortName: 'Partnership',
    kind: 'entity',
    icon: Handshake,
    authority: 'Registrar of Firms · Partnership Act, 1932',
    form: 'Form A → Certificate',
    summary:
      'Drafts and stamps the partnership deed and registers the firm with the state Registrar of Firms.',
    description:
      'A partnership is constituted by its deed; registering it with the Registrar of Firms is optional in law but practically necessary, because an unregistered firm cannot sue to enforce a contract. In Tamil Nadu the application is made to the Registrar of Firms through the Registration Department, with the stamped deed and the prescribed Form A.',
    portalScope: 'tamil-nadu',
    portalUrl: 'https://tnreginet.gov.in/portal/',
    portalLabel: 'TNREGINET · Inspector General of Registration, Tamil Nadu',
    outputDocument: 'Certificate of Registration of Firm',

  },
  {
    slug: 'proprietorship',
    name: 'Proprietorship Registration',
    shortName: 'Proprietorship',
    kind: 'entity',
    icon: UserRound,
    authority: 'No separate statute',
    form: 'Via GST / UDYAM / bank',
    summary:
      'Establishes a sole proprietorship. There is no single registry, so identity is evidenced through GST, UDYAM and a current account in the trade name.',
    description:
      'A sole proprietorship is not a separate legal person, and there is no proprietorship register anywhere in India — no proprietorship portal and no certificate of proprietorship. Existence is evidenced instead by whatever the proprietor holds in the trade name: a GST registration, a UDYAM certificate, a Shops and Establishment licence, and a current account. The portal link here therefore goes to GST, which is the usual way the identity is established. Anyone offering a \'proprietorship registration certificate\' is selling one of those under another name.',
    portalScope: 'india',
    portalUrl: 'https://www.gst.gov.in/',
    portalLabel: 'GST Portal · Government of India (no proprietorship registry exists)',
    outputDocument: 'GST certificate / UDYAM certificate / bank proof',

  },
  {
    slug: 'msme-udyam',
    name: 'MSME UDYAM Registration',
    shortName: 'MSME UDYAM',
    kind: 'licence',
    icon: Factory,
    authority: 'Ministry of MSME',
    form: 'UDYAM certificate',
    summary:
      'Registers the enterprise as a micro, small or medium unit against Aadhaar and PAN, unlocking priority lending and delayed-payment protection.',
    description:
      'Registers the enterprise as micro, small or medium against the proprietor\'s or firm\'s Aadhaar and PAN. It is free and self-declared on the government portal — investment and turnover are pulled from linked PAN and GST data rather than typed in. The certificate unlocks priority-sector lending, the 45-day delayed-payment protection under the MSMED Act, and preference in public procurement.',
    portalScope: 'india',
    portalUrl: 'https://www.udyamregistration.gov.in/UdyamRegistration.aspx',
    portalLabel: 'UDYAM Registration · Ministry of MSME',
    outputDocument: 'UDYAM Registration Certificate',

  },
  {
    slug: 'shops-establishment',
    name: 'Shops and Establishment Registration',
    shortName: 'Shops & Estab.',
    kind: 'licence',
    icon: Store,
    authority: 'State Labour Department',
    form: 'State licence',
    summary:
      'Registers the premises under the applicable state Shops and Establishments Act. Rules, fees and renewal cycles differ by state.',
    description:
      'Registration of the premises under the Tamil Nadu Shops and Establishments Act, 1947, made to the Labour Department. It applies to shops and commercial establishments and governs working hours, weekly holidays, leave and employment of young persons. The registration is per premises, so a client with three branches needs three, and it is renewed on the state\'s own cycle.',
    portalScope: 'tamil-nadu',
    portalUrl: 'https://labour.tn.gov.in/services/shop-establishments/registration',
    portalLabel: 'Labour Department · Government of Tamil Nadu',
    outputDocument: 'Shops and Establishment Registration Certificate',

  },
  {
    slug: 'import-export-code',
    name: 'Import Export Code Registration',
    shortName: 'IEC',
    kind: 'licence',
    icon: Ship,
    authority: 'DGFT · Ministry of Commerce',
    form: 'ANF-2A → IEC',
    summary:
      'Obtains the ten-digit Import Export Code required before any consignment can be cleared in or out of India.',
    description:
      'The ten-digit Import Export Code issued by the DGFT, without which no consignment clears customs in either direction. It is PAN-based — one IEC per PAN — and applied for on the DGFT portal with the firm\'s bank details and a cancelled cheque. Since 2021 an IEC must be confirmed or updated every year between April and June, or it is deactivated.',
    portalScope: 'india',
    portalUrl: 'https://www.dgft.gov.in/CP/',
    portalLabel: 'DGFT · Ministry of Commerce and Industry',
    outputDocument: 'IEC Certificate',

  },
  {
    slug: 'pf',
    name: 'PF Registration',
    shortName: 'PF',
    kind: 'labour',
    icon: Landmark,
    authority: 'EPFO · EPF Act, 1952',
    form: 'Shram Suvidha → Code',
    summary:
      'Registers the establishment with the EPFO for Provident Fund. Mandatory once the client employs twenty or more people.',
    description:
      'Registers the establishment with the Employees\' Provident Fund Organisation and allots a PF establishment code. Compulsory once twenty or more people are employed, and available voluntarily below that. Registration is made through the EPFO employer portal or the Shram Suvidha common form; a company incorporated through SPICe+ is registered at incorporation and does not need a second application.',
    portalScope: 'india',
    portalUrl: 'https://www.epfo.gov.in/',
    portalLabel: 'EPFO · Ministry of Labour & Employment',
    outputDocument: 'PF Establishment Code / Registration Certificate',

  },
  {
    slug: 'esi',
    name: 'ESI Registration',
    shortName: 'ESI',
    kind: 'labour',
    icon: HeartPulse,
    authority: 'ESIC · ESI Act, 1948',
    form: 'Form 01 → Code',
    summary:
      'Registers the establishment with the ESIC for employees’ state insurance, generally once ten or more employees are on the rolls.',
    description:
      'Registers the establishment with the Employees\' State Insurance Corporation for medical and cash benefits. It generally applies once ten or more employees are on the rolls, for those below the wage ceiling. Registration is made on the ESIC portal or through Shram Suvidha, and a company incorporated through SPICe+ is registered at incorporation.',
    portalScope: 'india',
    portalUrl: 'https://esic.gov.in/',
    portalLabel: 'ESIC · Ministry of Labour & Employment',
    outputDocument: 'ESI Registration Certificate (Form C-11)',
  },
  {
    slug: 'e-invoice',
    name: 'E-Invoice Registration',
    shortName: 'E-Invoice',
    kind: 'tax',
    icon: QrCode,
    authority: 'GSTN / NIC · Rule 48(4), CGST Rules',
    form: 'Enablement → IRP credentials',
    summary:
      'Confirms the client is enabled for e-invoicing on the GST e-invoice portal and registers them on an Invoice Registration Portal so their ERP can obtain IRNs.',
    description:
      'E-invoicing is not a certificate the client receives once and files away: it is an enablement flag against the GSTIN, plus credentials on whichever Invoice Registration Portal the client reports through. The e-invoice portal is where the enablement status is checked and the IRP is chosen; the six IRPs (einvoice1 through einvoice6) are where the client actually registers and generates IRNs from their own ERP. Audit OS does not generate IRNs — see Workstation → Services → E-Invoice for the monitoring view that watches the 30-day reporting limit once the client is live.',
    portalScope: 'india',
    portalUrl: 'https://einvoice.gst.gov.in/',
    portalLabel: 'E-Invoice Portal · Goods and Services Tax',
    outputDocument: 'E-Invoice enablement confirmation / IRP credentials',
  },
  {
    slug: 'e-way-bill',
    name: 'E-Way Bill Registration',
    shortName: 'E-Way Bill',
    kind: 'tax',
    icon: Truck,
    authority: 'NIC · Rule 138, CGST Rules',
    form: 'Registration → EWB login',
    summary:
      'Registers the client on the e-way bill portal so consignments above the threshold can be covered, and enables API access where the client generates from their own ERP.',
    description:
      'A registered person moving goods above the notified consignment value needs an e-way bill, which means a login on the NIC e-way bill portal. Transporters who are not otherwise registered enrol here for a TRANSIN instead. API access is a separate request made from inside the portal once the login exists, and is what lets the client\'s ERP generate e-way bills directly. MFA has been mandatory since 1 April 2025, so the OTP reaches the client, not us. Audit OS does not generate e-way bills — see Workstation → Services → E-Way Bill for the monitoring view.',
    portalScope: 'india',
    portalUrl: 'https://ewaybillgst.gov.in/',
    portalLabel: 'E-Way Bill Portal · Goods and Services Tax',
    outputDocument: 'E-Way Bill portal credentials / API access confirmation',

  },
];

/** Lookup used by the detail route so an unknown slug can 404 cleanly. */
export function registrationBySlug(slug: string | undefined): RegistrationService | undefined {
  return REGISTRATION_SERVICES.find((s) => s.slug === slug);
}
