/**
 * THE DOCUMENT REGISTRY — thirteen types, one editor.
 *
 * A type is: what it is called, the facts it asks for (its fields), the body
 * it starts from (its template blocks), how its page is set up, and which
 * controls make sense for it. Nothing else in the Doc module knows one
 * document from another; adding a fourteenth is a new entry here.
 *
 * A field's `key` is the {{placeholder}} its value fills, everywhere in the
 * blocks. `from` pre-fills it from the linked client — and the value stays
 * editable, on the page as well as in the panel.
 */
import type { LayoutConfig } from '@/modules/workstation/quotations/document';
import { DOC_LAYOUT, hydrate, type DBlock, type DBlockKey, type RawBlock } from './model';
import {
  APPOINTMENT_LETTER, CONSENT_LETTER, DIRECTOR_RESIGNATION, NON_DISQUALIFICATION,
} from './templates/letters';
import {
  BOARD_RESOLUTION_APPOINTMENT, BOARD_RESOLUTION_AUTHORISED_SIGNATORY,
  BOARD_RESOLUTION_RESIGNATION, SHAREHOLDERS_RESOLUTION,
} from './templates/resolutions';
import {
  AUTHORISED_SIGNATORY_DECLARATION, NOC_GST, NOC_INCORPORATION,
} from './templates/declarations';
import { AUTHORISED_SIGNATORY_PVT_LTD, EPF_LETTER, LEASE_DEED } from './templates/company';
import { LLP_AGREEMENT_BLOCKS } from './templates/llp-agreement.gen';
import { PARTNERSHIP_DEED_BLOCKS } from './templates/partnership-agreement.gen';

export type DocTypeId =
  | 'appointment-letter'
  | 'consent-letter'
  | 'non-disqualification'
  | 'director-resignation'
  | 'board-resolution-appointment'
  | 'board-resolution-resignation'
  | 'board-resolution-authorised-signatory'
  | 'shareholders-resolution'
  | 'authorised-signatory-declaration'
  | 'noc-gst'
  | 'noc-incorporation'
  | 'llp-agreement'
  | 'partnership-agreement'
  | 'authorised-signatory-pvt-ltd'
  | 'lease-deed'
  | 'epf-letter';

export type FieldType = 'text' | 'textarea' | 'date' | 'time';

export interface FieldDef {
  /** The {{placeholder}} this value fills. */
  key: string;
  label: string;
  type?: FieldType;
  placeholder?: string;
  /** Pre-filled from the linked client; still editable everywhere. */
  from?: 'companyName' | 'address' | 'email' | 'phone' | 'contactPerson';
  /** Left-panel grouping. */
  group?: string;
}

/** What the left panel offers for this type, beyond Save / PDF / Print. */
export type DocAction = 'addParagraph' | 'addSection' | 'addDetails' | 'addSignature' | 'addWitness' | 'addSpace' | 'addPageBreak';

export interface DocTypeConfig {
  id: DocTypeId;
  name: string;
  /** One line on the card. */
  description: string;
  category: 'Company law' | 'Director' | 'GST & registration' | 'Agreement';
  fields: FieldDef[];
  blocks: () => DBlock[];
  layout?: Partial<LayoutConfig>;
  actions: DocAction[];
  /** The blocks this type's own structure depends on — never deletable. */
  fixed?: DBlockKey[];
}

const G = { party: 'Company', who: 'People', meeting: 'Meeting', more: 'Particulars' };

const COMPANY: FieldDef = { key: 'company_name', label: 'Company name', from: 'companyName', group: G.party };
const OFFICE: FieldDef = { key: 'registered_office', label: 'Registered office', type: 'textarea', from: 'address', group: G.party };
const MEETING: FieldDef[] = [
  { key: 'meeting_date', label: 'Meeting date', type: 'date', group: G.meeting },
  { key: 'meeting_time', label: 'Meeting time', type: 'time', group: G.meeting },
  { key: 'meeting_place', label: 'Meeting place', group: G.meeting },
];
const SIGNATORY: FieldDef[] = [
  { key: 'signatory1_name', label: 'Signed by', group: G.who },
  { key: 'signatory1_din', label: 'DIN', group: G.who },
];

const LETTER_ACTIONS: DocAction[] = ['addParagraph', 'addSection', 'addDetails', 'addSpace'];
const RESOLUTION_ACTIONS: DocAction[] = ['addParagraph', 'addSignature', 'addSpace'];
const AGREEMENT_ACTIONS: DocAction[] = ['addParagraph', 'addSection', 'addSignature', 'addWitness', 'addSpace', 'addPageBreak'];

const of = (raw: RawBlock[]) => () => hydrate(raw);

export const DOC_TYPES: DocTypeConfig[] = [
  {
    id: 'appointment-letter',
    name: 'Appointment Letter',
    description: 'Informs a director of their appointment by the Board.',
    category: 'Director',
    fields: [
      COMPANY,
      { key: 'director_name', label: 'Director appointed', group: G.who },
      { key: 'din', label: 'DIN', group: G.who },
      { key: 'director_place', label: 'Place', group: G.who },
      { key: 'board_meeting_date', label: 'Board meeting date', type: 'date', group: G.meeting },
      { key: 'signatory_name', label: 'Signed by', group: G.who },
      { key: 'signatory_designation', label: 'Designation', placeholder: 'Director', group: G.who },
      { key: 'signatory_din', label: 'Signatory DIN', group: G.who },
    ],
    blocks: of(APPOINTMENT_LETTER),
    actions: LETTER_ACTIONS,
  },
  {
    id: 'consent-letter',
    name: 'Consent Letter (DIR-2)',
    description: 'A director’s consent to act, under Section 152(5).',
    category: 'Director',
    fields: [
      COMPANY, OFFICE,
      { key: 'director_name', label: 'Director', group: G.who },
      { key: 'father_name', label: 'S/o — D/o', group: G.who },
      { key: 'din', label: 'DIN', group: G.who },
      { key: 'director_address', label: 'Address', type: 'textarea', group: G.who },
      { key: 'email', label: 'Email', group: G.who },
      { key: 'mobile', label: 'Mobile', group: G.who },
    ],
    blocks: of(CONSENT_LETTER),
    actions: LETTER_ACTIONS,
  },
  {
    id: 'non-disqualification',
    name: 'Non-Disqualification (DIR-8)',
    description: 'Intimation under Section 164(2) that a director is not disqualified.',
    category: 'Director',
    fields: [
      COMPANY, OFFICE,
      { key: 'director_name', label: 'Director', group: G.who },
      { key: 'din', label: 'DIN', group: G.who },
    ],
    blocks: of(NON_DISQUALIFICATION),
    actions: LETTER_ACTIONS,
  },
  {
    id: 'director-resignation',
    name: 'Director Resignation Letter',
    description: 'A director’s resignation, for filing in DIR-11 / DIR-12.',
    category: 'Director',
    fields: [
      COMPANY, OFFICE,
      { key: 'director_name', label: 'Resigning director', group: G.who },
      { key: 'din', label: 'DIN', group: G.who },
      { key: 'effective_date', label: 'Effective from', type: 'date', group: G.more },
      { key: 'resignation_reason', label: 'Reason', placeholder: 'personal reasons / pre-occupation', group: G.more },
      { key: 'director_address', label: 'Address', type: 'textarea', group: G.who },
      { key: 'email', label: 'Email', group: G.who },
    ],
    blocks: of(DIRECTOR_RESIGNATION),
    actions: LETTER_ACTIONS,
  },
  {
    id: 'board-resolution-appointment',
    name: 'Board Resolution — Appointment',
    description: 'Certified true copy: DIN application and appointment of a director.',
    category: 'Company law',
    fields: [
      COMPANY,
      { key: 'cin', label: 'CIN', group: G.party },
      ...MEETING,
      { key: 'appointee_name', label: 'Person appointed', group: G.who },
      { key: 'authorised_director', label: 'Director authorised to file', group: G.who },
      ...SIGNATORY,
      { key: 'signatory2_name', label: 'Counter-signed by', group: G.who },
      { key: 'signatory2_din', label: 'DIN', group: G.who },
    ],
    blocks: of(BOARD_RESOLUTION_APPOINTMENT),
    actions: RESOLUTION_ACTIONS,
  },
  {
    id: 'board-resolution-resignation',
    name: 'Board Resolution — Resignation',
    description: 'Certified true copy: acceptance of a director’s resignation.',
    category: 'Company law',
    fields: [
      COMPANY, ...MEETING,
      { key: 'resigning_director', label: 'Resigning director', group: G.who },
      { key: 'resigning_din', label: 'DIN', group: G.who },
      { key: 'effective_date', label: 'Effective from', type: 'date', group: G.more },
      { key: 'authorised_director', label: 'Director authorised to file', group: G.who },
      ...SIGNATORY,
    ],
    blocks: of(BOARD_RESOLUTION_RESIGNATION),
    actions: RESOLUTION_ACTIONS,
  },
  {
    id: 'board-resolution-authorised-signatory',
    name: 'Board Resolution — Authorised Signatory',
    description: 'Appoints an authorised signatory, for GST and bank formalities.',
    category: 'GST & registration',
    fields: [
      COMPANY, OFFICE,
      { key: 'meeting_date', label: 'Meeting date', type: 'date', group: G.meeting },
      { key: 'meeting_time', label: 'Meeting time', type: 'time', group: G.meeting },
      { key: 'director_name', label: 'Authorised signatory', group: G.who },
      { key: 'purpose', label: 'Purpose', placeholder: 'GST registration and related compliances', group: G.more },
      ...SIGNATORY,
      { key: 'signatory1_designation', label: 'Designation', placeholder: 'Director', group: G.who },
      { key: 'place', label: 'Place', group: G.more },
    ],
    blocks: of(BOARD_RESOLUTION_AUTHORISED_SIGNATORY),
    actions: RESOLUTION_ACTIONS,
  },
  {
    id: 'shareholders-resolution',
    name: 'Shareholders’ Resolution',
    description: 'Ordinary resolution of the members appointing a director.',
    category: 'Company law',
    fields: [
      COMPANY, ...MEETING,
      { key: 'appointee_name', label: 'Person appointed', group: G.who },
      { key: 'appointee_din', label: 'DIN', group: G.who },
      { key: 'authorised_director', label: 'Director authorised to file', group: G.who },
      ...SIGNATORY,
    ],
    blocks: of(SHAREHOLDERS_RESOLUTION),
    actions: RESOLUTION_ACTIONS,
  },
  {
    id: 'authorised-signatory-declaration',
    name: 'Authorised Signatory Declaration',
    description: 'Partnership or LLP declaration, with the signatory’s acceptance.',
    category: 'GST & registration',
    fields: [
      { key: 'firm_name', label: 'Firm / LLP name', from: 'companyName', group: G.party },
      { key: 'firm_address', label: 'Address', type: 'textarea', from: 'address', group: G.party },
      { key: 'firm_phone', label: 'Phone', from: 'phone', group: G.party },
      { key: 'signatory_name', label: 'Authorised signatory', group: G.who },
      { key: 'signatory_din', label: 'DIN / DPIN', group: G.who },
      { key: 'partner1_name', label: 'Partner 1', group: G.who },
      { key: 'partner1_din', label: 'Partner 1 DIN', group: G.who },
      { key: 'partner2_name', label: 'Partner 2', group: G.who },
      { key: 'partner2_din', label: 'Partner 2 DIN', group: G.who },
      { key: 'partner3_name', label: 'Partner 3', group: G.who },
      { key: 'partner3_din', label: 'Partner 3 DIN', group: G.who },
      { key: 'partner4_name', label: 'Partner 4', group: G.who },
      { key: 'partner4_din', label: 'Partner 4 DIN', group: G.who },
    ],
    blocks: of(AUTHORISED_SIGNATORY_DECLARATION),
    layout: { headerStyle: 'rule' },
    actions: ['addParagraph', 'addSignature', 'addSpace'],
  },
  {
    id: 'noc-gst',
    name: 'NOC — GST Registration',
    description: 'Property owner’s no-objection for use as the principal place of business.',
    category: 'GST & registration',
    fields: [
      { key: 'owner_name', label: 'Property owner', group: G.who },
      { key: 'owner_relation', label: 'S/o — W/o — D/o', group: G.who },
      { key: 'property_address', label: 'Property address', type: 'textarea', from: 'address', group: G.more },
      { key: 'concern_name', label: 'Name of the concern', from: 'companyName', group: G.party },
      { key: 'proprietor_name', label: 'Proprietor', from: 'contactPerson', group: G.party },
      { key: 'pan', label: 'PAN of the proprietor', group: G.party },
      { key: 'nature_of_business', label: 'Nature of business', group: G.party },
      { key: 'place', label: 'Place', group: G.more },
    ],
    blocks: of(NOC_GST),
    actions: ['addParagraph', 'addDetails', 'addWitness', 'addSpace'],
  },
  {
    id: 'noc-incorporation',
    name: 'NOC — Incorporation',
    description: 'Owner’s consent to use the premises as the registered office.',
    category: 'GST & registration',
    fields: [
      { key: 'owner_names', label: 'Property owner(s)', group: G.who },
      { key: 'property_address', label: 'Property address', type: 'textarea', from: 'address', group: G.more },
      COMPANY,
      { key: 'directors', label: 'Director / shareholder 1', type: 'textarea', group: G.who },
      { key: 'directors2', label: 'Director / shareholder 2', type: 'textarea', group: G.who },
      { key: 'owner1_name', label: 'Signed by', group: G.who },
      { key: 'owner2_name', label: 'Counter-signed by', group: G.who },
      { key: 'place', label: 'Place', group: G.more },
    ],
    blocks: of(NOC_INCORPORATION),
    actions: ['addParagraph', 'addSignature', 'addSpace'],
  },
  {
    id: 'llp-agreement',
    name: 'LLP Agreement',
    description: 'The partners’ agreement under Section 23(4) of the LLP Act, 2008.',
    category: 'Agreement',
    fields: [
      { key: 'llp_name', label: 'LLP name', from: 'companyName', group: G.party },
      { key: 'registered_office', label: 'Registered office', type: 'textarea', from: 'address', group: G.party },
      { key: 'place', label: 'Executed at', group: G.more },
      { key: 'agreement_date', label: 'Agreement date', type: 'date', group: G.more },
      { key: 'contribution', label: 'Total contribution (Rs.)', group: G.more },
      { key: 'business_activity', label: 'Business activity', group: G.more },
      { key: 'partner1_name', label: 'First party', group: G.who },
      { key: 'partner1_details', label: 'First party particulars', type: 'textarea', group: G.who },
      { key: 'partner1_din', label: 'First party DPIN', group: G.who },
      { key: 'partner2_name', label: 'Second party', group: G.who },
      { key: 'partner2_details', label: 'Second party particulars', type: 'textarea', group: G.who },
      { key: 'partner2_din', label: 'Second party DPIN', group: G.who },
    ],
    blocks: of(LLP_AGREEMENT_BLOCKS),
    layout: { footerStyle: 'page-numbers' },
    actions: AGREEMENT_ACTIONS,
  },
  {
    id: 'partnership-agreement',
    name: 'Partnership Deed',
    description: 'A two-partner deed under the Indian Partnership Act, 1932.',
    category: 'Agreement',
    fields: [
      { key: 'firm_name', label: 'Firm name', from: 'companyName', group: G.party },
      { key: 'business_address', label: 'Principal place of business', type: 'textarea', from: 'address', group: G.party },
      { key: 'nature_of_business', label: 'Nature of business', group: G.party },
      { key: 'place', label: 'Executed at', group: G.more },
      { key: 'agreement_date', label: 'Deed date', type: 'date', group: G.more },
      { key: 'capital_each', label: 'Capital per partner', group: G.more },
      { key: 'partner1_name', label: 'First partner', group: G.who },
      { key: 'partner1_aadhaar', label: 'Aadhaar', group: G.who },
      { key: 'partner1_details', label: 'First partner particulars', type: 'textarea', group: G.who },
      { key: 'partner2_name', label: 'Second partner', group: G.who },
      { key: 'partner2_aadhaar', label: 'Aadhaar', group: G.who },
      { key: 'partner2_details', label: 'Second partner particulars', type: 'textarea', group: G.who },
    ],
    blocks: of(PARTNERSHIP_DEED_BLOCKS),
    layout: { footerStyle: 'page-numbers' },
    actions: AGREEMENT_ACTIONS,
  },
  {
    id: 'authorised-signatory-pvt-ltd',
    name: 'Authorised Signatory \u2014 Private Limited',
    description: 'Letterhead confirmation that a director may sign for the company.',
    category: 'GST & registration',
    fields: [
      COMPANY, OFFICE,
      { key: 'signatory_name', label: 'Authorised signatory', group: G.who },
      { key: 'signatory_designation', label: 'Designation', placeholder: 'Director', group: G.who },
      { key: 'signatory1_name', label: 'Signed by', group: G.who },
      { key: 'signatory2_name', label: 'Counter-signed by', group: G.who },
    ],
    blocks: of(AUTHORISED_SIGNATORY_PVT_LTD),
    layout: { headerStyle: 'rule' },
    actions: ['addParagraph', 'addSignature', 'addSpace'],
  },
  {
    id: 'lease-deed',
    name: 'Lease Deed',
    description: 'Commercial lease: parties, term, rent, deposit, clauses and schedule.',
    category: 'Agreement',
    fields: [
      { key: 'place', label: 'Executed at', group: G.more },
      { key: 'execution_day', label: 'Executed on (in words)', placeholder: 'FIFTH Day of NOVEMBER, TWO THOUSAND AND TWENTY-FIVE', group: G.more },
      { key: 'execution_date', label: 'Executed on', type: 'date', group: G.more },
      { key: 'lessor_name', label: 'Lessor', group: G.who },
      { key: 'lessor_aadhaar', label: 'Lessor Aadhaar', group: G.who },
      { key: 'lessor_address', label: 'Lessor address', type: 'textarea', group: G.who },
      { key: 'lessee_name', label: 'Lessee', from: 'companyName', group: G.who },
      { key: 'lessee_address', label: 'Lessee registered office', type: 'textarea', from: 'address', group: G.who },
      { key: 'lessee_represented_by', label: 'Lessee represented by', group: G.who },
      { key: 'property_address', label: 'Demised premises', type: 'textarea', group: 'Property' },
      { key: 'lease_period', label: 'Lease period', placeholder: '11 months (Eleven Months)', group: 'Lease' },
      { key: 'lease_from', label: 'From', type: 'date', group: 'Lease' },
      { key: 'lease_to', label: 'To', type: 'date', group: 'Lease' },
      { key: 'notice_period', label: 'Notice period', placeholder: 'three months', group: 'Lease' },
      { key: 'monthly_rent', label: 'Monthly rent', placeholder: 'Rs. 25,000 (Rupees Twenty Five thousand only)', group: 'Money' },
      { key: 'security_deposit', label: 'Security deposit', placeholder: 'Rs. 2,00,000/- (Rupees Two lakhs only)', group: 'Money' },
      { key: 'rent_due_day', label: 'Rent due by', placeholder: '10th', group: 'Money' },
      { key: 'witness1_name', label: 'Witness 1', group: 'Witnesses' },
      { key: 'witness1_address', label: 'Witness 1 address', type: 'textarea', group: 'Witnesses' },
      { key: 'witness1_phone', label: 'Witness 1 contact', group: 'Witnesses' },
      { key: 'witness1_aadhaar', label: 'Witness 1 Aadhaar', group: 'Witnesses' },
      { key: 'witness2_name', label: 'Witness 2', group: 'Witnesses' },
      { key: 'witness2_address', label: 'Witness 2 address', type: 'textarea', group: 'Witnesses' },
      { key: 'witness2_phone', label: 'Witness 2 contact', group: 'Witnesses' },
      { key: 'witness2_aadhaar', label: 'Witness 2 Aadhaar', group: 'Witnesses' },
    ],
    blocks: of(LEASE_DEED),
    layout: { footerStyle: 'page-numbers' },
    actions: ['addParagraph', 'addSection', 'addDetails', 'addSignature', 'addWitness', 'addSpace', 'addPageBreak'],
  },
  {
    id: 'epf-letter',
    name: 'EPF Letter',
    description: 'Asks the RPFC to mark an auto-allotted EPF code dormant.',
    category: 'GST & registration',
    fields: [
      COMPANY,
      { key: 'cin', label: 'CIN', group: G.party },
      { key: 'incorporation_date', label: 'Date of incorporation', type: 'date', group: G.party },
      { key: 'epf_code', label: 'EPF code', group: 'EPF' },
      { key: 'epfo_office', label: 'EPFO regional office', placeholder: 'Coimbatore', group: 'EPF' },
      { key: 'director_count', label: 'Number of directors', placeholder: 'two', group: 'EPF' },
      { key: 'signatory_name', label: 'Signed by', group: G.who },
      { key: 'signatory_din', label: 'DIN', group: G.who },
    ],
    blocks: of(EPF_LETTER),
    actions: ['addParagraph', 'addSection', 'addSpace'],
  },
];

export const DOC_TYPE_BY_ID: Record<string, DocTypeConfig> =
  Object.fromEntries(DOC_TYPES.map((t) => [t.id, t]));

export const docType = (id: string | undefined): DocTypeConfig | undefined =>
  (id ? DOC_TYPE_BY_ID[id] : undefined);

/** The page setup for a type: the Doc default, with the type's own overrides. */
export const layoutFor = (t: DocTypeConfig): LayoutConfig => ({ ...DOC_LAYOUT, ...(t.layout ?? {}) });

export const CATEGORIES: DocTypeConfig['category'][] =
  ['Director', 'Company law', 'GST & registration', 'Agreement'];
