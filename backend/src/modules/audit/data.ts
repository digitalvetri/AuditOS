/**
 * AUDIT FILES — reference data: the default working-paper index seeded on a
 * new file, and the four checklist templates seeded by prisma/seed-audit.ts.
 *
 * Checklist headings are short descriptions, not the statutory text. Read
 * the Order / the form for the exact wording.
 */

export const AUDIT_TYPES = ['statutory', 'tax', 'internal', 'stock', 'bank', 'gst', 'concurrent', 'other'] as const
export type AuditType = (typeof AUDIT_TYPES)[number]

export const AUDIT_TYPE_LABEL: Record<AuditType, string> = {
  statutory: 'Statutory audit',
  tax: 'Tax audit',
  internal: 'Internal audit',
  stock: 'Stock audit',
  bank: 'Bank audit',
  gst: 'GST audit',
  concurrent: 'Concurrent audit',
  other: 'Audit',
}

export interface DefaultPaper { ref: string; section: string; title: string; area?: string }

const PLANNING: DefaultPaper[] = [
  { ref: 'A-1', section: 'planning', title: 'Engagement letter and acceptance' },
  { ref: 'A-2', section: 'planning', title: 'Independence' },
  { ref: 'A-3', section: 'planning', title: 'Understanding the entity' },
  { ref: 'A-4', section: 'planning', title: 'Materiality' },
  { ref: 'A-5', section: 'planning', title: 'Risk assessment' },
  { ref: 'A-6', section: 'planning', title: 'Audit plan' },
]
const CONTROLS: DefaultPaper[] = [
  { ref: 'B-1', section: 'risk', title: 'Internal control evaluation' },
]
const EXECUTION: DefaultPaper[] = [
  'Cash and bank', 'Trade receivables', 'Inventory', 'Property, plant and equipment',
  'Investments and loans', 'Borrowings', 'Trade payables', 'Revenue', 'Purchases and expenses',
  'Employee costs', 'Taxation', 'Equity and reserves', 'Related parties',
].map((t, i) => ({ ref: `C-${i + 1}`, section: 'execution', title: t, area: t }))
const COMPLETION: DefaultPaper[] = [
  { ref: 'D-1', section: 'completion', title: 'Subsequent events' },
  { ref: 'D-2', section: 'completion', title: 'Going concern' },
  { ref: 'D-3', section: 'completion', title: 'Management representations' },
  { ref: 'D-4', section: 'completion', title: 'Summary of misstatements' },
]
const REPORTING: DefaultPaper[] = [
  { ref: 'E-1', section: 'reporting', title: 'Draft financial statements' },
  { ref: 'E-2', section: 'reporting', title: "Auditor's report and CARO" },
  { ref: 'E-3', section: 'reporting', title: 'Signed report and UDIN' },
]
const TAX: DefaultPaper[] = [
  { ref: 'T-1', section: 'execution', title: 'Books and method of accounting' },
  { ref: 'T-2', section: 'execution', title: 'Form 3CD working' },
  { ref: 'T-3', section: 'execution', title: 'Disallowances (s.40, 40A, 43B)' },
  { ref: 'T-4', section: 'execution', title: 'TDS compliance' },
  { ref: 'T-5', section: 'execution', title: 'Depreciation' },
  { ref: 'T-6', section: 'execution', title: 'Loans and deposits (s.269SS/ST/T)' },
]

/** The working papers a new file starts with, by audit type. */
export function defaultPapers(type: string): DefaultPaper[] {
  if (type === 'statutory') return [...PLANNING, ...CONTROLS, ...EXECUTION, ...COMPLETION, ...REPORTING]
  if (type === 'tax') return [...PLANNING.slice(0, 4), ...TAX, REPORTING[2]]
  return [...PLANNING, ...COMPLETION, ...REPORTING]
}

// ── Checklist templates ─────────────────────────────────────────────────────

export interface TemplateSeed {
  code: string
  name: string
  appliesTo: string
  description: string
  source: string
  items: { clause: string; heading: string; guidance?: string }[]
}

const ALL_TYPES = AUDIT_TYPES.join(',')

const ACCEPTANCE: TemplateSeed = {
  code: 'acceptance',
  name: 'Client acceptance / continuance',
  appliesTo: ALL_TYPES,
  description: 'Acceptance or continuance of the client relationship and this engagement, approved by a partner before work starts.',
  source: 'SQC 1 (ICAI) paras 26–32; SA 210; Companies Act 2013 ss.139–141; ICAI Code of Ethics, First Schedule Part I clause (8)',
  items: [
    { clause: 'AC-1', heading: 'Integrity of the owners and management considered; no information that would lead to declining' },
    { clause: 'AC-2', heading: 'Firm has the competence, capabilities and resources (time and staff) to perform the engagement' },
    { clause: 'AC-3', heading: 'Independence of the firm and the engagement team confirmed; no prohibited services (s.144)' },
    { clause: 'AC-4', heading: 'Conflicts of interest identified and resolved' },
    { clause: 'AC-5', heading: 'Previous auditor communicated with in writing before acceptance (ICAI Code clause (8))' },
    { clause: 'AC-6', heading: 'Previous auditor’s removal / resignation compliant with s.140; no unpaid undisputed audit fees' },
    { clause: 'AC-7', heading: 'Eligibility and no disqualification under s.141; limit on number of audits (s.141(3)(g)) checked' },
    { clause: 'AC-8', heading: 'Written consent and eligibility certificate given; appointment filed in ADT-1 (s.139)' },
    { clause: 'AC-9', heading: 'Fee agreed and not contingent; fee dependence on the client considered' },
    { clause: 'AC-10', heading: 'Engagement letter issued and acknowledged by those charged with governance (SA 210)' },
    { clause: 'AC-11', heading: 'Engagement quality control review need assessed (listed / public interest entity)' },
  ],
}

const COMPLETION_TEMPLATE: TemplateSeed = {
  code: 'completion',
  name: 'Completion',
  appliesTo: ALL_TYPES,
  description: 'Matters to close before the report is signed and the file is assembled.',
  source: 'SA 230, SA 450, SA 550, SA 560, SA 570, SA 580, SA 700 / 705 / 706, SQC 1 para 60 (EQCR)',
  items: [
    { clause: 'CP-1', heading: 'All working papers prepared, reviewed and review notes cleared (SA 230)' },
    { clause: 'CP-2', heading: 'Misstatements accumulated and evaluated; uncorrected misstatements communicated (SA 450)' },
    { clause: 'CP-3', heading: 'Subsequent events up to the report date reviewed (SA 560)' },
    { clause: 'CP-4', heading: 'Going concern assessment concluded; disclosures adequate (SA 570)' },
    { clause: 'CP-5', heading: 'Related parties and transactions identified and disclosed (SA 550)' },
    { clause: 'CP-6', heading: 'Written representations obtained, dated on or near the report date (SA 580)' },
    { clause: 'CP-7', heading: 'Financial statements read for consistency with the audit findings; final analytical review done' },
    { clause: 'CP-8', heading: 'Opinion formed and modifications / emphasis of matter supported (SA 700 / 705 / 706)' },
    { clause: 'CP-9', heading: 'Engagement quality control review completed before the report date, where required' },
    { clause: 'CP-10', heading: 'Matters communicated to those charged with governance (SA 260 / 265)' },
    { clause: 'CP-11', heading: 'UDIN generated for the signed report' },
    { clause: 'CP-12', heading: 'Audit file assembled within 60 days of the report date (SA 230 para A21)' },
  ],
}

const CARO: TemplateSeed = {
  code: 'caro_2020',
  name: 'CARO 2020',
  appliesTo: 'statutory',
  description: 'Companies (Auditor’s Report) Order, 2020 — paragraph 3 matters. Mark a clause N/A where the Order or the clause does not apply.',
  source: 'Companies (Auditor’s Report) Order, 2020 — MCA notification G.S.R. 207(E), 25 Feb 2020',
  items: [
    { clause: '3(i)(a)(A)', heading: 'Proper records of property, plant and equipment' },
    { clause: '3(i)(a)(B)', heading: 'Proper records of intangible assets' },
    { clause: '3(i)(b)', heading: 'Physical verification of property, plant and equipment' },
    { clause: '3(i)(c)', heading: 'Title deeds of immovable property held in the company’s name' },
    { clause: '3(i)(d)', heading: 'Revaluation of property, plant and equipment or intangible assets' },
    { clause: '3(i)(e)', heading: 'Proceedings for benami property' },
    { clause: '3(ii)(a)', heading: 'Physical verification of inventory and discrepancies' },
    { clause: '3(ii)(b)', heading: 'Quarterly returns to banks for working capital over ₹5 crore agree with books' },
    { clause: '3(iii)', heading: 'Investments, guarantees, security, loans or advances granted' },
    { clause: '3(iii)(a)', heading: 'Aggregate loans / guarantees to subsidiaries, JVs, associates and others' },
    { clause: '3(iii)(b)', heading: 'Terms of investments, guarantees and loans not prejudicial' },
    { clause: '3(iii)(c)', heading: 'Repayment of principal and interest regular' },
    { clause: '3(iii)(d)', heading: 'Amount overdue for more than 90 days and steps for recovery' },
    { clause: '3(iii)(e)', heading: 'Loans fallen due renewed, extended or settled by fresh loans' },
    { clause: '3(iii)(f)', heading: 'Loans repayable on demand or without terms of repayment' },
    { clause: '3(iv)', heading: 'Compliance with ss.185 and 186 for loans, investments, guarantees and security' },
    { clause: '3(v)', heading: 'Deposits and deemed deposits — compliance with RBI directions and ss.73–76' },
    { clause: '3(vi)', heading: 'Maintenance of cost records under s.148(1)' },
    { clause: '3(vii)(a)', heading: 'Regular deposit of undisputed statutory dues' },
    { clause: '3(vii)(b)', heading: 'Statutory dues not deposited on account of dispute' },
    { clause: '3(viii)', heading: 'Unrecorded income surrendered or disclosed in tax assessments' },
    { clause: '3(ix)(a)', heading: 'Default in repayment of loans or interest to any lender' },
    { clause: '3(ix)(b)', heading: 'Declared a wilful defaulter by any bank, financial institution or lender' },
    { clause: '3(ix)(c)', heading: 'Term loans applied for the purpose obtained' },
    { clause: '3(ix)(d)', heading: 'Short-term funds used for long-term purposes' },
    { clause: '3(ix)(e)', heading: 'Funds taken to meet obligations of subsidiaries, associates or JVs' },
    { clause: '3(ix)(f)', heading: 'Loans raised on pledge of securities held in subsidiaries, JVs or associates' },
    { clause: '3(x)(a)', heading: 'Use of money raised by IPO / FPO (including debt instruments)' },
    { clause: '3(x)(b)', heading: 'Preferential allotment / private placement — compliance with ss.42 and 62' },
    { clause: '3(xi)(a)', heading: 'Fraud by or on the company noticed or reported' },
    { clause: '3(xi)(b)', heading: 'Report in Form ADT-4 filed under s.143(12)' },
    { clause: '3(xi)(c)', heading: 'Whistle-blower complaints received and considered' },
    { clause: '3(xii)(a)', heading: 'Nidhi company — net owned funds to deposits ratio 1:20' },
    { clause: '3(xii)(b)', heading: 'Nidhi company — 10% unencumbered term deposits maintained' },
    { clause: '3(xii)(c)', heading: 'Nidhi company — default in payment of interest or repayment of deposits' },
    { clause: '3(xiii)', heading: 'Related party transactions — compliance with ss.177 and 188 and disclosure' },
    { clause: '3(xiv)(a)', heading: 'Internal audit system commensurate with size and nature of business' },
    { clause: '3(xiv)(b)', heading: 'Internal audit reports considered by the statutory auditor' },
    { clause: '3(xv)', heading: 'Non-cash transactions with directors or connected persons — s.192' },
    { clause: '3(xvi)(a)', heading: 'Registration under s.45-IA of the RBI Act, 1934' },
    { clause: '3(xvi)(b)', heading: 'NBFC / housing finance activities without valid certificate of registration' },
    { clause: '3(xvi)(c)', heading: 'Core Investment Company — fulfils RBI criteria' },
    { clause: '3(xvi)(d)', heading: 'Number of CICs in the group' },
    { clause: '3(xvii)', heading: 'Cash losses in the year and the immediately preceding year' },
    { clause: '3(xviii)', heading: 'Resignation of the statutory auditors and issues raised by them' },
    { clause: '3(xix)', heading: 'Material uncertainty on meeting liabilities within one year' },
    { clause: '3(xx)(a)', heading: 'Unspent CSR amount (other than ongoing projects) transferred to Schedule VII fund' },
    { clause: '3(xx)(b)', heading: 'Unspent CSR amount for ongoing projects transferred to special account (s.135(6))' },
    { clause: '3(xxi)', heading: 'Qualifications / adverse remarks in CARO reports of group companies (consolidated)' },
  ],
}

const FORM_3CD: TemplateSeed = {
  code: 'form_3cd',
  name: 'Form 3CD (tax audit)',
  appliesTo: 'tax',
  description: 'Statement of particulars under s.44AB, Income-tax Act, 1961, for tax audits up to FY 2025-26. Tax years from 2026-27 fall under the Income-tax Act, 2025: add its form as a new template rather than editing this one.',
  source: 'Form 3CD, Income-tax Rules 1962, Rule 6G(2)',
  items: [
    { clause: '1', heading: 'Name of the assessee' },
    { clause: '2', heading: 'Address' },
    { clause: '3', heading: 'Permanent Account Number (PAN) / Aadhaar' },
    { clause: '4', heading: 'Registration under indirect tax laws (GST, customs, excise)' },
    { clause: '5', heading: 'Status' },
    { clause: '6', heading: 'Previous year' },
    { clause: '7', heading: 'Assessment year' },
    { clause: '8', heading: 'Relevant clause of s.44AB under which the audit is conducted' },
    { clause: '8A', heading: 'Option for taxation under s.115BA / 115BAA / 115BAB / 115BAC / 115BAD' },
    { clause: '9(a)', heading: 'Partners / members and their profit sharing ratios' },
    { clause: '9(b)', heading: 'Change in partners / members or their profit sharing ratio' },
    { clause: '10(a)', heading: 'Nature of business or profession' },
    { clause: '10(b)', heading: 'Change in the nature of business or profession' },
    { clause: '11(a)', heading: 'Books of account prescribed under s.44AA' },
    { clause: '11(b)', heading: 'Books of account maintained and the address where kept' },
    { clause: '11(c)', heading: 'Books of account and documents examined' },
    { clause: '12', heading: 'Presumptive income included in profit and loss account' },
    { clause: '13(a)', heading: 'Method of accounting employed' },
    { clause: '13(b)', heading: 'Change in method of accounting' },
    { clause: '13(c)', heading: 'Effect of change in method of accounting on profit or loss' },
    { clause: '13(d)', heading: 'Adjustments required for ICDS' },
    { clause: '13(e)', heading: 'Disclosures required by ICDS' },
    { clause: '13(f)', heading: 'Other ICDS disclosures' },
    { clause: '14(a)', heading: 'Method of valuation of closing stock' },
    { clause: '14(b)', heading: 'Deviation from s.145A method of valuation and its effect' },
    { clause: '15', heading: 'Capital asset converted into stock-in-trade' },
    { clause: '16(a)', heading: 'Items falling under s.28 not credited to profit and loss account' },
    { clause: '16(b)', heading: 'Pro forma credits, drawbacks, refunds of duty / tax admitted as due' },
    { clause: '16(c)', heading: 'Escalation claims accepted during the year' },
    { clause: '16(d)', heading: 'Any other item of income not credited' },
    { clause: '16(e)', heading: 'Capital receipt, if any' },
    { clause: '17', heading: 'Land or building transferred below stamp duty value (s.43CA / 50C)' },
    { clause: '18', heading: 'Depreciation allowable under the Act' },
    { clause: '19', heading: 'Amounts admissible under ss.32AC to 35E' },
    { clause: '20(a)', heading: 'Bonus or commission to employees in lieu of profit — s.36(1)(ii)' },
    { clause: '20(b)', heading: 'Employees’ contributions to PF and other funds — s.36(1)(va)' },
    { clause: '21(a)', heading: 'Capital, personal, advertisement and penalty expenditure debited' },
    { clause: '21(b)', heading: 'Amounts inadmissible under s.40(a)' },
    { clause: '21(c)', heading: 'Interest, salary, bonus, commission or remuneration inadmissible — s.40(b) / 40(ba)' },
    { clause: '21(d)', heading: 'Cash payments disallowable under s.40A(3) / 40A(3A)' },
    { clause: '21(e)', heading: 'Provision for gratuity not allowable — s.40A(7)' },
    { clause: '21(f)', heading: 'Sums paid for specified funds not allowable — s.40A(9)' },
    { clause: '21(g)', heading: 'Contingent liabilities' },
    { clause: '21(h)', heading: 'Expenditure in relation to exempt income — s.14A' },
    { clause: '21(i)', heading: 'Interest inadmissible under the proviso to s.36(1)(iii)' },
    { clause: '22', heading: 'Interest inadmissible under s.23 of the MSMED Act, 2006' },
    { clause: '23', heading: 'Payments to persons specified in s.40A(2)(b)' },
    { clause: '24', heading: 'Deemed profits and gains under s.32AC / 33AB / 33ABA / 33AC' },
    { clause: '25', heading: 'Profit chargeable to tax under s.41' },
    { clause: '26', heading: 'Sums referred to in s.43B — liability, payment and status' },
    { clause: '27(a)', heading: 'CENVAT / input tax credit — amount and treatment in accounts' },
    { clause: '27(b)', heading: 'Income or expenditure of prior period credited or debited' },
    { clause: '28', heading: 'Shares received without or for inadequate consideration — s.56(2)(viia)' },
    { clause: '29', heading: 'Share premium in excess of fair market value — s.56(2)(viib)' },
    { clause: '29A', heading: 'Advance received and forfeited on transfer of capital asset — s.56(2)(ix)' },
    { clause: '29B', heading: 'Income by way of gift without or for inadequate consideration — s.56(2)(x)' },
    { clause: '30', heading: 'Amount borrowed or repaid on hundi otherwise than by account payee cheque — s.69D' },
    { clause: '30A', heading: 'Primary / secondary adjustment to transfer price — s.92CE' },
    { clause: '30B', heading: 'Limitation of interest deduction — s.94B' },
    { clause: '30C', heading: 'Impermissible avoidance arrangement (GAAR) — s.96' },
    { clause: '31(a)', heading: 'Loans or deposits accepted — s.269SS' },
    { clause: '31(b)', heading: 'Specified sums received — s.269SS' },
    { clause: '31(ba)', heading: 'Receipts of ₹2 lakh or more otherwise than by banking channel — s.269ST' },
    { clause: '31(bb)', heading: 'Payments of ₹2 lakh or more otherwise than by banking channel — s.269ST' },
    { clause: '31(c)', heading: 'Repayment of loans or deposits or specified advances — s.269T' },
    { clause: '31(d)', heading: 'Repayment of loans or deposits received otherwise than by banking channel' },
    { clause: '31(e)', heading: 'Repayment of loans or deposits made otherwise than by banking channel' },
    { clause: '32(a)', heading: 'Brought forward loss or depreciation allowance' },
    { clause: '32(b)', heading: 'Change in shareholding — s.79' },
    { clause: '32(c)', heading: 'Speculation business — s.73' },
    { clause: '32(d)', heading: 'Specified business — s.35AD' },
    { clause: '32(e)', heading: 'Deemed speculation — Explanation to s.73' },
    { clause: '33', heading: 'Deductions admissible under Chapter VI-A or Chapter III' },
    { clause: '34(a)', heading: 'TDS / TCS — compliance with Chapter XVII-B / XVII-BB' },
    { clause: '34(b)', heading: 'TDS / TCS statements furnished within time' },
    { clause: '34(c)', heading: 'Interest payable under s.201(1A) / 206C(7)' },
    { clause: '35(a)', heading: 'Quantitative details of principal items of goods traded' },
    { clause: '35(b)', heading: 'Quantitative details of raw materials, finished products and by-products' },
    { clause: '36', heading: '(Omitted) Dividend distribution tax' },
    { clause: '36A', heading: 'Deemed dividend received — s.2(22)(e)' },
    { clause: '37', heading: 'Cost audit carried out' },
    { clause: '38', heading: 'Audit under the Central Excise Act, 1944' },
    { clause: '39', heading: 'Audit under s.72A of the Finance Act, 1994 (service tax)' },
    { clause: '40', heading: 'Accounting ratios — turnover, gross profit, net profit, stock-in-trade, material consumed' },
    { clause: '41', heading: 'Demands raised or refunds issued under other tax laws' },
    { clause: '42', heading: 'Forms 61, 61A and 61B furnished' },
    { clause: '43', heading: 'Country-by-country report — s.286' },
    { clause: '44', heading: 'Break-up of total expenditure of entities registered / not registered under GST' },
  ],
}

export const CHECKLIST_TEMPLATES: TemplateSeed[] = [ACCEPTANCE, CARO, FORM_3CD, COMPLETION_TEMPLATE]
