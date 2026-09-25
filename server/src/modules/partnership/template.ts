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
/**
 * Entity types for GST Registration. `LLP_OR_PVT_LTD` is used on category-level
 * conditions where either applies (Entity Documents, Director/Partner KYC);
 * item-level conditions narrow to one specific entity (MoA & AoA is PVT_LTD
 * only, LLP Agreement is LLP only).
 */
export type EntityCondition = 'PROPRIETORSHIP' | 'PARTNERSHIP' | 'LLP' | 'PVT_LTD' | 'LLP_OR_PVT_LTD';

export interface TemplateItemSeed {
  name: string;
  description?: string;
  requirement: RequirementType;
  kind: ItemKind;
  perPartner?: boolean;
  docKey?: string;
  condition?: PremisesCondition;
  /** Narrows to one entity type within a category. */
  entityCondition?: EntityCondition;
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
  /** Restricts the whole category to a specific entity type. */
  entityCondition?: EntityCondition;
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
/**
 * GST Registration: collect KYC + entity documents + place proof, file REG-01
 * on the portal, GSTIN issued (REG-06). The application itself and the query
 * cycle live on the portal; the case tracks what the firm gathers and holds.
 */
export const GST_STAGES = ['INFO_COLLECTION', 'FILING', 'REGISTERED'] as const;
/** GSTR-1 (§7.2): outward supplies, filed by the 11th. */
export const GSTR1_STAGES = ['DATA_COLLECTION', 'PREPARATION', 'PRE_FILING', 'FILING'] as const;
/** IMS + GSTR-2B (§7.3): inward, actions, reconcile, finalise. */
export const GSTR2B_STAGES = ['INWARD_DATA', 'IMS_ACTIONS', 'RECONCILIATION', 'FINALISE'] as const;
/** GSTR-3B (§7.4): prerequisites, verify, pay, file. */
export const GSTR3B_STAGES = ['PREREQUISITES', 'VERIFICATION', 'PAYMENT', 'FILING'] as const;

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

/**
 * GST Registration master checklist — GST-MODULE-REBUILD.md §7.1.
 *
 * The six categories are grouped by ENTITY TYPE (Proprietorship / Partnership
 * / LLP / Pvt Ltd), plus one that applies to every entity. The engine has no
 * entity-type condition on categories today, so every category is seeded and
 * the description states which entity types it applies to. Case-opening logic
 * will filter categories against the client's entity type when a GST case is
 * created; for now the template is data.
 *
 * "MoA & AoA (for Co.) / LLP Agreement (for LLP)" in the source is ONE line
 * but must be TWO items, so the correct one appears per entity type.
 */
export const GST_TEMPLATE: TemplateCategorySeed[] = [
  {
    name: 'Proprietor KYC',
    description: 'Applies when the entity is a Proprietorship.',
    stage: 'INFO_COLLECTION',
    entityCondition: 'PROPRIETORSHIP',
    items: [
      { name: "Owner's PAN Card", requirement: 'REQUIRED', kind: 'DOCUMENT' },
      { name: "Owner's Aadhaar Card", requirement: 'REQUIRED', kind: 'DOCUMENT' },
      { name: "Owner's Passport Size Photo", requirement: 'REQUIRED', kind: 'DOCUMENT' },
      { name: 'Email & Mobile linked with Aadhaar', requirement: 'REQUIRED', kind: 'INFO' },
      { name: 'Bank Account Proof', description: 'Any one: cancelled cheque, bank statement, or passbook front page', requirement: 'REQUIRED', kind: 'DOCUMENT', docTypeOptions: ['Cancelled cheque', 'Bank statement', 'Passbook front page'] },
    ],
  },
  {
    name: 'Firm Documents',
    description: 'Applies when the entity is a Partnership Firm.',
    stage: 'INFO_COLLECTION',
    entityCondition: 'PARTNERSHIP',
    items: [
      { name: "Firm's PAN Card", requirement: 'REQUIRED', kind: 'DOCUMENT' },
      { name: 'Partnership Deed', requirement: 'REQUIRED', kind: 'DOCUMENT' },
      { name: 'Authorised Signatory Proof', description: 'Letter of Authorisation or Board Resolution', requirement: 'REQUIRED', kind: 'DOCUMENT' },
      { name: "Firm's Bank Account Proof", requirement: 'REQUIRED', kind: 'DOCUMENT' },
    ],
  },
  {
    name: 'Partner KYC',
    description: 'Applies when the entity is a Partnership Firm. One copy per partner.',
    stage: 'INFO_COLLECTION',
    perPartner: true,
    entityCondition: 'PARTNERSHIP',
    items: [
      { name: 'PAN Card', requirement: 'REQUIRED', kind: 'DOCUMENT', perPartner: true, docKey: 'PAN' },
      { name: 'Aadhaar Card', requirement: 'REQUIRED', kind: 'DOCUMENT', perPartner: true },
      { name: 'Passport Size Photo', requirement: 'REQUIRED', kind: 'DOCUMENT', perPartner: true },
      { name: 'Email & Mobile', requirement: 'REQUIRED', kind: 'INFO', perPartner: true },
    ],
  },
  {
    name: 'Entity Documents',
    description: 'Applies when the entity is an LLP or a Private Limited Company.',
    stage: 'INFO_COLLECTION',
    entityCondition: 'LLP_OR_PVT_LTD',
    items: [
      { name: 'Company / LLP PAN Card', requirement: 'REQUIRED', kind: 'DOCUMENT' },
      { name: 'Certificate of Incorporation', requirement: 'REQUIRED', kind: 'DOCUMENT' },
      { name: 'MoA & AoA', description: 'Applies to Private Limited Company.', requirement: 'CONDITIONAL', kind: 'DOCUMENT', entityCondition: 'PVT_LTD' },
      { name: 'LLP Agreement', description: 'Applies to LLP.', requirement: 'CONDITIONAL', kind: 'DOCUMENT', entityCondition: 'LLP' },
      { name: 'Board Resolution / LoA for Signatory', requirement: 'REQUIRED', kind: 'DOCUMENT' },
      { name: 'Company Bank Account Proof', requirement: 'REQUIRED', kind: 'DOCUMENT' },
    ],
  },
  {
    name: 'Director / Partner KYC',
    description: 'Applies when the entity is an LLP or a Private Limited Company. One copy per director or designated partner.',
    stage: 'INFO_COLLECTION',
    perPartner: true,
    entityCondition: 'LLP_OR_PVT_LTD',
    items: [
      { name: 'PAN Card', requirement: 'REQUIRED', kind: 'DOCUMENT', perPartner: true, docKey: 'PAN' },
      { name: 'Aadhaar Card', requirement: 'REQUIRED', kind: 'DOCUMENT', perPartner: true },
      { name: 'Passport Size Photo', requirement: 'REQUIRED', kind: 'DOCUMENT', perPartner: true },
    ],
  },
  {
    name: 'Business Place Proof',
    description: 'Applies to every entity type.',
    stage: 'INFO_COLLECTION',
    items: [
      { name: "Property Tax Receipt / Ownership Deed / Electricity Bill", description: 'Any one, in the owner\'s name.', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'OWNED', docTypeOptions: ['Property Tax Receipt', 'Ownership Deed', 'Electricity Bill'] },
      { name: 'Rent Agreement / Lease Deed', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'RENTED' },
      { name: "Electricity Bill in Owner's name", requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'RENTED' },
      { name: 'NOC from Property Owner', requirement: 'CONDITIONAL', kind: 'DOCUMENT', condition: 'RENTED' },
    ],
  },
];

/**
 * GSTR-1 master checklist — GST-MODULE-REBUILD.md §7.2.
 *
 * Outward supplies, filed by the 11th of the following month. Once filed,
 * the liability flows into GSTR-3B and cannot be edited there — hence the
 * pre-filing verification stage is where the real review happens.
 */
export const GSTR1_TEMPLATE: TemplateCategorySeed[] = [
  {
    name: 'Data Collection',
    stage: 'DATA_COLLECTION',
    items: [
      { name: 'Sales register received', requirement: 'REQUIRED', kind: 'DOCUMENT' },
      { name: 'Credit / debit notes for the period', requirement: 'REQUIRED', kind: 'DOCUMENT' },
      { name: 'Export invoices with shipping bill details', description: 'Applies when the client is an exporter.', requirement: 'CONDITIONAL', kind: 'DOCUMENT' },
      { name: 'E-commerce supply details', description: 'Applies when the client sells through an e-commerce operator.', requirement: 'CONDITIONAL', kind: 'DOCUMENT' },
      { name: 'Document series details', requirement: 'REQUIRED', kind: 'ACTION' },
    ],
  },
  {
    name: 'Preparation',
    stage: 'PREPARATION',
    items: [
      { name: 'B2B invoices — GSTIN validated', requirement: 'REQUIRED', kind: 'ACTION' },
      { name: 'HSN summary prepared', requirement: 'REQUIRED', kind: 'ACTION' },
      { name: 'Place of supply verified on B2B', requirement: 'REQUIRED', kind: 'ACTION' },
      { name: 'Taxable value tallies with books', requirement: 'REQUIRED', kind: 'ACTION' },
      { name: 'Tax amounts verified CGST / SGST / IGST', requirement: 'REQUIRED', kind: 'ACTION' },
    ],
  },
  {
    name: 'Pre-Filing Verification',
    description: 'GSTR-1 liability flows into GSTR-3B and cannot be edited there. Verify before filing. GSTR-1A is the only correction route.',
    stage: 'PRE_FILING',
    items: [
      { name: 'Manager review completed', requirement: 'REQUIRED', kind: 'ACTION' },
      { name: 'Client confirmation received', requirement: 'OPTIONAL', kind: 'ACTION' },
    ],
  },
  {
    name: 'Filing',
    stage: 'FILING',
    items: [
      { name: 'Filed on GST portal', description: 'Gated on stages 1–3 complete.', requirement: 'REQUIRED', kind: 'ACTION' },
      { name: 'ARN captured', requirement: 'REQUIRED', kind: 'INFO' },
      { name: 'Filed return PDF saved', requirement: 'REQUIRED', kind: 'DOCUMENT' },
    ],
  },
];

/**
 * IMS + GSTR-2B master checklist — GST-MODULE-REBUILD.md §7.3.
 *
 * IMS actions are time-boxed — Accept / Reject / Pending on every inward
 * invoice must complete before GSTR-2B generates on the 14th. Whatever the
 * ITC figure lands at here is what GSTR-3B reads; 3B does not recompute.
 */
export const GSTR2B_TEMPLATE: TemplateCategorySeed[] = [
  {
    name: 'Inward Data',
    stage: 'INWARD_DATA',
    items: [
      { name: 'Purchase register received', requirement: 'REQUIRED', kind: 'DOCUMENT' },
    ],
  },
  {
    name: 'IMS Actions',
    description: 'Must complete before GSTR-2B generates on the 14th.',
    stage: 'IMS_ACTIONS',
    items: [
      { name: 'All inward invoices reviewed in IMS', requirement: 'REQUIRED', kind: 'ACTION' },
      { name: 'Accept / Reject / Pending actioned on all', requirement: 'REQUIRED', kind: 'ACTION' },
      { name: 'Rejected invoices communicated to suppliers', requirement: 'REQUIRED', kind: 'ACTION' },
    ],
  },
  {
    name: '2B and Reconciliation',
    stage: 'RECONCILIATION',
    items: [
      { name: 'GSTR-2B downloaded', requirement: 'REQUIRED', kind: 'DOCUMENT' },
      { name: '2B reconciled against purchase register', requirement: 'REQUIRED', kind: 'ACTION' },
      { name: 'Missing-in-2B supplier follow-up list sent', description: 'Applies when variances exist.', requirement: 'CONDITIONAL', kind: 'ACTION' },
      { name: 'ITC eligibility classified', requirement: 'REQUIRED', kind: 'ACTION' },
      { name: 'Ineligible ITC identified with reason', requirement: 'REQUIRED', kind: 'ACTION' },
    ],
  },
  {
    name: 'Finalise',
    stage: 'FINALISE',
    items: [
      { name: 'ITC figure locked for GSTR-3B', description: 'GSTR-3B reads this figure and does not recompute it.', requirement: 'REQUIRED', kind: 'INFO' },
    ],
  },
];

/**
 * GSTR-3B master checklist — GST-MODULE-REBUILD.md §7.4.
 *
 * Prerequisites are auto-checked (GSTR-1 filed, ITC finalised from 2B), not
 * manual — they gate the filing action. The outward liability figure is
 * locked (from July 2025) and cannot be edited in 3B; GSTR-1A is the only
 * same-period correction route.
 */
export const GSTR3B_TEMPLATE: TemplateCategorySeed[] = [
  {
    name: 'Prerequisites',
    description: 'Auto-checked. GSTR-1 must be filed and the ITC figure finalised from 2B before this return can be filed.',
    stage: 'PREREQUISITES',
    items: [
      { name: 'GSTR-1 filed for this period', description: 'Gate — checked automatically.', requirement: 'REQUIRED', kind: 'ACTION' },
      { name: 'ITC figure finalised from 2B', description: 'Gate — checked automatically.', requirement: 'REQUIRED', kind: 'ACTION' },
    ],
  },
  {
    name: 'Verification',
    description: 'The auto-populated outward liability is locked and cannot be edited in 3B. Use GSTR-1A to correct a mismatch found here.',
    stage: 'VERIFICATION',
    items: [
      { name: 'Auto-populated outward liability verified', description: 'This figure is locked and cannot be edited in 3B.', requirement: 'REQUIRED', kind: 'ACTION' },
      { name: 'GSTR-1A filed to correct liability', description: 'Applies when a mismatch is found — the only same-period correction route.', requirement: 'CONDITIONAL', kind: 'ACTION' },
      { name: 'Reverse charge liability computed', requirement: 'REQUIRED', kind: 'ACTION' },
      { name: 'Ineligible ITC reversal computed', requirement: 'REQUIRED', kind: 'ACTION' },
      { name: 'Net tax payable computed', requirement: 'REQUIRED', kind: 'ACTION' },
      { name: 'Cash and credit ledger balances checked', requirement: 'REQUIRED', kind: 'ACTION' },
    ],
  },
  {
    name: 'Payment',
    stage: 'PAYMENT',
    items: [
      { name: 'Challan generated and paid', description: 'Applies when cash is payable after ITC set-off.', requirement: 'CONDITIONAL', kind: 'DOCUMENT' },
    ],
  },
  {
    name: 'Filing',
    stage: 'FILING',
    items: [
      { name: 'Manager review completed', requirement: 'REQUIRED', kind: 'ACTION' },
      { name: 'Filed on GST portal', description: 'Gated on stages 1–3 complete.', requirement: 'REQUIRED', kind: 'ACTION' },
      { name: 'ARN captured', requirement: 'REQUIRED', kind: 'INFO' },
      { name: 'Filed return PDF saved', requirement: 'REQUIRED', kind: 'DOCUMENT' },
    ],
  },
];

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
