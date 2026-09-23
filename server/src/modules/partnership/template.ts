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
export type PremisesCondition = 'RENTED' | 'OWNED';

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
