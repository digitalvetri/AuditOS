/**
 * JNS ACCOUNTING SOLUTIONS — SERVICE MASTER (scope of work), as supplied in
 * JNS_Service_Master_Scope_of_Work.docx. Generated from that document; each
 * activity is its own selectable scope item. Category, billing frequency and
 * the link to a Workstation service (serviceCodes) are defaults the firm can
 * change in Engagement letters → Service master.
 *
 * Seeded create-only by code: a firm's later edits are never overwritten.
 */
export type ServiceItemKind = 'scope' | 'deliverable' | 'responsibility' | 'exclusion' | 'note'
export interface ServiceMasterSeed {
  code: string
  category: string
  name: string
  billingFrequency: string
  /** Workstation Service codes this may correspond to, first existing one wins. */
  serviceCodes: string[]
  items: { kind: ServiceItemKind; content: string }[]
}

export const JNS_SERVICE_MASTER: ServiceMasterSeed[] = [
  {
    code: "JNS_GST_RETURNS",
    category: "GST",
    name: "GST Return Filing & Compliance",
    billingFrequency: "Monthly",
    serviceCodes: ["GST_FILING"],
    items: [
      {
        kind: "scope",
        content: "Review sales invoices and outward-supply details provided by the client."
      },
      {
        kind: "scope",
        content: "Prepare and file GSTR-1 based on records and information supplied by the client."
      },
      {
        kind: "scope",
        content: "Review purchase details and assess reported Input Tax Credit (ITC) information available from the GST portal."
      },
      {
        kind: "scope",
        content: "Reconcile the purchase register with GSTR-2B and identify apparent differences for client clarification."
      },
      {
        kind: "scope",
        content: "Prepare and file GSTR-3B based on reconciled information and client-approved tax workings."
      },
      {
        kind: "scope",
        content: "Compute GST liability and eligible ITC based on documents and applicable provisions."
      },
      {
        kind: "scope",
        content: "Review Electronic Cash Ledger and Electronic Credit Ledger balances."
      },
      {
        kind: "scope",
        content: "Inform the client of GST payable, payment requirements and applicable filing due dates."
      },
      {
        kind: "scope",
        content: "Identify differences between books of account and GST returns based on records made available."
      },
      {
        kind: "scope",
        content: "Maintain copies of filed returns, challans and acknowledgements."
      },
      {
        kind: "deliverable",
        content: "Filed GSTR-1 and GSTR-3B, as applicable, with filing acknowledgements and tax-payment details."
      },
      {
        kind: "responsibility",
        content: "Provide complete sales, purchase, debit/credit note and expense records within the agreed cut-off date."
      },
      {
        kind: "responsibility",
        content: "Provide access to GST portal information and promptly share OTPs or complete prescribed authentication where required."
      },
      {
        kind: "responsibility",
        content: "Review and approve tax workings and arrange payment of tax before the statutory due date."
      },
      {
        kind: "responsibility",
        content: "Inform JNS of changes in business activities, registrations, branches or transaction types."
      },
      {
        kind: "exclusion",
        content: "GST notices, adjudication proceedings, departmental representation and appeals."
      },
      {
        kind: "exclusion",
        content: "Refund applications and refund follow-up."
      },
      {
        kind: "exclusion",
        content: "Annual return GSTR-9 and reconciliation statement GSTR-9C."
      },
      {
        kind: "exclusion",
        content: "Detailed GST audit, forensic review or transaction-level investigation."
      },
      {
        kind: "exclusion",
        content: "Amendments to prior-period returns or correction work beyond routine filing."
      }
    ]
  },
  {
    code: "JNS_GST_ADVISORY",
    category: "GST",
    name: "GST Advisory & Compliance Support",
    billingFrequency: "Monthly",
    serviceCodes: [],
    items: [
      {
        kind: "scope",
        content: "Provide guidance on GST applicability to business transactions based on facts and documents shared by the client."
      },
      {
        kind: "scope",
        content: "Advise on HSN/SAC classification and applicable GST rates, subject to the nature and description of the goods or services."
      },
      {
        kind: "scope",
        content: "Provide guidance on Reverse Charge Mechanism (RCM) applicability."
      },
      {
        kind: "scope",
        content: "Advise on Input Tax Credit eligibility, restrictions and documentation requirements."
      },
      {
        kind: "scope",
        content: "Review GST treatment of selected sales, purchases and expense transactions."
      },
      {
        kind: "scope",
        content: "Provide guidance on e-invoicing and e-way bill requirements, where applicable."
      },
      {
        kind: "scope",
        content: "Clarify routine GST compliance requirements, filing procedures and statutory due dates."
      },
      {
        kind: "scope",
        content: "Provide guidance on GST-related accounting entries and ledger treatment."
      },
      {
        kind: "scope",
        content: "Discuss GST compliance issues identified during routine accounting or return preparation."
      },
      {
        kind: "exclusion",
        content: "Formal legal opinions, advance rulings, litigation strategy and representation before authorities."
      },
      {
        kind: "exclusion",
        content: "Drafting replies to notices, appeals, writs or other contested proceedings unless separately agreed."
      },
      {
        kind: "exclusion",
        content: "Detailed transaction-by-transaction review of all historical periods."
      },
      {
        kind: "note",
        content: "Advisory is based on the facts and documents made available. Any material change in facts may affect the advice."
      }
    ]
  },
  {
    code: "JNS_GST_ANNUAL",
    category: "GST",
    name: "GST Annual Return Filing",
    billingFrequency: "Yearly",
    serviceCodes: [],
    items: [
      {
        kind: "scope",
        content: "Collect and review annual sales, purchase, expense and input-tax-credit registers."
      },
      {
        kind: "scope",
        content: "Reconcile annual turnover with GSTR-1 and GSTR-3B filed during the financial year."
      },
      {
        kind: "scope",
        content: "Reconcile ITC as per books with GSTR-2B and relevant GST records."
      },
      {
        kind: "scope",
        content: "Identify differences in outward tax liability, ITC, credit notes, advances and other reportable items."
      },
      {
        kind: "scope",
        content: "Prepare annual GST reconciliation and seek client clarification on unresolved differences."
      },
      {
        kind: "scope",
        content: "Prepare GSTR-9, where applicable and based on the client's eligibility and records."
      },
      {
        kind: "scope",
        content: "Prepare GSTR-9C, where applicable and based on the applicable statutory requirements."
      },
      {
        kind: "scope",
        content: "File the applicable annual return/reconciliation statement after client review and approval."
      },
      {
        kind: "scope",
        content: "Provide filing acknowledgements and a copy of the final reconciliation, where prepared."
      },
      {
        kind: "responsibility",
        content: "Provide complete year-end books, audited/unaudited financial statements as applicable, GST returns and reconciliations."
      },
      {
        kind: "responsibility",
        content: "Review the reconciliation and confirm factual correctness before filing."
      },
      {
        kind: "exclusion",
        content: "Rectification of underlying books and historical GST returns unless separately agreed."
      },
      {
        kind: "exclusion",
        content: "GST audit, departmental audit representation, notices, appeals and refund claims."
      },
      {
        kind: "exclusion",
        content: "Certification or assurance beyond the scope expressly agreed."
      }
    ]
  },
  {
    code: "JNS_TDS_RETURNS",
    category: "TDS / TCS",
    name: "TDS Return Filing – Quarterly",
    billingFrequency: "Quarterly",
    serviceCodes: ["TDS_FILING"],
    items: [
      {
        kind: "scope",
        content: "Review expense ledgers, payment records and information provided to identify transactions potentially attracting TDS."
      },
      {
        kind: "scope",
        content: "Identify applicable TDS sections, thresholds and rates based on the nature of payment and available information."
      },
      {
        kind: "scope",
        content: "Verify deductee PAN details and relevant master data supplied by the client."
      },
      {
        kind: "scope",
        content: "Compute and reconcile TDS deductions with the books of account and payment records."
      },
      {
        kind: "scope",
        content: "Verify challan details, payment dates and challan identification numbers."
      },
      {
        kind: "scope",
        content: "Prepare and file applicable quarterly TDS statements, including Form 24Q, Form 26Q and Form 27Q, as relevant."
      },
      {
        kind: "scope",
        content: "Review processing status and available defaults/intimations after filing."
      },
      {
        kind: "scope",
        content: "Assist with downloading Form 16 / Form 16A, where applicable and enabled."
      },
      {
        kind: "scope",
        content: "Maintain copies of filed statements, challans and acknowledgements."
      },
      {
        kind: "responsibility",
        content: "Provide complete vendor/employee payment data, PAN details, deduction details and challans within agreed timelines."
      },
      {
        kind: "responsibility",
        content: "Ensure TDS is deducted and deposited within statutory timelines and fund the challan payments."
      },
      {
        kind: "exclusion",
        content: "Correction statements for earlier quarters, unless specifically included."
      },
      {
        kind: "exclusion",
        content: "Representation in TDS assessment, prosecution or other proceedings."
      },
      {
        kind: "exclusion",
        content: "Rectification applications and detailed resolution of defaults beyond routine review."
      }
    ]
  },
  {
    code: "JNS_TCS_RETURNS",
    category: "TDS / TCS",
    name: "TCS Return Filing – Quarterly",
    billingFrequency: "Quarterly",
    serviceCodes: [],
    items: [
      {
        kind: "scope",
        content: "Review sales transactions and other records provided to identify transactions potentially attracting TCS."
      },
      {
        kind: "scope",
        content: "Identify applicable TCS provisions, thresholds and rates based on transaction details."
      },
      {
        kind: "scope",
        content: "Verify customer PAN details and other required information."
      },
      {
        kind: "scope",
        content: "Compute TCS liability and reconcile collections with books of account."
      },
      {
        kind: "scope",
        content: "Reconcile TCS collected with challan payments and relevant payment records."
      },
      {
        kind: "scope",
        content: "Prepare and file quarterly Form 27EQ, where applicable."
      },
      {
        kind: "scope",
        content: "Review return processing status and available defaults/intimations."
      },
      {
        kind: "scope",
        content: "Assist with downloading Form 27D certificates, where applicable and enabled."
      },
      {
        kind: "scope",
        content: "Maintain copies of filed statements, challans and acknowledgements."
      },
      {
        kind: "responsibility",
        content: "Provide complete sales data, customer PAN details, TCS collection details and challan information within agreed timelines."
      },
      {
        kind: "responsibility",
        content: "Ensure TCS is collected and deposited within applicable statutory timelines."
      },
      {
        kind: "exclusion",
        content: "Correction statements for earlier quarters, notices, representation and proceedings unless separately agreed."
      }
    ]
  },
  {
    code: "JNS_TDS_ADVISORY",
    category: "TDS / TCS",
    name: "TDS Compliance & Advisory",
    billingFrequency: "Monthly",
    serviceCodes: ["TDS"],
    items: [
      {
        kind: "scope",
        content: "Review the nature of business payments and identify TDS provisions that may apply."
      },
      {
        kind: "scope",
        content: "Provide guidance on applicable deduction rates, thresholds and timing of deduction."
      },
      {
        kind: "scope",
        content: "Provide guidance on TDS deposit and return filing timelines."
      },
      {
        kind: "scope",
        content: "Review TDS payable and receivable ledger balances based on records supplied."
      },
      {
        kind: "scope",
        content: "Identify apparent short deductions, non-deductions or delayed deposits for client attention."
      },
      {
        kind: "scope",
        content: "Provide guidance on TDS accounting entries and reconciliation procedures."
      },
      {
        kind: "scope",
        content: "Assist with routine TDS compliance queries and process improvements."
      },
      {
        kind: "exclusion",
        content: "Preparation of correction statements, detailed historical reviews, notices, appeals and departmental representation unless separately agreed."
      }
    ]
  },
  {
    code: "JNS_PVT_LTD_INC",
    category: "Incorporation",
    name: "Private Limited Company Incorporation",
    billingFrequency: "One-time",
    serviceCodes: ["PVT_LTD_INCORPORATION", "COMPANY_INCORPORATION"],
    items: [
      {
        kind: "scope",
        content: "Discuss the proposed business activities, ownership structure and incorporation requirements."
      },
      {
        kind: "scope",
        content: "Guide the promoters on proposed company name options and name-availability requirements."
      },
      {
        kind: "scope",
        content: "Assist in determining proposed authorised and paid-up share capital based on promoter instructions."
      },
      {
        kind: "scope",
        content: "Collect and review identity, address and other prescribed documents of proposed directors and subscribers."
      },
      {
        kind: "scope",
        content: "Coordinate Digital Signature Certificate (DSC) requirements for proposed directors/subscribers, wherever required."
      },
      {
        kind: "scope",
        content: "Prepare incorporation documentation, declarations and related information based on details approved by the promoters."
      },
      {
        kind: "scope",
        content: "Prepare and file SPICe+ incorporation application and applicable linked forms with the Ministry of Corporate Affairs (MCA)."
      },
      {
        kind: "scope",
        content: "Prepare and file e-MOA (INC-33) and e-AOA (INC-34), wherever applicable."
      },
      {
        kind: "scope",
        content: "Prepare and file AGILE-PRO-S and other applicable linked registration forms, based on eligibility and client instructions."
      },
      {
        kind: "scope",
        content: "Monitor the application and coordinate responses to routine MCA resubmission or clarification requirements within the agreed scope."
      },
      {
        kind: "scope",
        content: "Follow up with the Registrar of Companies until the incorporation application is disposed of."
      },
      {
        kind: "scope",
        content: "Provide the Certificate of Incorporation, CIN and PAN/TAN details when issued or made available."
      },
      {
        kind: "scope",
        content: "Explain initial post-incorporation requirements and compliance timelines."
      },
      {
        kind: "scope",
        content: "Provide guidance on commencement of business filing (INC-20A), where applicable; filing is included only if expressly stated in the fee proposal."
      },
      {
        kind: "responsibility",
        content: "Promoters must provide accurate documents, declarations, proposed business details and approvals promptly."
      },
      {
        kind: "responsibility",
        content: "Promoters are responsible for the commercial decisions, shareholding, capital structure and contents approved for filing."
      },
      {
        kind: "exclusion",
        content: "Government filing fees, stamp duty, DSC charges and third-party charges unless expressly included."
      },
      {
        kind: "exclusion",
        content: "Share certificates, statutory registers, share allotment/transfer work and ongoing secretarial records."
      },
      {
        kind: "exclusion",
        content: "Appointment of auditor, commencement of business filing, annual MCA filings and other post-incorporation compliances unless specifically included."
      },
      {
        kind: "exclusion",
        content: "GST registration, professional tax and other separate registrations unless selected separately."
      },
      {
        kind: "note",
        content: "Incorporation approval is subject to MCA/ROC scrutiny and statutory requirements; JNS cannot guarantee approval or a specific processing timeline."
      }
    ]
  },
  {
    code: "JNS_LLP_INC",
    category: "Incorporation",
    name: "LLP Incorporation",
    billingFrequency: "One-time",
    serviceCodes: ["LLP_REGISTRATION"],
    items: [
      {
        kind: "scope",
        content: "Discuss proposed business activities, partner structure and incorporation requirements."
      },
      {
        kind: "scope",
        content: "Guide the promoters on LLP name selection and name-availability requirements."
      },
      {
        kind: "scope",
        content: "Collect and review identity, address and other prescribed documents of proposed partners/designated partners."
      },
      {
        kind: "scope",
        content: "Assist with DSC requirements for designated partners, wherever required."
      },
      {
        kind: "scope",
        content: "Prepare incorporation details, declarations and supporting documents based on partner-approved information."
      },
      {
        kind: "scope",
        content: "Determine proposed contribution and profit-sharing ratio based on instructions from the partners."
      },
      {
        kind: "scope",
        content: "Prepare and file FiLLiP incorporation form and applicable linked forms with MCA."
      },
      {
        kind: "scope",
        content: "Monitor the application and coordinate responses to routine MCA resubmission or clarification requirements within the agreed scope."
      },
      {
        kind: "scope",
        content: "Follow up with MCA until the incorporation application is disposed of."
      },
      {
        kind: "scope",
        content: "Provide the Certificate of Incorporation and LLP Identification Number when issued."
      },
      {
        kind: "scope",
        content: "Prepare the LLP Agreement based on commercial terms approved by the partners."
      },
      {
        kind: "scope",
        content: "Assist in filing Form 3 for the LLP Agreement, where included in the agreed package."
      },
      {
        kind: "scope",
        content: "Explain initial and recurring LLP compliance requirements."
      },
      {
        kind: "responsibility",
        content: "Partners must provide accurate KYC documents and approve contribution, profit-sharing and governance terms."
      },
      {
        kind: "responsibility",
        content: "Partners are responsible for reviewing and signing the LLP Agreement and prescribed declarations."
      },
      {
        kind: "exclusion",
        content: "Government fees, stamp duty, DSC and third-party charges unless expressly included."
      },
      {
        kind: "exclusion",
        content: "GST and other separate registrations."
      },
      {
        kind: "exclusion",
        content: "Annual LLP filings (Form 8 and Form 11), partner changes, contribution changes or later LLP Agreement amendments unless separately engaged."
      }
    ]
  },
  {
    code: "JNS_GST_REG",
    category: "Registration",
    name: "GST Registration",
    billingFrequency: "One-time",
    serviceCodes: ["GST_REGISTRATION"],
    items: [
      {
        kind: "scope",
        content: "Understand the nature of business and assess the GST registration requirement based on information provided."
      },
      {
        kind: "scope",
        content: "Identify the appropriate registration category and type, subject to applicable GST provisions."
      },
      {
        kind: "scope",
        content: "Collect and review PAN, Aadhaar, business address proof, constitution documents, bank details and other required documents."
      },
      {
        kind: "scope",
        content: "Determine principal place of business and additional places of business based on client instructions and supporting records."
      },
      {
        kind: "scope",
        content: "Identify relevant HSN/SAC details based on the business activities described by the client."
      },
      {
        kind: "scope",
        content: "Prepare and submit GST REG-01 application on the GST portal."
      },
      {
        kind: "scope",
        content: "Coordinate Aadhaar authentication or other prescribed verification, where applicable."
      },
      {
        kind: "scope",
        content: "Monitor application status and communicate any clarification or document requirement."
      },
      {
        kind: "scope",
        content: "Assist with routine responses to registration clarification notices within the agreed scope."
      },
      {
        kind: "scope",
        content: "Follow up until the application is approved or otherwise disposed of."
      },
      {
        kind: "scope",
        content: "Download and provide the GST Registration Certificate when issued."
      },
      {
        kind: "scope",
        content: "Explain initial GST compliance requirements, return frequency and key due dates."
      },
      {
        kind: "exclusion",
        content: "Post-registration return filing, advisory, amendment, cancellation and refund applications unless separately selected."
      },
      {
        kind: "exclusion",
        content: "Representation in contested proceedings or complex registration disputes."
      }
    ]
  },
  {
    code: "JNS_GST_AMEND",
    category: "Registration",
    name: "GST Amendment / Cancellation",
    billingFrequency: "One-time",
    serviceCodes: [],
    items: [
      {
        kind: "scope",
        content: "Review the existing GST registration particulars and identify the amendment/cancellation requested by the client."
      },
      {
        kind: "scope",
        content: "Identify the prescribed application and supporting documents required for the proposed change."
      },
      {
        kind: "scope",
        content: "Collect and review supporting documents for changes to legal name, trade name, address, partners, directors or other registration particulars, as applicable."
      },
      {
        kind: "scope",
        content: "Prepare and file the relevant GST amendment application on the GST portal."
      },
      {
        kind: "scope",
        content: "Monitor the application status and communicate any clarification or document requirement."
      },
      {
        kind: "scope",
        content: "Assist with routine responses to queries within the agreed scope."
      },
      {
        kind: "scope",
        content: "Where cancellation is engaged, prepare and file the applicable cancellation application based on client instructions."
      },
      {
        kind: "scope",
        content: "Communicate the status and provide available application acknowledgements or orders."
      },
      {
        kind: "responsibility",
        content: "Client must provide accurate details, supporting documents and confirmation of the effective date of change or closure."
      },
      {
        kind: "exclusion",
        content: "Final return preparation and filing, pending return filing, tax payment, revocation of cancellation and appeals unless specifically included."
      }
    ]
  },
  {
    code: "JNS_BOOKKEEPING",
    category: "Accounting",
    name: "Monthly Bookkeeping & Accounting",
    billingFrequency: "Monthly",
    serviceCodes: ["BOOKKEEPING"],
    items: [
      {
        kind: "scope",
        content: "Collect monthly sales invoices, purchase invoices, expense bills, bank statements and other accounting records."
      },
      {
        kind: "scope",
        content: "Record sales and revenue transactions in the agreed accounting software."
      },
      {
        kind: "scope",
        content: "Record purchases and operating expenses based on supporting documents."
      },
      {
        kind: "scope",
        content: "Record receipts, payments and bank transactions."
      },
      {
        kind: "scope",
        content: "Pass routine journal and adjustment entries based on information and supporting documents supplied."
      },
      {
        kind: "scope",
        content: "Prepare bank reconciliations for the bank accounts covered by the engagement."
      },
      {
        kind: "scope",
        content: "Reconcile cash transactions and cash balances based on records made available."
      },
      {
        kind: "scope",
        content: "Maintain and review customer and supplier ledgers."
      },
      {
        kind: "scope",
        content: "Reconcile debtors and creditors and highlight material differences."
      },
      {
        kind: "scope",
        content: "Review GST input and output ledger balances with available GST records, to the extent included in the agreed bookkeeping scope."
      },
      {
        kind: "scope",
        content: "Record fixed asset additions and depreciation entries based on the agreed accounting policy and information provided."
      },
      {
        kind: "scope",
        content: "Identify missing documents, apparent duplicate entries and unusual transactions for client clarification."
      },
      {
        kind: "scope",
        content: "Review outstanding receivables and payables based on accounting records."
      },
      {
        kind: "scope",
        content: "Maintain books of account in the agreed accounting software."
      },
      {
        kind: "scope",
        content: "Prepare monthly trial balance and, where agreed, monthly Profit & Loss Account and Balance Sheet."
      },
      {
        kind: "responsibility",
        content: "Submit complete and accurate records within the agreed monthly cut-off date."
      },
      {
        kind: "responsibility",
        content: "Provide explanations for unidentified bank transactions and unusual entries."
      },
      {
        kind: "responsibility",
        content: "Share details of loans, advances, fixed assets, stock and other material transactions."
      },
      {
        kind: "responsibility",
        content: "Review periodic reports and communicate corrections promptly."
      },
      {
        kind: "exclusion",
        content: "GST/TDS/TCS return filing unless separately selected."
      },
      {
        kind: "exclusion",
        content: "Statutory audit, tax audit, certification and legal representation."
      },
      {
        kind: "exclusion",
        content: "Physical inventory verification, payroll processing and detailed MIS reporting unless separately selected."
      },
      {
        kind: "exclusion",
        content: "Financial projections, CMA data and project reports unless separately selected."
      }
    ]
  },
  {
    code: "JNS_MIS",
    category: "Accounting",
    name: "Monthly MIS Submission",
    billingFrequency: "Monthly",
    serviceCodes: [],
    items: [
      {
        kind: "scope",
        content: "Collect financial data and accounting reports for the agreed reporting period."
      },
      {
        kind: "scope",
        content: "Prepare monthly sales and revenue analysis."
      },
      {
        kind: "scope",
        content: "Prepare purchase and expense analysis."
      },
      {
        kind: "scope",
        content: "Prepare gross profit and net profit analysis, based on available books."
      },
      {
        kind: "scope",
        content: "Prepare customer-wise sales analysis, where data is available."
      },
      {
        kind: "scope",
        content: "Prepare supplier-wise purchase analysis, where data is available."
      },
      {
        kind: "scope",
        content: "Prepare debtor ageing and outstanding receivables report."
      },
      {
        kind: "scope",
        content: "Prepare creditor ageing and outstanding payables report."
      },
      {
        kind: "scope",
        content: "Prepare cash and bank balance summary."
      },
      {
        kind: "scope",
        content: "Prepare stock and inventory movement/summary reports based on available inventory records."
      },
      {
        kind: "scope",
        content: "Compare actual performance with previous months or agreed budgets, where comparable data is available."
      },
      {
        kind: "scope",
        content: "Prepare expense comparison and highlight significant variations."
      },
      {
        kind: "scope",
        content: "Prepare monthly Profit & Loss summary and agreed key financial indicators."
      },
      {
        kind: "scope",
        content: "Highlight unusual financial movements and matters requiring management attention."
      },
      {
        kind: "scope",
        content: "Submit the consolidated monthly MIS report to management."
      },
      {
        kind: "deliverable",
        content: "Monthly sales and purchase analysis."
      },
      {
        kind: "deliverable",
        content: "Income and expense analysis."
      },
      {
        kind: "deliverable",
        content: "Debtors and creditors ageing reports."
      },
      {
        kind: "deliverable",
        content: "Cash and bank summary."
      },
      {
        kind: "deliverable",
        content: "Stock summary, where applicable and supported by records."
      },
      {
        kind: "deliverable",
        content: "Profit & Loss summary and financial performance comparison."
      },
      {
        kind: "deliverable",
        content: "Management observations and exception highlights."
      },
      {
        kind: "exclusion",
        content: "Physical stock verification, independent audit procedures and certification."
      },
      {
        kind: "exclusion",
        content: "Preparation of underlying books of account unless bookkeeping is also engaged."
      },
      {
        kind: "exclusion",
        content: "Budgeting, forecasting and detailed business consulting unless separately agreed."
      },
      {
        kind: "note",
        content: "MIS is prepared from the books and information made available. The reliability of the reports depends on the completeness and accuracy of the underlying records."
      }
    ]
  },
  {
    code: "JNS_IA_MONTHLY",
    category: "Internal audit & review",
    name: "Monthly Internal Audit",
    billingFrequency: "Monthly",
    serviceCodes: [],
    items: [
      {
        kind: "scope",
        content: "Sales and revenue verification: examine selected sales invoices and supporting documents; compare sales entries with accounting records; review sales returns, credit notes, discounts and period cut-off; identify apparent unrecorded or unusual sales."
      },
      {
        kind: "scope",
        content: "Purchase and expense verification: examine selected purchase invoices and expense bills; review supporting approvals; identify duplicate, incorrect or unsupported expenses; review significant expense variations."
      },
      {
        kind: "scope",
        content: "Cash and bank verification: review cash book balances and bank reconciliations; identify unreconciled items; examine selected major cash receipts and payments; review cash handling controls."
      },
      {
        kind: "scope",
        content: "Debtors and creditors verification: review customer and supplier outstanding balances; identify overdue receivables and payables; examine advances, adjustments and unusual ledger balances."
      },
      {
        kind: "scope",
        content: "Inventory and stock review: review stock records and movements; examine purchase, sales and adjustment entries; identify negative stock, unusual movements, ageing and slow-moving items based on available reports."
      },
      {
        kind: "scope",
        content: "GST and statutory compliance review: review return filing status; compare sales as per books with GST returns; review purchase ITC with GSTR-2B; review TDS deduction/payment status and statutory due dates within the agreed scope."
      },
      {
        kind: "scope",
        content: "Accounting and internal control review: examine ledger classifications, journal entries and supporting documents for selected significant transactions; review approval procedures and identify control weaknesses."
      },
      {
        kind: "scope",
        content: "Prepare monthly internal audit observations and classify findings by risk and potential financial impact."
      },
      {
        kind: "scope",
        content: "Identify potential financial leakages and recommend corrective actions."
      },
      {
        kind: "scope",
        content: "Submit the monthly internal audit report to management."
      },
      {
        kind: "scope",
        content: "Follow up on previous month's observations and action points."
      },
      {
        kind: "deliverable",
        content: "Monthly internal audit report containing scope performed, observations, risk/priority, recommendations and management action points."
      },
      {
        kind: "deliverable",
        content: "Follow-up status of prior observations, where applicable."
      },
      {
        kind: "responsibility",
        content: "Provide access to books, records, invoices, vouchers, policies and relevant personnel."
      },
      {
        kind: "responsibility",
        content: "Make records and explanations available within agreed timelines."
      },
      {
        kind: "responsibility",
        content: "Management remains responsible for internal controls, prevention/detection of fraud and implementation of recommendations."
      },
      {
        kind: "exclusion",
        content: "Statutory audit, tax audit, certification or an opinion on the financial statements."
      },
      {
        kind: "exclusion",
        content: "Fraud investigation, forensic audit or exhaustive verification of every transaction unless separately agreed."
      },
      {
        kind: "exclusion",
        content: "Physical stock or fixed asset verification unless expressly included."
      },
      {
        kind: "exclusion",
        content: "Legal opinion, litigation support and departmental representation."
      },
      {
        kind: "note",
        content: "The extent of testing, sampling, locations, transaction coverage and physical verification must be specified in the engagement-specific scope. Internal audit does not guarantee detection of every error or fraud."
      }
    ]
  },
  {
    code: "JNS_IA_QUARTERLY",
    category: "Internal audit & review",
    name: "Quarterly Internal Audit",
    billingFrequency: "Quarterly",
    serviceCodes: [],
    items: [
      {
        kind: "scope",
        content: "Financial transaction review: review quarterly sales, purchases, expenses and income; examine selected transactions with supporting documents; review unusual, high-value and exceptional transactions; check accounting classifications and significant variations."
      },
      {
        kind: "scope",
        content: "Revenue and collection audit: review revenue recording and cut-off; examine selected invoices and credit notes; review collection efficiency, overdue receivables, discounts and credit practices."
      },
      {
        kind: "scope",
        content: "Purchase and payment audit: review vendor selection and purchase approvals; examine purchase orders, invoices and goods receipt records where maintained; review supplier payments, outstanding balances and possible duplicate or excess payments."
      },
      {
        kind: "scope",
        content: "Inventory and asset audit: review stock records, inventory reconciliation, ageing and slow-moving items; review fixed asset records; conduct physical verification only where specifically included."
      },
      {
        kind: "scope",
        content: "Statutory compliance review: review GST, TDS/TCS, PF/ESI and other applicable compliance status within the agreed scope; identify pending obligations and potential non-compliances based on records supplied."
      },
      {
        kind: "scope",
        content: "Internal control and process review: examine purchase, sales, payment, cash and bank approval processes; review documentation and record maintenance; identify control gaps and process inefficiencies."
      },
      {
        kind: "scope",
        content: "Financial analysis: review quarterly Profit & Loss Account; compare with previous periods and available budgets; analyse gross and net margins, working capital, debtor and creditor movements and unusual trends."
      },
      {
        kind: "scope",
        content: "Prepare a consolidated quarterly internal audit report and present significant observations to management."
      },
      {
        kind: "scope",
        content: "Classify findings by risk and provide recommendations and corrective action points."
      },
      {
        kind: "scope",
        content: "Discuss major observations with management and follow up on earlier audit findings."
      },
      {
        kind: "deliverable",
        content: "Quarterly internal audit report with scope, observations, risk classification and recommendations."
      },
      {
        kind: "deliverable",
        content: "Quarterly financial and compliance observations, within the agreed scope."
      },
      {
        kind: "deliverable",
        content: "Management discussion/action-point summary and follow-up status."
      },
      {
        kind: "responsibility",
        content: "Provide complete quarterly books, supporting documents, reconciliations and access to relevant personnel."
      },
      {
        kind: "responsibility",
        content: "Management is responsible for internal controls and for deciding on and implementing corrective actions."
      },
      {
        kind: "exclusion",
        content: "Statutory audit, tax audit, certification and financial statement opinion."
      },
      {
        kind: "exclusion",
        content: "Fraud investigation or forensic audit unless separately engaged."
      },
      {
        kind: "exclusion",
        content: "Physical stock/fixed asset verification unless expressly included."
      },
      {
        kind: "exclusion",
        content: "Legal representation and contested tax or regulatory proceedings."
      },
      {
        kind: "note",
        content: "Quarterly work may involve broader period analysis and risk-based testing than monthly work. Exact sample sizes, locations, transaction coverage and physical checks should be agreed in writing."
      }
    ]
  },
  {
    code: "JNS_HEALTH_CHECK",
    category: "Internal audit & review",
    name: "Business Health Check",
    billingFrequency: "One-time",
    serviceCodes: [],
    items: [
      {
        kind: "scope",
        content: "Financial performance analysis: review Profit & Loss Account and Balance Sheet; analyse sales growth, revenue trends, gross and net profit margins; compare performance with previous periods; identify unusual expense movements."
      },
      {
        kind: "scope",
        content: "Cash flow and working capital analysis: review cash and bank balances; analyse operating cash flow; review debtor collection and creditor payment periods; assess working capital requirements and identify cash flow gaps."
      },
      {
        kind: "scope",
        content: "Debtors and creditors health check: analyse customer and supplier balances; identify overdue and long-pending receivables; review customer-wise credit exposure; identify possible bad debts and collection-process improvements."
      },
      {
        kind: "scope",
        content: "Expense and cost analysis: review major operating expenses; identify avoidable costs; compare expense trends; analyse direct and indirect costs; highlight cost optimisation opportunities."
      },
      {
        kind: "scope",
        content: "Inventory and stock analysis: review stock holding levels, ageing and inventory turnover; identify slow-moving, non-moving or excess stock; review inventory controls based on available records."
      },
      {
        kind: "scope",
        content: "Tax and statutory compliance health check: review GST return filing status, GST liability and ITC reconciliation; review TDS/TCS compliance; review income tax and applicable PF/ESI compliance status; identify pending filings, payments and potential exposures based on records supplied."
      },
      {
        kind: "scope",
        content: "Business process and internal control review: review sales, purchase, payment and accounting processes; examine approval systems and documentation; identify possible revenue leakages and operational inefficiencies."
      },
      {
        kind: "scope",
        content: "Financial risk assessment: identify liquidity and working capital risks, high-risk transactions and dependency on major customers or suppliers."
      },
      {
        kind: "scope",
        content: "Prepare an overall business financial health check report."
      },
      {
        kind: "scope",
        content: "Highlight critical matters requiring management attention and provide recommendations to improve profitability, cash flow and controls."
      },
      {
        kind: "scope",
        content: "Prepare a practical action plan and discuss findings with business owners/management."
      },
      {
        kind: "deliverable",
        content: "Business health check report with key financial indicators and observations."
      },
      {
        kind: "deliverable",
        content: "Priority-wise risk and improvement areas."
      },
      {
        kind: "deliverable",
        content: "Recommendations for cost optimisation, cash flow and profitability improvement."
      },
      {
        kind: "deliverable",
        content: "Management action plan and discussion of findings."
      },
      {
        kind: "responsibility",
        content: "Provide complete and accurate financial statements, books, statutory records and operational information."
      },
      {
        kind: "responsibility",
        content: "Make management and relevant personnel available for discussions."
      },
      {
        kind: "responsibility",
        content: "Management remains responsible for business decisions and implementation of recommendations."
      },
      {
        kind: "exclusion",
        content: "Statutory audit, tax audit, certification or assurance opinion."
      },
      {
        kind: "exclusion",
        content: "Detailed forensic investigation, fraud investigation or legal opinion."
      },
      {
        kind: "exclusion",
        content: "Physical stock verification unless specifically included."
      },
      {
        kind: "exclusion",
        content: "Implementation of recommendations, restructuring, fundraising or detailed financial projections unless separately agreed."
      },
      {
        kind: "note",
        content: "A business health check is a diagnostic review based on information made available and is not a statutory audit or guarantee of future business performance."
      }
    ]
  }
]
