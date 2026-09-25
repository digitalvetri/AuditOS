/**
 * Partnership Firm Registration — the master checklist as the firm wrote it.
 *
 * SOURCE: "Partnership Documents (4).pdf" (Desktop/Audit OS/Registration),
 * two parts in this order:
 *   A. DETAILS & DOCUMENTS REQUIRED FOR PARTNERSHIP DEED DRAFTING  (sections 1–5)
 *   B. DOCUMENT CHECKLIST FOR PARTNERSHIP FIRM REGISTRATION (ROF) (sections 1–4)
 *
 * Wording, order and the "(if applicable)" / "If Rented" / "If Owned" /
 * "If authorizing" qualifiers are the PDF's own. Do not add items the PDF does
 * not list — the checklist is what the firm sends its clients.
 *
 * This is only the SEED for the master template in the database. Admins edit
 * the template in the app; each case copies the template when it is opened and
 * never reads it again.
 *
 * kind:
 *   INFO      information the client supplies (captured in Registration Details)
 *   DOCUMENT  a file to collect — creates a document requirement
 *   ACTION    something the firm/partners must do (execute, notarise)
 * perPartner: one document requirement per partner, created when the partner
 *   is added to the case.
 * docKey: two items that ask for the same file share a key, so the file is
 *   collected once. PAN and ID proof appear in both parts of the PDF.
 * condition: which premises type the item applies to (section B3).
 */

export type RequirementType = 'REQUIRED' | 'OPTIONAL' | 'CONDITIONAL';
export type ItemKind = 'INFO' | 'DOCUMENT' | 'ACTION';
/** Premises (RENTED/OWNED) or, for GST, the business type the item applies to. */
export type PremisesCondition = 'RENTED' | 'OWNED' | 'PROPRIETORSHIP' | 'PARTNERSHIP' | 'LLP_COMPANY';

export interface TemplateItemSeed {
  name: string;
  description?: string;
  requirement: RequirementType;
  kind: ItemKind;
  perPartner?: boolean;
  docKey?: string;
  condition?: PremisesCondition;
  /** "Any one" of these satisfies the item — the uploader picks which. */
  docTypeOptions?: string[];
  maxAgeDays?: number;
}

export interface TemplateCategorySeed {
  name: string;
  description?: string;
  stage: string;
  /** Repeated for every partner on the case (LLP partner KYC). */
  perPartner?: boolean;
  items: TemplateItemSeed[];
}

/** Partnership: the PDF's two parts, then the filing and its result. */
export const CASE_STAGES = ['INFO_COLLECTION', 'DEED', 'ROF_FILING', 'REGISTERED'] as const;
export type CaseStage = (typeof CASE_STAGES)[number];
/**
 * LLP: the source says only that registration "is processed in two stages",
 * so the stages carry no invented names. Which category belongs to which is
 * the firm's call (Basic Business Details → Stage 1) and editable in the
 * template.
 */
export const LLP_STAGES = ['STAGE_1', 'STAGE_2', 'COMPLETED'] as const;

export const CASE_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'DOCUMENTS_PENDING',
  'UNDER_REVIEW',
  'SUBMITTED',
  'QUERY',
  'COMPLETED',
  'ON_HOLD',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const MASTER_TEMPLATE: TemplateCategorySeed[] = [
  // ── Part A: Details & documents required for Partnership Deed drafting ──
  {
    name: 'Core Firm Details',
    stage: 'INFO_COLLECTION',
    items: [
      { name: 'Proposed Firm Name', description: 'Provide 2-3 alternate options in order of preference', requirement: 'REQUIRED', kind: 'INFO' },
      { name: 'Nature of Business', description: 'Detailed description of the business activities you will carry out', requirement: 'REQUIRED', kind: 'INFO' },
      { name: 'Principal Place of Business', description: 'Full address of the main office (including pincode)', requirement: 'REQUIRED', kind: 'INFO' },
      { name: 'Other Branches', description: 'Addresses of any other branches/godowns (if applicable)', requirement: 'CONDITIONAL', kind: 'INFO' },
    ],
  },
  {
    name: 'Identity & Address Proofs (All Partners)',
    stage: 'INFO_COLLECTION',
    items: [
      { name: 'PAN Card', description: 'Name must match other documents', requirement: 'REQUIRED', kind: 'DOCUMENT', perPartner: true, docKey: 'PAN' },
      { name: 'Aadhaar Card / Passport / Voter ID', requirement: 'REQUIRED', kind: 'DOCUMENT', perPartner: true, docKey: 'ID_ADDRESS_PROOF' },
      { name: "Father's Name", description: 'As per official records', requirement: 'REQUIRED', kind: 'INFO', perPartner: true },
      { name: 'Full Permanent Address', requirement: 'REQUIRED', kind: 'INFO', perPartner: true },
    ],
  },
  {
    name: 'Financial & Operational Terms',
    description: 'To be agreed by partners',
    stage: 'INFO_COLLECTION',
    items: [
      { name: 'Capital Contribution', description: 'Total capital amount and the exact amount/percentage invested by each partner', requirement: 'REQUIRED', kind: 'INFO' },
      { name: 'Profit & Loss Sharing Ratio', description: 'Exact percentage of profit/loss allocated to each partner', requirement: 'REQUIRED', kind: 'INFO' },
      { name: 'Remuneration/Salary', description: 'Will any partner receive a monthly salary or commission? (Specify amounts or limits as per Income Tax Sec 40(b))', requirement: 'REQUIRED', kind: 'INFO' },
      { name: 'Interest on Capital', description: "Rate of interest to be paid on partners' capital (Max 12% per annum allowed under Income Tax Act)", requirement: 'REQUIRED', kind: 'INFO' },
      { name: 'Drawing Limits', description: 'Maximum amount a partner can withdraw monthly for personal use', requirement: 'REQUIRED', kind: 'INFO' },
    ],
  },
  {
    name: 'Management & Signing Rights',
    stage: 'INFO_COLLECTION',
    items: [
      { name: 'Bank Account Operation', description: 'Who will operate the bank account? (Jointly by all, or singly by specific partners)', requirement: 'REQUIRED', kind: 'INFO' },
      { name: 'Authorized Signatory', description: 'Who is authorized to sign business contracts, tax bills, and government registrations?', requirement: 'REQUIRED', kind: 'INFO' },
    ],
  },
  {
    name: 'Other Details',
    stage: 'INFO_COLLECTION',
    items: [
      { name: 'Date of Commencement', description: 'The exact date from which the partnership business will officially start', requirement: 'REQUIRED', kind: 'INFO' },
      { name: 'Witness Details', description: 'Full names and addresses of Two Witnesses who will sign the deed along with the partners', requirement: 'REQUIRED', kind: 'INFO' },
    ],
  },

  // ── Part B: Document checklist for Partnership Firm Registration (ROF) ──
  // "please provide clear scanned copies (PDF or JPEG)"
  {
    name: 'Partnership Deed',
    stage: 'DEED',
    items: [
      { name: 'Drafted Partnership Deed', description: 'Signed by all partners on all pages', requirement: 'REQUIRED', kind: 'DOCUMENT', docKey: 'DEED' },
      { name: 'Stamp Paper', description: 'To be executed on Stamp Paper of appropriate value (As per State Rules)', requirement: 'REQUIRED', kind: 'ACTION' },
      { name: 'Notarization', description: 'Deed must be duly Notarized by a Notary Public', requirement: 'REQUIRED', kind: 'ACTION' },
    ],
  },
  {
    name: 'Documents of All Partners',
    stage: 'ROF_FILING',
    items: [
      { name: 'PAN Card', description: 'Mandatory for identity verification', requirement: 'REQUIRED', kind: 'DOCUMENT', perPartner: true, docKey: 'PAN' },
      { name: 'Aadhaar Card / Passport / Voter ID / Driving License', description: 'Address Proof', requirement: 'REQUIRED', kind: 'DOCUMENT', perPartner: true, docKey: 'ID_ADDRESS_PROOF' },
      { name: 'Passport size photographs', description: 'Recent, with clear background', requirement: 'REQUIRED', kind: 'DOCUMENT', perPartner: true, docKey: 'PHOTO' },
      { name: 'Active Mobile Number & Email ID', description: 'For OTP verifications', requirement: 'REQUIRED', kind: 'INFO', perPartner: true },
    ],
  },
  {
    name: "Firm's Registered Office Proof",
    stage: 'ROF_FILING',
    items: [
      { name: 'Valid Rent Agreement / Lease Deed', description: 'If Rented / Leased Premises', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'RENTED', docKey: 'RENT_AGREEMENT' },
      { name: 'No Objection Certificate (NOC) from the Property Owner', description: 'If Rented / Leased Premises', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'RENTED', docKey: 'OWNER_NOC' },
      { name: 'Recent Utility Bill', description: "If Rented / Leased Premises — Electricity Bill / Property Tax Receipt in Owner's name, not older than 2 months", requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'RENTED', docKey: 'UTILITY_BILL_RENTED' },
      { name: 'Ownership Deed / Sale Deed', description: 'If Owned Premises', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'OWNED', docKey: 'OWNERSHIP_DEED' },
      { name: 'Recent Electricity Bill or Property Tax Receipt', description: 'If Owned Premises', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'OWNED', docKey: 'UTILITY_BILL_OWNED' },
    ],
  },
  {
    name: 'Additional Forms & Authorization',
    description: 'To be signed during filing',
    stage: 'ROF_FILING',
    items: [
      { name: 'Form No. 1', description: 'Application for Registration under Section 58', requirement: 'REQUIRED', kind: 'DOCUMENT', docKey: 'FORM_1' },
      { name: 'Affidavit / Declaration Form', description: 'Specifying accuracy of firm details, on non-judicial stamp paper', requirement: 'REQUIRED', kind: 'DOCUMENT', docKey: 'AFFIDAVIT' },
      { name: 'Authorization Letter', description: 'If authorizing a professional/consultant to handle the registration', requirement: 'CONDITIONAL', kind: 'DOCUMENT', docKey: 'AUTHORIZATION_LETTER' },
      { name: 'Witness details for the application', description: 'Full Names, Occupations, and PAN/Aadhar details of Two Witnesses who will sign the application', requirement: 'REQUIRED', kind: 'INFO' },
    ],
  },
];

/**
 * LLP Registration — SOURCE: "LLP Registration (1).docx", "DOCUMENT CHECKLIST
 * FOR LLP REGISTRATION". Three sections, in the document's order and words.
 * "Please provide clear scanned copies (PDF or JPEG)".
 */
export const LLP_TEMPLATE: TemplateCategorySeed[] = [
  {
    name: 'Documents of All Partners (KYC)',
    stage: 'STAGE_2',
    perPartner: true,
    items: [
      { name: 'PAN Card', description: 'Mandatory for all Indian partners (Name must match exactly with Aadhaar)', requirement: 'REQUIRED', kind: 'DOCUMENT' },
      { name: 'Identity Proof', description: 'Any One: Passport, Voter ID, or Driving License', requirement: 'REQUIRED', kind: 'DOCUMENT', docTypeOptions: ['Passport', 'Voter ID', 'Driving License'] },
      { name: 'Address Proof', description: 'Any One - Not older than 2 months with identical name: Bank Statement, Electricity Bill, Mobile/Telephone Bill', requirement: 'REQUIRED', kind: 'DOCUMENT', docTypeOptions: ['Bank Statement', 'Electricity Bill', 'Mobile/Telephone Bill'], maxAgeDays: 60 },
      { name: 'Aadhaar Card', description: 'Mandatory for linking and verification', requirement: 'REQUIRED', kind: 'DOCUMENT' },
      { name: 'Passport Size Photo', description: 'Recent, with a clear background', requirement: 'REQUIRED', kind: 'DOCUMENT' },
      { name: 'Contact Details', description: 'Active Mobile Number & Email ID for OTP verification', requirement: 'REQUIRED', kind: 'INFO' },
    ],
  },
  {
    name: 'LLP Registered Office Proof',
    stage: 'STAGE_2',
    items: [
      { name: 'Valid Rent Agreement / Lease Deed', description: 'If Rented / Leased Premises', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'RENTED' },
      { name: 'No Objection Certificate (NOC) from the Property Owner', description: 'If Rented / Leased Premises', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'RENTED' },
      { name: 'Recent Utility Bill', description: "If Rented / Leased Premises — Electricity Bill / Gas Bill / Property Tax Receipt in the Owner's name, not older than 2 months", requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'RENTED', docTypeOptions: ['Electricity Bill', 'Gas Bill', 'Property Tax Receipt'], maxAgeDays: 60 },
      { name: 'Ownership Deed / Sale Deed', description: 'If Owned Premises', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'OWNED' },
      { name: 'Recent Electricity Bill or Property Tax Receipt', description: 'If Owned Premises', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'OWNED', docTypeOptions: ['Electricity Bill', 'Property Tax Receipt'] },
    ],
  },
  {
    name: 'Basic Business Details Needed',
    stage: 'STAGE_1',
    items: [
      { name: 'Proposed LLP Names', description: '2 unique names in order of preference', requirement: 'REQUIRED', kind: 'INFO' },
      { name: 'Main Objective', description: 'A brief description of the business activities you plan to run', requirement: 'REQUIRED', kind: 'INFO' },
      { name: 'Contribution', description: 'Total capital of the LLP and the profit-sharing ratio among partners', requirement: 'REQUIRED', kind: 'INFO' },
    ],
  },
];

/** GST: the source defines no stages — collect the documents, then the GSTIN. */
export const GST_STAGES = ['DOCUMENTS', 'REGISTERED'] as const

/**
 * GST Registration — SOURCE: "GST Registration .pdf" (Registration folder),
 * "DOCUMENTS REQUIRED FOR GST REGISTRATION", "based on your business type".
 * Sections 1–3 apply by business type; section 4 is "Mandatory for All" and
 * splits by owned / rented property. "PAN & Aadhaar of all Partners" is two
 * files per partner, so it is two items carrying the source line as description.
 */
const P = 'PARTNERSHIP' as const
const L = 'LLP_COMPANY' as const
export const GST_TEMPLATE: TemplateCategorySeed[] = [
  {
    name: 'Individual / Proprietorship',
    stage: 'DOCUMENTS',
    items: [
      { name: "Owner's PAN Card", requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'PROPRIETORSHIP' },
      { name: "Owner's Aadhaar Card", requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'PROPRIETORSHIP' },
      { name: "Owner's Passport Size Photo", requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'PROPRIETORSHIP' },
      { name: 'Valid Email ID & Mobile Number', description: 'Linked with Aadhaar', requirement: 'CONDITIONAL', kind: 'INFO', condition: 'PROPRIETORSHIP' },
      { name: 'Bank Account Details', description: 'Cancel Cheque / Bank Statement / Passbook front page', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'PROPRIETORSHIP', docTypeOptions: ['Cancel Cheque', 'Bank Statement', 'Passbook front page'] },
    ],
  },
  {
    name: 'Partnership Firm',
    stage: 'DOCUMENTS',
    items: [
      { name: "Firm's PAN Card", requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: P },
      { name: 'Partnership Deed', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: P },
      { name: 'PAN of all Partners', description: 'PAN & Aadhaar of all Partners', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: P, perPartner: true, docKey: 'GST_P_PAN' },
      { name: 'Aadhaar of all Partners', description: 'PAN & Aadhaar of all Partners', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: P, perPartner: true, docKey: 'GST_P_AADHAAR' },
      { name: 'Photos of all Partners', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: P, perPartner: true, docKey: 'GST_P_PHOTO' },
      { name: 'Authorized Signatory Proof', description: 'Letter of Authorization / Board Resolution', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: P, docTypeOptions: ['Letter of Authorization', 'Board Resolution'] },
      { name: 'Valid Email ID & Mobile Number of all partners', requirement: 'CONDITIONAL', kind: 'INFO', condition: P },
      { name: "Firm's Bank Account Details", description: 'Cancel Cheque / Statement', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: P, docTypeOptions: ['Cancel Cheque', 'Statement'] },
    ],
  },
  {
    name: 'LLP / Private Limited Company',
    stage: 'DOCUMENTS',
    items: [
      { name: 'Company / LLP PAN Card', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: L },
      { name: 'Certificate of Incorporation (COI)', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: L },
      { name: 'MoA & AoA (for Co.) / LLP Agreement (for LLP)', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: L, docTypeOptions: ['MoA & AoA', 'LLP Agreement'] },
      { name: 'PAN of all Directors / Partners', description: 'PAN & Aadhaar of all Directors / Partners', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: L, perPartner: true, docKey: 'GST_D_PAN' },
      { name: 'Aadhaar of all Directors / Partners', description: 'PAN & Aadhaar of all Directors / Partners', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: L, perPartner: true, docKey: 'GST_D_AADHAAR' },
      { name: 'Photos of all Directors / Partners', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: L, perPartner: true, docKey: 'GST_D_PHOTO' },
      { name: 'Board Resolution / Letter of Authorization for Authorized Signatory', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: L, docTypeOptions: ['Board Resolution', 'Letter of Authorization'] },
      { name: 'Valid Email ID & Mobile Number of Authorized Signatory', requirement: 'CONDITIONAL', kind: 'INFO', condition: L },
      { name: 'Company Bank Account Details', description: 'Cancel Cheque / Statement', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: L, docTypeOptions: ['Cancel Cheque', 'Statement'] },
    ],
  },
  {
    name: 'Business Place Proof',
    description: 'Mandatory for All',
    stage: 'DOCUMENTS',
    items: [
      { name: 'Property Tax Receipt / Ownership Deed / Copy of Electricity Bill', description: 'If Owned Property', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'OWNED', docTypeOptions: ['Property Tax Receipt', 'Ownership Deed', 'Copy of Electricity Bill'] },
      { name: 'Valid Rent Agreement / Lease Deed', description: 'If Rented / Leased Property', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'RENTED' },
      { name: 'Electricity Bill', description: "If Rented / Leased Property — recent copy in Owner's name", requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'RENTED' },
      { name: 'NOC (No Objection Certificate) from the Property Owner', description: 'If Rented / Leased Property', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'RENTED' },
    ],
  },
]

/** Private Limited: the source defines no stages — collect, then incorporate. */
export const PVT_STAGES = ['DOCUMENTS', 'COMPLETED'] as const

/**
 * Private Limited Incorporation — SOURCE: "Private Limited Incorporation
 * Documents .pdf" (Registration folder), "DOCUMENT CHECKLIST FOR PRIVATE
 * LIMITED COMPANY REGISTRATION". Section 1 is per person (every director and
 * shareholder); "Any One" proofs are ONE requirement with a document-type
 * choice; section 2 splits by rented / owned office; section 3 is information.
 */
export const PVT_TEMPLATE: TemplateCategorySeed[] = [
  {
    name: 'Documents of All Directors & Shareholders',
    stage: 'DOCUMENTS',
    perPartner: true,
    items: [
      { name: 'PAN Card', description: 'Mandatory for all Indian nationals (Name must match exactly with Aadhaar)', requirement: 'REQUIRED', kind: 'DOCUMENT' },
      { name: 'Identity Proof', description: 'Any One: Passport, Voter ID, or Driving License', requirement: 'REQUIRED', kind: 'DOCUMENT', docTypeOptions: ['Passport', 'Voter ID', 'Driving License'] },
      { name: 'Address Proof', description: 'Any One — must not be older than 2 months and name must match PAN exactly: Bank Statement, Electricity Bill, or Mobile/Broadband Bill', requirement: 'REQUIRED', kind: 'DOCUMENT', docTypeOptions: ['Bank Statement', 'Electricity Bill', 'Mobile/Broadband Bill'], maxAgeDays: 60 },
      { name: 'Aadhaar Card', description: 'Mandatory for verification', requirement: 'REQUIRED', kind: 'DOCUMENT' },
      { name: 'Passport Size Photo', description: 'Recent, with a clear background', requirement: 'REQUIRED', kind: 'DOCUMENT' },
      { name: 'Mobile Number', description: 'Separate for each Director (for OTP verification)', requirement: 'REQUIRED', kind: 'INFO' },
      { name: 'Email ID', description: 'Separate for each Director (for OTP verification)', requirement: 'REQUIRED', kind: 'INFO' },
      { name: 'Signature for EPF Application', description: 'Please sign in a white plain paper for EPF application', requirement: 'REQUIRED', kind: 'DOCUMENT' },
    ],
  },
  {
    name: 'Registered Office Proof of the Company',
    stage: 'DOCUMENTS',
    items: [
      { name: 'Valid Rent Agreement / Lease Deed', description: 'If Rented / Leased Premises', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'RENTED' },
      { name: 'No Objection Certificate (NOC) from the Property Owner', description: 'If Rented / Leased Premises — stating they have no objection to the company using the address', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'RENTED' },
      { name: 'Recent Utility Bill', description: "If Rented / Leased Premises — Electricity Bill / Gas Bill / Property Tax Receipt in the Owner's name, not older than 2 months", requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'RENTED', docTypeOptions: ['Electricity Bill', 'Gas Bill', 'Property Tax Receipt'], maxAgeDays: 60 },
      { name: 'Ownership Deed / Sale Deed', description: 'If Owned Premises', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'OWNED' },
      { name: 'Recent Electricity Bill or Property Tax Receipt', description: 'If Owned Premises', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'OWNED', docTypeOptions: ['Electricity Bill', 'Property Tax Receipt'] },
    ],
  },
  {
    name: 'Basic Company Details Needed',
    stage: 'DOCUMENTS',
    items: [
      { name: 'Proposed Company Names', description: '2 unique names in order of preference (along with the significance of the word/name chosen)', requirement: 'REQUIRED', kind: 'INFO' },
      { name: 'Main Objective', description: 'A brief description of the primary business activities you plan to conduct', requirement: 'REQUIRED', kind: 'INFO' },
      { name: 'Capital Structure', description: 'Total Proposed Authorized Capital & Paid-up Capital (e.g., Rs. 1,00,000)', requirement: 'REQUIRED', kind: 'INFO' },
      { name: 'Shareholding Pattern', description: 'How many shares will be allocated to each shareholder/director', requirement: 'REQUIRED', kind: 'INFO' },
    ],
  },
]
