/**
 * SAMPLE REGISTRATION CASES — five each for Partnership Firm, LLP and
 * Private Limited, so the dashboards, client lists and case screens have
 * something realistic to show.
 *
 * Each sample gets its own client (CLI-21xx / 22xx / 23xx), a case opened
 * through the real `openCase` engine (so the checklist is the live master
 * template), filled-in details, partners / designated partners / directors,
 * checklist progress matching its stage, and saved portal credentials on the
 * Registration page's credentials card.
 *
 * Idempotent: a client that already has a case of that kind is skipped, so
 * re-running never duplicates. Run with `npm run seed:registration-samples`.
 * Development data only — the names, PANs and logins are fictitious.
 */
import { PrismaClient } from '@prisma/client'
import { pathToFileURL } from 'node:url'
import { openCase, addPartnerRequirements, recompute, logActivity, serviceStatusFor, isPartnerTemplateRow } from '../src/modules/partnership/service.js'
import { KINDS, type RegistrationKind } from '../src/modules/partnership/constants.js'
import { encryptPortalSecret } from '../src/platform/portalCrypto.js'
import type { Session } from '../src/platform/auth.js'

type Status = 'NOT_STARTED' | 'DOCUMENTS_PENDING' | 'UNDER_REVIEW' | 'SUBMITTED' | 'COMPLETED'

interface Person {
  name: string; father?: string; pan: string; aadhaar: string; mobile: string; email: string; address: string
  capital?: string; share?: string; role?: 'DIRECTOR' | 'SHAREHOLDER' | 'BOTH'; shares?: number
}

interface Sample {
  id: string; code: string; company: string; person: string; phone: string; email: string; addr: string
  stage: string; status: Status; progress: number; dueInDays: number; assignee: string
  details: Record<string, unknown>; people: Person[]
  credentials: { mode: 'new' | 'existing'; fields: Record<string, string>; password: string }
}

const ADDR = (street: string, city: string, pin: string) => `${street}, ${city}, Tamil Nadu ${pin}`

// ── Partnership Firm Registration ─────────────────────────────────────────
const PARTNERSHIP: Sample[] = [
  {
    id: 'cli-2101', code: 'CLI-2101', company: 'Sri Murugan Traders', person: 'Murugan Pillai', phone: '9443012101', email: 'murugan@srimurugantraders.in',
    addr: ADDR('12 East Car Street', 'Madurai', '625001'), stage: 'INFO_COLLECTION', status: 'NOT_STARTED', progress: 0, dueInDays: 30, assignee: 'emp-exec',
    details: { firm_names: ['Sri Murugan Traders', 'Murugan & Sons Traders', 'SMT Wholesale'], nature_of_business: 'Wholesale trading in provisions and groceries', principal_place: '12 East Car Street, Madurai 625001', total_capital: '500000', commencement_date: '2026-10-15' },
    people: [
      { name: 'Murugan Pillai', father: 'Subramani Pillai', pan: 'AKMPM2101A', aadhaar: '210121012101', mobile: '9443012101', email: 'murugan@srimurugantraders.in', address: 'Madurai', capital: '300000', share: '60' },
      { name: 'Selvi Murugan', father: 'Raman', pan: 'BKSPS2101B', aadhaar: '210221022102', mobile: '9443012102', email: 'selvi@srimurugantraders.in', address: 'Madurai', capital: '200000', share: '40' },
    ],
    credentials: { mode: 'new', fields: { username: 'srimurugan_rof', firm_name: 'Sri Murugan Traders', partners: 'Murugan Pillai, AKMPM2101A, 60%\nSelvi Murugan, BKSPS2101B, 40%', deed_date: '2026-10-01', principal_place: '12 East Car Street, Madurai 625001', nature_of_business: 'Wholesale provisions', contact_mobile: '9443012101', contact_email: 'murugan@srimurugantraders.in' }, password: 'Sample@2101' },
  },
  {
    id: 'cli-2102', code: 'CLI-2102', company: 'Kaveri Textiles', person: 'Ramesh Gounder', phone: '9443012201', email: 'ramesh@kaveritextiles.in',
    addr: ADDR('45 Kumaran Road', 'Tiruppur', '641601'), stage: 'INFO_COLLECTION', status: 'DOCUMENTS_PENDING', progress: 30, dueInDays: 21, assignee: 'emp-exec',
    details: { firm_names: ['Kaveri Textiles', 'Kaveri Knit Fabrics'], nature_of_business: 'Knitted garment manufacturing and export', principal_place: '45 Kumaran Road, Tiruppur 641601', total_capital: '1500000', remuneration_terms: 'As per Section 40(b)', interest_on_capital: '12% p.a.', commencement_date: '2026-11-01' },
    people: [
      { name: 'Ramesh Gounder', father: 'Palanisamy Gounder', pan: 'AKRPG2102A', aadhaar: '220122012201', mobile: '9443012201', email: 'ramesh@kaveritextiles.in', address: 'Tiruppur', capital: '750000', share: '50' },
      { name: 'Senthil Kumar', father: 'Arumugam', pan: 'BKSPK2102B', aadhaar: '220222022202', mobile: '9443012202', email: 'senthil@kaveritextiles.in', address: 'Tiruppur', capital: '450000', share: '30' },
      { name: 'Divya Ramesh', father: 'Ganesan', pan: 'CKDPR2102C', aadhaar: '220322032203', mobile: '9443012203', email: 'divya@kaveritextiles.in', address: 'Tiruppur', capital: '300000', share: '20' },
    ],
    credentials: { mode: 'new', fields: { username: 'kaveritex_rof', firm_name: 'Kaveri Textiles', partners: 'Ramesh Gounder, 50%\nSenthil Kumar, 30%\nDivya Ramesh, 20%', deed_date: '2026-09-20', principal_place: '45 Kumaran Road, Tiruppur 641601', nature_of_business: 'Knitted garments', contact_mobile: '9443012201', contact_email: 'ramesh@kaveritextiles.in' }, password: 'Sample@2102' },
  },
  {
    id: 'cli-2103', code: 'CLI-2103', company: 'Chola Constructions', person: 'Karthik Rajan', phone: '9443012301', email: 'karthik@cholaconstructions.in',
    addr: ADDR('8 Gandhi Road', 'Thanjavur', '613001'), stage: 'DEED', status: 'UNDER_REVIEW', progress: 55, dueInDays: 14, assignee: 'emp-articled',
    details: { firm_names: ['Chola Constructions', 'Chola Builders'], nature_of_business: 'Civil construction contracts', principal_place: '8 Gandhi Road, Thanjavur 613001', total_capital: '2500000', bank_operation: 'Jointly by any two partners', authorized_signatory: 'Karthik Rajan', commencement_date: '2026-09-01' },
    people: [
      { name: 'Karthik Rajan', father: 'Rajan', pan: 'AKKPR2103A', aadhaar: '230123012301', mobile: '9443012301', email: 'karthik@cholaconstructions.in', address: 'Thanjavur', capital: '1500000', share: '60' },
      { name: 'Anbu Selvan', father: 'Velu', pan: 'BKAPS2103B', aadhaar: '230223022302', mobile: '9443012302', email: 'anbu@cholaconstructions.in', address: 'Thanjavur', capital: '1000000', share: '40' },
    ],
    credentials: { mode: 'new', fields: { username: 'cholacons_rof', firm_name: 'Chola Constructions', partners: 'Karthik Rajan, 60%\nAnbu Selvan, 40%', deed_date: '2026-08-25', principal_place: '8 Gandhi Road, Thanjavur 613001', nature_of_business: 'Civil construction', contact_mobile: '9443012301', contact_email: 'karthik@cholaconstructions.in' }, password: 'Sample@2103' },
  },
  {
    id: 'cli-2104', code: 'CLI-2104', company: 'Nilgiri Spices & Co', person: 'Joseph Mathew', phone: '9443012401', email: 'joseph@nilgirispices.in',
    addr: ADDR('22 Commercial Road', 'Ooty', '643001'), stage: 'ROF_FILING', status: 'SUBMITTED', progress: 85, dueInDays: 7, assignee: 'emp-articled',
    details: { firm_names: ['Nilgiri Spices & Co'], nature_of_business: 'Spice processing and retail', principal_place: '22 Commercial Road, Ooty 643001', total_capital: '1000000', commencement_date: '2026-08-01' },
    people: [
      { name: 'Joseph Mathew', father: 'Mathew Thomas', pan: 'AKJPM2104A', aadhaar: '240124012401', mobile: '9443012401', email: 'joseph@nilgirispices.in', address: 'Ooty', capital: '500000', share: '50' },
      { name: 'Anitha Joseph', father: 'George', pan: 'BKAPJ2104B', aadhaar: '240224022402', mobile: '9443012402', email: 'anitha@nilgirispices.in', address: 'Ooty', capital: '500000', share: '50' },
    ],
    credentials: { mode: 'new', fields: { username: 'nilgirispices_rof', firm_name: 'Nilgiri Spices & Co', partners: 'Joseph Mathew, 50%\nAnitha Joseph, 50%', deed_date: '2026-07-20', principal_place: '22 Commercial Road, Ooty 643001', nature_of_business: 'Spice processing', contact_mobile: '9443012401', contact_email: 'joseph@nilgirispices.in' }, password: 'Sample@2104' },
  },
  {
    id: 'cli-2105', code: 'CLI-2105', company: 'Marina Auto Works', person: 'Imran Basha', phone: '9443012501', email: 'imran@marinaautoworks.in',
    addr: ADDR('3 Beach Road', 'Chennai', '600001'), stage: 'REGISTERED', status: 'COMPLETED', progress: 100, dueInDays: -10, assignee: 'emp-exec',
    details: { firm_names: ['Marina Auto Works'], nature_of_business: 'Automobile service and spares', principal_place: '3 Beach Road, Chennai 600001', total_capital: '800000', commencement_date: '2026-06-01' },
    people: [
      { name: 'Imran Basha', father: 'Abdul Basha', pan: 'AKIPB2105A', aadhaar: '250125012501', mobile: '9443012501', email: 'imran@marinaautoworks.in', address: 'Chennai', capital: '400000', share: '50' },
      { name: 'Prakash Nair', father: 'Gopal Nair', pan: 'BKPPN2105B', aadhaar: '250225022502', mobile: '9443012502', email: 'prakash@marinaautoworks.in', address: 'Chennai', capital: '400000', share: '50' },
    ],
    credentials: { mode: 'existing', fields: { username: 'marinaauto_rof', firm_registration_number: 'TN/CHN/FR/2026/1105' }, password: 'Sample@2105' },
  },
]

// ── LLP Registration ──────────────────────────────────────────────────────
const LLP: Sample[] = [
  {
    id: 'cli-2201', code: 'CLI-2201', company: 'Bluewave Consulting LLP', person: 'Harish Venkat', phone: '9444022101', email: 'harish@bluewaveconsulting.in',
    addr: ADDR('14 Nungambakkam High Road', 'Chennai', '600034'), stage: 'STAGE_1', status: 'NOT_STARTED', progress: 0, dueInDays: 30, assignee: 'emp-exec',
    details: { llp_names: ['Bluewave Consulting LLP', 'Bluewave Advisory LLP'], main_objective: 'Management and IT consulting services', total_contribution: '200000' },
    people: [
      { name: 'Harish Venkat', father: 'Venkatesan', pan: 'AKHPV2201A', aadhaar: '310131013101', mobile: '9444022101', email: 'harish@bluewaveconsulting.in', address: 'Chennai', capital: '100000', share: '50' },
      { name: 'Meena Harish', father: 'Sundaram', pan: 'BKMPH2201B', aadhaar: '310231023102', mobile: '9444022102', email: 'meena@bluewaveconsulting.in', address: 'Chennai', capital: '100000', share: '50' },
    ],
    credentials: { mode: 'new', fields: { username: 'bluewave.mca', proposed_names: 'Bluewave Consulting LLP\nBluewave Advisory LLP', designated_partners: 'Harish Venkat, AKHPV2201A\nMeena Harish, BKMPH2201B', contribution: '200000', registered_office: '14 Nungambakkam High Road, Chennai 600034', contact_mobile: '9444022101', contact_email: 'harish@bluewaveconsulting.in' }, password: 'Sample@2201' },
  },
  {
    id: 'cli-2202', code: 'CLI-2202', company: 'Greenleaf Organics LLP', person: 'Priya Natarajan', phone: '9444022201', email: 'priya@greenleaforganics.in',
    addr: ADDR('77 Avinashi Road', 'Coimbatore', '641018'), stage: 'STAGE_1', status: 'DOCUMENTS_PENDING', progress: 35, dueInDays: 20, assignee: 'emp-exec',
    details: { llp_names: ['Greenleaf Organics LLP', 'Greenleaf Farms LLP'], main_objective: 'Organic produce aggregation and retail', total_contribution: '500000' },
    people: [
      { name: 'Priya Natarajan', father: 'Natarajan', pan: 'AKPPN2202A', aadhaar: '320132013201', mobile: '9444022201', email: 'priya@greenleaforganics.in', address: 'Coimbatore', capital: '300000', share: '60' },
      { name: 'Vasanth Kumar', father: 'Kumaravel', pan: 'BKVPK2202B', aadhaar: '320232023202', mobile: '9444022202', email: 'vasanth@greenleaforganics.in', address: 'Coimbatore', capital: '200000', share: '40' },
    ],
    credentials: { mode: 'new', fields: { username: 'greenleaf.mca', proposed_names: 'Greenleaf Organics LLP\nGreenleaf Farms LLP', designated_partners: 'Priya Natarajan, AKPPN2202A\nVasanth Kumar, BKVPK2202B', contribution: '500000', registered_office: '77 Avinashi Road, Coimbatore 641018', contact_mobile: '9444022201', contact_email: 'priya@greenleaforganics.in' }, password: 'Sample@2202' },
  },
  {
    id: 'cli-2203', code: 'CLI-2203', company: 'Apex Design Studio LLP', person: 'Sanjay Krishnan', phone: '9444022301', email: 'sanjay@apexdesign.in',
    addr: ADDR('5 Race Course Road', 'Coimbatore', '641018'), stage: 'STAGE_2', status: 'UNDER_REVIEW', progress: 60, dueInDays: 12, assignee: 'emp-articled',
    details: { llp_names: ['Apex Design Studio LLP', 'Apex Architects LLP'], main_objective: 'Architecture and interior design', total_contribution: '300000' },
    people: [
      { name: 'Sanjay Krishnan', father: 'Krishnan', pan: 'AKSPK2203A', aadhaar: '330133013301', mobile: '9444022301', email: 'sanjay@apexdesign.in', address: 'Coimbatore', capital: '150000', share: '50' },
      { name: 'Revathi Sanjay', father: 'Mohan', pan: 'BKRPS2203B', aadhaar: '330233023302', mobile: '9444022302', email: 'revathi@apexdesign.in', address: 'Coimbatore', capital: '150000', share: '50' },
    ],
    credentials: { mode: 'new', fields: { username: 'apexdesign.mca', proposed_names: 'Apex Design Studio LLP\nApex Architects LLP', designated_partners: 'Sanjay Krishnan, AKSPK2203A\nRevathi Sanjay, BKRPS2203B', contribution: '300000', registered_office: '5 Race Course Road, Coimbatore 641018', srn: 'AB1234567', contact_mobile: '9444022301', contact_email: 'sanjay@apexdesign.in' }, password: 'Sample@2203' },
  },
  {
    id: 'cli-2204', code: 'CLI-2204', company: 'Trident Logistics LLP', person: 'Faizal Ahmed', phone: '9444022401', email: 'faizal@tridentlogistics.in',
    addr: ADDR('90 Harbour Road', 'Thoothukudi', '628001'), stage: 'STAGE_2', status: 'SUBMITTED', progress: 85, dueInDays: 5, assignee: 'emp-articled',
    details: { llp_names: ['Trident Logistics LLP'], main_objective: 'Freight forwarding and warehousing', total_contribution: '1000000' },
    people: [
      { name: 'Faizal Ahmed', father: 'Nazeer Ahmed', pan: 'AKFPA2204A', aadhaar: '340134013401', mobile: '9444022401', email: 'faizal@tridentlogistics.in', address: 'Thoothukudi', capital: '600000', share: '60' },
      { name: 'Gopi Nath', father: 'Rangan', pan: 'BKGPN2204B', aadhaar: '340234023402', mobile: '9444022402', email: 'gopi@tridentlogistics.in', address: 'Thoothukudi', capital: '400000', share: '40' },
    ],
    credentials: { mode: 'new', fields: { username: 'trident.mca', proposed_names: 'Trident Logistics LLP', designated_partners: 'Faizal Ahmed, AKFPA2204A\nGopi Nath, BKGPN2204B', contribution: '1000000', registered_office: '90 Harbour Road, Thoothukudi 628001', srn: 'AB7654321', contact_mobile: '9444022401', contact_email: 'faizal@tridentlogistics.in' }, password: 'Sample@2204' },
  },
  {
    id: 'cli-2205', code: 'CLI-2205', company: 'Silverline Legal LLP', person: 'Lakshmi Narayanan', phone: '9444022501', email: 'lakshmi@silverlinelegal.in',
    addr: ADDR('2 High Court Road', 'Chennai', '600104'), stage: 'COMPLETED', status: 'COMPLETED', progress: 100, dueInDays: -15, assignee: 'emp-exec',
    details: { llp_names: ['Silverline Legal LLP'], main_objective: 'Legal advisory services', total_contribution: '400000' },
    people: [
      { name: 'Lakshmi Narayanan', father: 'Narayanan', pan: 'AKLPN2205A', aadhaar: '350135013501', mobile: '9444022501', email: 'lakshmi@silverlinelegal.in', address: 'Chennai', capital: '200000', share: '50' },
      { name: 'Arjun Das', father: 'Mohan Das', pan: 'BKAPD2205B', aadhaar: '350235023502', mobile: '9444022502', email: 'arjun@silverlinelegal.in', address: 'Chennai', capital: '200000', share: '50' },
    ],
    credentials: { mode: 'existing', fields: { username: 'silverline.mca', llpin: 'ACD-4521' }, password: 'Sample@2205' },
  },
]

// ── Private Limited Incorporation ─────────────────────────────────────────
const PRIVATE_LIMITED: Sample[] = [
  {
    id: 'cli-2301', code: 'CLI-2301', company: 'Zenith Tech Solutions Pvt Ltd', person: 'Vikram Sundar', phone: '9445032101', email: 'vikram@zenithtech.in',
    addr: ADDR('101 OMR', 'Chennai', '600097'), stage: 'DOCUMENTS', status: 'NOT_STARTED', progress: 0, dueInDays: 30, assignee: 'emp-exec',
    details: { company_names: ['Zenith Tech Solutions Private Limited', 'Zenith Softlabs Private Limited'], name_significance: 'Zenith — the highest point', main_objective: 'Software development and IT services', authorized_capital: '1000000', paid_up_capital: '100000' },
    people: [
      { name: 'Vikram Sundar', father: 'Sundar Rajan', pan: 'AKVPS2301A', aadhaar: '410141014101', mobile: '9445032101', email: 'vikram@zenithtech.in', address: 'Chennai', role: 'BOTH', shares: 5000 },
      { name: 'Nisha Vikram', father: 'Balu', pan: 'BKNPV2301B', aadhaar: '410241024102', mobile: '9445032102', email: 'nisha@zenithtech.in', address: 'Chennai', role: 'BOTH', shares: 5000 },
    ],
    credentials: { mode: 'new', fields: { username: 'zenithtech.mca', proposed_names: 'Zenith Tech Solutions Private Limited\nZenith Softlabs Private Limited', directors: 'Vikram Sundar, AKVPS2301A\nNisha Vikram, BKNPV2301B', authorised_capital: '1000000', paid_up_capital: '100000', registered_office: '101 OMR, Chennai 600097', contact_mobile: '9445032101', contact_email: 'vikram@zenithtech.in' }, password: 'Sample@2301' },
  },
  {
    id: 'cli-2302', code: 'CLI-2302', company: 'Pearl Healthcare Pvt Ltd', person: 'Dr. Asha Menon', phone: '9445032201', email: 'asha@pearlhealthcare.in',
    addr: ADDR('18 Poonamallee High Road', 'Chennai', '600010'), stage: 'DOCUMENTS', status: 'DOCUMENTS_PENDING', progress: 30, dueInDays: 21, assignee: 'emp-exec',
    details: { company_names: ['Pearl Healthcare Private Limited', 'Pearl Diagnostics Private Limited'], name_significance: 'Pearl — purity and care', main_objective: 'Diagnostic centres and clinics', authorized_capital: '2500000', paid_up_capital: '500000' },
    people: [
      { name: 'Asha Menon', father: 'Krishna Menon', pan: 'AKAPM2302A', aadhaar: '420142014201', mobile: '9445032201', email: 'asha@pearlhealthcare.in', address: 'Chennai', role: 'BOTH', shares: 30000 },
      { name: 'Rahul Menon', father: 'Asokan', pan: 'BKRPM2302B', aadhaar: '420242024202', mobile: '9445032202', email: 'rahul@pearlhealthcare.in', address: 'Chennai', role: 'DIRECTOR', shares: 0 },
      { name: 'Kamala Devi', father: 'Rajagopal', pan: 'CKKPD2302C', aadhaar: '420342034203', mobile: '9445032203', email: 'kamala@pearlhealthcare.in', address: 'Chennai', role: 'SHAREHOLDER', shares: 20000 },
    ],
    credentials: { mode: 'new', fields: { username: 'pearlhealth.mca', proposed_names: 'Pearl Healthcare Private Limited\nPearl Diagnostics Private Limited', directors: 'Asha Menon, AKAPM2302A\nRahul Menon, BKRPM2302B', authorised_capital: '2500000', paid_up_capital: '500000', registered_office: '18 Poonamallee High Road, Chennai 600010', contact_mobile: '9445032201', contact_email: 'asha@pearlhealthcare.in' }, password: 'Sample@2302' },
  },
  {
    id: 'cli-2303', code: 'CLI-2303', company: 'Orbit Renewable Energy Pvt Ltd', person: 'Suresh Babu', phone: '9445032301', email: 'suresh@orbitrenewable.in',
    addr: ADDR('6 SIPCOT Industrial Park', 'Hosur', '635126'), stage: 'DOCUMENTS', status: 'UNDER_REVIEW', progress: 60, dueInDays: 10, assignee: 'emp-articled',
    details: { company_names: ['Orbit Renewable Energy Private Limited', 'Orbit Solar Private Limited'], name_significance: 'Orbit — the sun at the centre', main_objective: 'Solar EPC and rooftop installations', authorized_capital: '5000000', paid_up_capital: '1000000' },
    people: [
      { name: 'Suresh Babu', father: 'Babu Rao', pan: 'AKSPB2303A', aadhaar: '430143014301', mobile: '9445032301', email: 'suresh@orbitrenewable.in', address: 'Hosur', role: 'BOTH', shares: 60000 },
      { name: 'Geetha Suresh', father: 'Chandran', pan: 'BKGPS2303B', aadhaar: '430243024302', mobile: '9445032302', email: 'geetha@orbitrenewable.in', address: 'Hosur', role: 'BOTH', shares: 40000 },
    ],
    credentials: { mode: 'new', fields: { username: 'orbitrenew.mca', proposed_names: 'Orbit Renewable Energy Private Limited\nOrbit Solar Private Limited', directors: 'Suresh Babu, AKSPB2303A\nGeetha Suresh, BKGPS2303B', authorised_capital: '5000000', paid_up_capital: '1000000', registered_office: '6 SIPCOT Industrial Park, Hosur 635126', srn: 'AA9876543', contact_mobile: '9445032301', contact_email: 'suresh@orbitrenewable.in' }, password: 'Sample@2303' },
  },
  {
    id: 'cli-2304', code: 'CLI-2304', company: 'Cauvery Foods Pvt Ltd', person: 'Balaji Srinivasan', phone: '9445032401', email: 'balaji@cauveryfoods.in',
    addr: ADDR('33 Srirangam Road', 'Tiruchirappalli', '620006'), stage: 'DOCUMENTS', status: 'SUBMITTED', progress: 85, dueInDays: 4, assignee: 'emp-articled',
    details: { company_names: ['Cauvery Foods Private Limited'], name_significance: 'Named after the river Cauvery', main_objective: 'Ready-to-cook food products', authorized_capital: '1500000', paid_up_capital: '300000' },
    people: [
      { name: 'Balaji Srinivasan', father: 'Srinivasan', pan: 'AKBPS2304A', aadhaar: '440144014401', mobile: '9445032401', email: 'balaji@cauveryfoods.in', address: 'Tiruchirappalli', role: 'BOTH', shares: 15000 },
      { name: 'Kavya Balaji', father: 'Raghavan', pan: 'BKKPB2304B', aadhaar: '440244024402', mobile: '9445032402', email: 'kavya@cauveryfoods.in', address: 'Tiruchirappalli', role: 'BOTH', shares: 15000 },
    ],
    credentials: { mode: 'new', fields: { username: 'cauveryfoods.mca', proposed_names: 'Cauvery Foods Private Limited', directors: 'Balaji Srinivasan, AKBPS2304A\nKavya Balaji, BKKPB2304B', authorised_capital: '1500000', paid_up_capital: '300000', registered_office: '33 Srirangam Road, Tiruchirappalli 620006', srn: 'AA1122334', contact_mobile: '9445032401', contact_email: 'balaji@cauveryfoods.in' }, password: 'Sample@2304' },
  },
  {
    id: 'cli-2305', code: 'CLI-2305', company: 'Summit Edutech Pvt Ltd', person: 'Aravind Kumar', phone: '9445032501', email: 'aravind@summitedutech.in',
    addr: ADDR('21 Anna Nagar 2nd Avenue', 'Chennai', '600040'), stage: 'COMPLETED', status: 'COMPLETED', progress: 100, dueInDays: -20, assignee: 'emp-exec',
    details: { company_names: ['Summit Edutech Private Limited'], name_significance: 'Summit — reaching the top', main_objective: 'Online learning platforms', authorized_capital: '1000000', paid_up_capital: '100000' },
    people: [
      { name: 'Aravind Kumar', father: 'Kumar', pan: 'AKAPK2305A', aadhaar: '450145014501', mobile: '9445032501', email: 'aravind@summitedutech.in', address: 'Chennai', role: 'BOTH', shares: 5000 },
      { name: 'Deepika Aravind', father: 'Shankar', pan: 'BKDPA2305B', aadhaar: '450245024502', mobile: '9445032502', email: 'deepika@summitedutech.in', address: 'Chennai', role: 'BOTH', shares: 5000 },
    ],
    credentials: { mode: 'existing', fields: { username: 'summitedu.mca', cin: 'U85499TN2026PTC165432' }, password: 'Sample@2305' },
  },
]

const SETS: { kind: RegistrationKind; credCode: string; businessType: string; samples: Sample[] }[] = [
  { kind: 'PARTNERSHIP', credCode: 'partnership-firm', businessType: 'Partnership Firm', samples: PARTNERSHIP },
  { kind: 'LLP', credCode: 'llp', businessType: 'LLP', samples: LLP },
  { kind: 'PRIVATE_LIMITED', credCode: 'private-limited', businessType: 'Private Limited Company', samples: PRIVATE_LIMITED },
]

function isoDay(offset: number): string {
  const t = new Date(Date.now() + 5.5 * 3600_000 + offset * 86_400_000)
  return t.toISOString().slice(0, 10)
}

export async function seedRegistrationSamples(prisma: PrismaClient) {
  const org = await prisma.organisation.findFirst({ select: { id: true } })
  if (!org) throw new Error('Run the main seed first — no organisation.')
  const user = await prisma.user.findUnique({ where: { id: 'usr-md' }, include: { role: true } })
  if (!user) throw new Error('Run the main seed first — usr-md is missing.')
  const session = {
    userId: user.id, email: user.email, roleId: user.roleId, roleCode: user.role.code, roleName: user.role.name,
    grants: [], employeeId: user.employeeId, departmentId: null, employeeFullName: null,
  } as unknown as Session

  const summary: Record<string, { created: number; skipped: number }> = {}
  for (const set of SETS) {
    const tally = { created: 0, skipped: 0 }
    for (const s of set.samples) {
      await prisma.client.upsert({
        where: { id: s.id },
        update: {},
        create: {
          id: s.id, organisationId: org.id, clientCode: s.code,
          companyName: s.company, legalName: s.company, businessType: set.businessType,
          contactPerson: s.person, contactNumber: s.phone, email: s.email, address: s.addr,
          accountManagerId: 'emp-mgr', assignedTeam: 'Operations',
          status: s.status === 'COMPLETED' ? 'active' : 'onboarding', onboardingDate: isoDay(-45),
        },
      })

      const existing = await prisma.partnershipCase.findFirst({ where: { clientId: s.id, kind: set.kind, deletedAt: null } })
      if (existing) { tally.skipped++; continue }

      const c = await openCase(session, set.kind, {
        clientId: s.id, assignedEmployeeId: s.assignee, reviewerEmployeeId: 'emp-mgr', approverEmployeeId: 'emp-md',
        dueDate: isoDay(s.dueInDays),
        entityType: set.kind === 'PARTNERSHIP' ? 'PARTNERSHIP' : set.kind === 'LLP' ? 'LLP' : 'PVT_LTD',
      })
      await logActivity(c.id, session, 'case.created', `Registration case ${c.caseCode} opened (sample data)`)

      let order = 0
      for (const p of s.people) {
        const partner = await prisma.partnershipPartner.create({
          data: {
            caseId: c.id, sortOrder: (order += 10), name: p.name, fatherName: p.father ?? null, address: p.address,
            mobile: p.mobile, email: p.email, pan: p.pan, aadhaar: p.aadhaar,
            capital: p.capital ?? null, profitShare: p.share ?? null, role: p.role ?? null, shares: p.shares ?? null,
          },
        })
        await addPartnerRequirements(c.id, partner, session)
      }

      // Tick the checklist in order up to the sample's progress.
      const items = await prisma.partnershipCaseItem.findMany({
        where: { caseId: c.id, deletedAt: null },
        select: { id: true, partnerId: true, category: { select: { perPartner: true, sortOrder: true } }, sortOrder: true },
      })
      const live = items
        .filter((i) => !isPartnerTemplateRow(i))
        .sort((a, b) => a.category.sortOrder - b.category.sortOrder || a.sortOrder - b.sortOrder)
      const doneCount = Math.round((live.length * s.progress) / 100)
      if (doneCount > 0) {
        await prisma.partnershipCaseItem.updateMany({
          where: { id: { in: live.slice(0, doneCount).map((i) => i.id) } },
          data: { status: 'COMPLETED' },
        })
      }

      await prisma.partnershipCase.update({
        where: { id: c.id },
        data: { stage: s.stage, status: s.status, detailsJson: JSON.stringify(s.details), lastActivityAt: new Date() },
      })
      if (c.clientServiceId) {
        await prisma.clientService.update({ where: { id: c.clientServiceId }, data: { status: serviceStatusFor(s.status) } })
      }
      await recompute(c.id)

      const credField = `registration_${set.credCode.replace(/-/g, '_')}_password`
      await prisma.registrationCredential.upsert({
        where: { clientId_typeCode: { clientId: s.id, typeCode: set.credCode } },
        update: {},
        create: {
          clientId: s.id, typeCode: set.credCode, mode: s.credentials.mode,
          fieldsJson: JSON.stringify(s.credentials.fields),
          passwordCiphertext: encryptPortalSecret(s.credentials.password, credField),
          createdBy: session.userId, updatedBy: session.userId,
        },
      })
      tally.created++
    }
    summary[KINDS[set.kind].label] = tally
  }
  return summary
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const prisma = new PrismaClient()
  seedRegistrationSamples(prisma)
    .then((r) => { console.log('[seed-registration-samples]', r) })
    .catch((e) => { console.error(e); process.exitCode = 1 })
    .finally(() => prisma.$disconnect())
}
