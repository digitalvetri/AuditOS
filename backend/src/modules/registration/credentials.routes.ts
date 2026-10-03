/**
 * REGISTRATION CREDENTIALS — the portal login and reference details a client
 * holds for each registration (Private Limited, LLP, Partnership Firm, MSME
 * Udyam, Shops & Establishment, IEC, PF, ESI, E-Invoice, E-Way Bill). One record per client per registration, so
 * details entered once are shown the next time instead of asked for again.
 *
 *   GET    /api/registration-credentials/specs                   field layout per registration
 *   GET    /api/registration-credentials/:type/:clientId          record; password → `password_present`
 *   PUT    /api/registration-credentials/:type/:clientId          upsert; password encrypted server-side
 *   DELETE /api/registration-credentials/:type/:clientId          soft delete + wipe ciphertext
 *   POST   /api/registration-credentials/:type/:clientId/reveal   decrypt the password, audit row
 *
 * Same rules as tds-portal: every :clientId is checked against the caller's
 * visible clients (unknown and out-of-scope both answer 404), the password is
 * never part of a normal read, and every reveal is audited.
 */
import { Router } from 'express'
import { prisma } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { requireWorkstation, assignedClientIds } from '../../platform/workstation/scope.js'
import { body, FieldErrors } from '../workstation/validate.js'
import { encryptPortalSecret, decryptPortalSecret } from '../../platform/portalCrypto.js'

const VIEW = ['workstation.registration.portal.view'] as const
const REVEAL = ['workstation.registration.portal.reveal'] as const

type Mode = 'new' | 'existing'

interface FieldSpec {
  key: string
  label: string
  /** 'secret': a second password-like value (encrypted on its own, revealed like the password). */
  kind?: 'text' | 'email' | 'phone' | 'gstin' | 'textarea' | 'select' | 'date' | 'secret'
  options?: string[]
  placeholder?: string
  /** Required in these modes (or always, for a registration without modes). */
  required?: boolean | Mode[]
  /** Shown only in these modes; all modes when omitted. */
  modes?: Mode[]
  /** Pre-filled from the client record on first entry. */
  prefill?: 'gstin' | 'contact_number' | 'email'
  mono?: boolean
  /** Allowed length [min, max], as the portal enforces it. */
  length?: [number, number]
  /** 'details' — filed with the first-time application; the saved card keeps
   *  these folded away and leads with the login. */
  group?: 'details'
}

interface RegistrationSpec {
  code: string
  title: string
  modes?: { key: Mode; label: string; hint: string }[]
  fields: FieldSpec[]
  /** Whether the record carries a password, and when it is required on create. */
  password?: { label: string; required: boolean | Mode[]; modes?: Mode[]; rule?: { test: (v: string) => boolean; message: string } }
}

const TWO_MODES: RegistrationSpec['modes'] = [
  { key: 'new', label: 'New registration', hint: 'Registering the client now — credentials are issued after registration.' },
  { key: 'existing', label: 'Already registered', hint: 'The client is already registered — only the login is needed.' },
]

// Incorporation / firm registrations: the first time asks for the login and
// what the application needs; once registered, only the login and the number.
const FIRST_TIME_MODES: RegistrationSpec['modes'] = [
  { key: 'new', label: 'First-time registration', hint: 'Registering the client now — save the portal login and the details the application needs.' },
  { key: 'existing', label: 'Already registered', hint: 'The client is already registered — only the login details are needed.' },
]

const contactDetails = (who: string): FieldSpec[] => [
  { key: 'contact_mobile', label: `${who} Mobile`, kind: 'phone', required: ['new'], modes: ['new'], prefill: 'contact_number', group: 'details' },
  { key: 'contact_email', label: `${who} Email`, kind: 'email', required: ['new'], modes: ['new'], prefill: 'email', group: 'details' },
]

// States / UTs as the GST portal's New Registration form lists them.
const GST_STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir',
  'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
  'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Other Territory',
]

/** TNREGINET's password rules, checked before saving so the portal never rejects it. */
const TNREGINET_PASSWORD = {
  test: (v: string) => v.length >= 10 && v.length <= 16 && /[a-z]/.test(v) && /[0-9]/.test(v)
    && /[$&()*,@[\] ^_{}~£]/.test(v.trim()) && /^[A-Za-z0-9$&()*,@[\] ^_{}~£]+$/.test(v) && v === v.trim(),
  message: 'Password must be 10–16 characters (the portal’s box takes 16) with a lower-case letter, a number and one of $&()*,@[] ^_{}~£ — no other symbols, and no space at the start or end.',
}

/** Whose mobile / email it is — the e-Filing Register form's choices. */
const BELONGS_TO = ['Self', 'Spouse', 'Son', 'Daughter', 'Father', 'Mother', 'Others']

// MCA V3 — New User Registration (creating the MCA login), as the portal's form asks.
const MCA_USER_REGISTRATION: FieldSpec[] = [
  { key: 'user_category', label: 'User Category', kind: 'select', options: ['Registered User', 'Business User'], required: ['new'], modes: ['new'], group: 'details' },
  { key: 'user_role', label: 'User Role', required: ['new'], modes: ['new'], group: 'details', placeholder: 'e.g. Director, Professional, Business User' },
  { key: 'mca_pan', label: 'Income Tax PAN', required: ['new'], modes: ['new'], group: 'details', mono: true, placeholder: 'AAAAA9999A' },
  { key: 'first_name', label: 'First Name (as per Income Tax PAN)', modes: ['new'], group: 'details' },
  { key: 'middle_name', label: 'Middle Name', modes: ['new'], group: 'details' },
  { key: 'last_name', label: 'Last Name', modes: ['new'], group: 'details' },
  { key: 'dob', label: 'Date of Birth', kind: 'date', required: ['new'], modes: ['new'], group: 'details' },
  { key: 'gender', label: 'Gender', kind: 'select', options: ['Male', 'Female'], required: ['new'], modes: ['new'], group: 'details' },
  { key: 'profession', label: 'Profession', required: ['new'], modes: ['new'], group: 'details' },
  { key: 'address_line1', label: 'Address Line 1', required: ['new'], modes: ['new'], group: 'details' },
  { key: 'address_line2', label: 'Address Line 2', modes: ['new'], group: 'details' },
  { key: 'country', label: 'Country', required: ['new'], modes: ['new'], group: 'details', placeholder: 'India' },
  { key: 'pin_code', label: 'PIN Code', required: ['new'], modes: ['new'], group: 'details', mono: true },
  { key: 'mca_state', label: 'State', kind: 'select', options: GST_STATES, required: ['new'], modes: ['new'], group: 'details' },
  { key: 'city', label: 'City', required: ['new'], modes: ['new'], group: 'details' },
  { key: 'area_locality', label: 'Area / Locality', required: ['new'], modes: ['new'], group: 'details' },
  { key: 'phone_residence', label: 'Telephone — Residence (with STD code)', modes: ['new'], group: 'details', mono: true },
  { key: 'phone_office', label: 'Telephone — Office (with STD code)', modes: ['new'], group: 'details', mono: true },
  { key: 'mca_mobile', label: 'Mobile', kind: 'phone', required: ['new'], modes: ['new'], group: 'details', prefill: 'contact_number' },
  { key: 'mca_email', label: 'Email ID', kind: 'email', required: ['new'], modes: ['new'], group: 'details', prefill: 'email' },
]

export const REGISTRATION_SPECS: RegistrationSpec[] = [
  {
    // GST: a first-time registration needs what the portal's New Registration
    // (Part A) asks for; once registered, the GST portal login.
    code: 'gst',
    title: 'GST Registration',
    modes: FIRST_TIME_MODES,
    fields: [
      {
        key: 'applicant_type', label: 'I am a', kind: 'select', required: ['new'], modes: ['new'], group: 'details',
        options: ['Taxpayer', 'Tax Deductor', 'Tax Collector (e-Commerce)', 'GST Practitioner', 'Non Resident Taxable Person',
          'United Nation Body', 'Consulate or Embassy of Foreign Country', 'Other Notified Person',
          'Non-Resident Online Services Provider and/or Non-Resident Online Money Gaming Supplier'],
      },
      { key: 'state', label: 'State / UT', kind: 'select', options: GST_STATES, required: ['new'], modes: ['new'], group: 'details' },
      { key: 'district', label: 'District', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'legal_name', label: 'Legal Name of the Business (As mentioned in PAN)', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'pan', label: 'Permanent Account Number (PAN)', required: ['new'], modes: ['new'], group: 'details', mono: true, placeholder: 'AAAAA9999A' },
      { key: 'email', label: 'Email Address', kind: 'email', required: ['new'], modes: ['new'], group: 'details', prefill: 'email', placeholder: 'OTP will be sent to this email' },
      { key: 'mobile', label: 'Mobile Number', kind: 'phone', required: ['new'], modes: ['new'], group: 'details', prefill: 'contact_number', placeholder: 'OTP will be sent to this mobile' },
      { key: 'trn', label: 'Temporary Reference Number (TRN)', modes: ['new'], group: 'details', mono: true, placeholder: 'Issued after Part A is verified' },
      { key: 'gstin', label: 'GSTIN', kind: 'gstin', required: ['existing'], modes: ['existing'], prefill: 'gstin', mono: true },
      { key: 'username', label: 'GST Portal Username', required: ['existing'], mono: true, placeholder: 'Created after the registration is approved' },
    ],
    password: { label: 'GST Portal Password', required: ['existing'] },
  },
  {
    code: 'private-limited',
    title: 'Private Limited Incorporation',
    modes: FIRST_TIME_MODES,
    fields: [
      // Already registered: the MCA V3 login.
      { key: 'username', label: 'User ID (CIN / LLPIN / FCRN for Company / LLP, Email ID for other users)', required: ['existing'], mono: true },
      // First time: what the MCA V3 New User Registration form asks for.
      ...MCA_USER_REGISTRATION,
      { key: 'cin', label: 'CIN (Corporate Identification Number)', required: ['existing'], mono: true, placeholder: 'U00000TN0000PTC000000 — once incorporated' },
      { key: 'proposed_names', label: 'Proposed Company Names', kind: 'textarea', required: ['new'], modes: ['new'], group: 'details', placeholder: 'One per line, in order of preference' },
      { key: 'directors', label: 'Directors (Name, DIN / PAN)', kind: 'textarea', required: ['new'], modes: ['new'], group: 'details', placeholder: 'At least two directors' },
      { key: 'authorised_capital', label: 'Authorised Capital (₹)', required: ['new'], modes: ['new'], group: 'details', mono: true },
      { key: 'paid_up_capital', label: 'Paid-up Capital (₹)', modes: ['new'], group: 'details', mono: true },
      { key: 'registered_office', label: 'Registered Office Address', kind: 'textarea', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'srn', label: 'SPICe+ SRN', modes: ['new'], group: 'details', mono: true, placeholder: 'Once the form is filed' },
      ...contactDetails('Company'),
    ],
    password: { label: 'Password', required: true },
  },
  {
    code: 'llp',
    title: 'LLP Registration',
    modes: FIRST_TIME_MODES,
    fields: [
      { key: 'username', label: 'MCA V3 User ID / Username', required: true, mono: true },
      { key: 'llpin', label: 'LLPIN', required: ['existing'], mono: true, placeholder: 'AAA-0000 — once incorporated' },
      { key: 'proposed_names', label: 'Proposed LLP Names', kind: 'textarea', required: ['new'], modes: ['new'], group: 'details', placeholder: 'One per line, in order of preference' },
      { key: 'designated_partners', label: 'Designated Partners (Name, DPIN / PAN)', kind: 'textarea', required: ['new'], modes: ['new'], group: 'details', placeholder: 'At least two designated partners' },
      { key: 'contribution', label: 'Total Contribution (₹)', required: ['new'], modes: ['new'], group: 'details', mono: true },
      { key: 'registered_office', label: 'Registered Office Address', kind: 'textarea', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'srn', label: 'FiLLiP SRN', modes: ['new'], group: 'details', mono: true, placeholder: 'Once the form is filed' },
      ...contactDetails('LLP'),
    ],
    password: { label: 'Password', required: true },
  },
  {
    code: 'partnership-firm',
    title: 'Partnership Firm Registration',
    modes: FIRST_TIME_MODES,
    fields: [
      // The TNREGINET login (both modes: chosen at registration, used after).
      { key: 'username', label: 'User Name', required: true, mono: true },
      // First time: TNREGINET's user registration form.
      { key: 'user_type', label: 'User Type', kind: 'select', options: ['Citizen'], required: ['new'], modes: ['new'], group: 'details' },
      { key: 'security_question', label: 'Security Question', required: ['new'], modes: ['new'], group: 'details', placeholder: 'What is your pet name?' },
      // The answer recovers the account — kept encrypted like a password.
      { key: 'security_answer', label: 'Security Answer', kind: 'secret', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'salutation', label: 'Salutation', kind: 'select', options: ['Mr.', 'Mrs.', 'Ms.', 'Master', 'Transgender'], required: ['new'], modes: ['new'], group: 'details' },
      { key: 'first_name', label: 'First Name', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'middle_name', label: 'Middle Name', modes: ['new'], group: 'details' },
      { key: 'last_name', label: 'Last Name', modes: ['new'], group: 'details' },
      { key: 'gender', label: 'Gender', kind: 'select', options: ['Male', 'Female', 'Transgender'], required: ['new'], modes: ['new'], group: 'details' },
      { key: 'identification_type', label: 'Identification Type', kind: 'select', options: ['Aadhaar', 'PAN', 'Driving Licence', 'Passport', 'OCI Passport'], required: ['new'], modes: ['new'], group: 'details' },
      // Often an Aadhaar number — kept encrypted.
      { key: 'identification_no', label: 'Identification No.', kind: 'secret', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'reg_email', label: 'Email Address', kind: 'email', required: ['new'], modes: ['new'], group: 'details', prefill: 'email' },
      { key: 'dob', label: 'Date of Birth', kind: 'date', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'reg_mobile', label: 'Mobile No.', kind: 'phone', required: ['new'], modes: ['new'], group: 'details', prefill: 'contact_number' },
      { key: 'phone', label: 'Phone No.', modes: ['new'], group: 'details', mono: true },
      { key: 'state', label: 'State', kind: 'select', options: GST_STATES, required: ['new'], modes: ['new'], group: 'details' },
      { key: 'district', label: 'District', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'pincode', label: 'PIN Code', required: ['new'], modes: ['new'], group: 'details', mono: true },
      { key: 'door_flat', label: 'Door / Flat No.', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'street', label: 'Street', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'village_town', label: 'Village / Town', required: ['new'], modes: ['new'], group: 'details' },
    ],
    password: { label: 'Password', required: true, rule: TNREGINET_PASSWORD },
  },
  {
    code: 'msme-udyam',
    title: 'MSME Udyam Registration',
    modes: FIRST_TIME_MODES,
    fields: [
      // First time: what the Udyam Registration form asks for first (Aadhaar verification).
      // Aadhaar is sensitive: encrypted like a password, revealed only on request.
      { key: 'aadhaar', label: 'Aadhaar Number', kind: 'secret', required: ['new'], modes: ['new'], group: 'details', placeholder: '12-digit Aadhaar' },
      { key: 'entrepreneur_name', label: 'Name of Entrepreneur', required: ['new'], modes: ['new'], group: 'details', placeholder: 'As per Aadhaar' },
      // The login — unchanged: the Udyam number and the mobile its OTP goes to.
      { key: 'udyam_number', label: 'Udyam Registration Number', required: ['existing'], placeholder: 'UDYAM-TN-00-0000000', mono: true },
      { key: 'signatory_mobile', label: 'Authorised Signatory’s Mobile', kind: 'phone', prefill: 'contact_number' },
      { key: 'signatory_email', label: 'Authorised Signatory’s Email', kind: 'email', prefill: 'email' },
    ],
  },
  {
    code: 'shops-establishment',
    title: 'Shops & Establishment Registration',
    modes: FIRST_TIME_MODES,
    fields: [
      // Already registered: the Labour Department login.
      { key: 'username', label: 'Username', required: ['existing'], mono: true, placeholder: 'Usually the registered email' },
      { key: 'licence_number', label: 'Shop Registration Number / Licence Number', modes: ['existing'], mono: true },
      // First time: the portal's applicant registration form.
      { key: 'applicant_name', label: 'Name of the Applicant', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'applicant_designation', label: 'Designation of the Applicant', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'dob', label: 'Date of Birth', kind: 'date', required: ['new'], modes: ['new'], group: 'details' },
      // Aadhaar is sensitive: encrypted like a password, revealed only on request.
      { key: 'aadhaar', label: 'Aadhaar Number', kind: 'secret', required: ['new'], modes: ['new'], group: 'details', placeholder: '12-digit Aadhaar' },
      { key: 'id_proof', label: 'ID Proof', kind: 'select', options: ['PAN', 'Ration Card', 'Voter ID', 'Driving Licence'], required: ['new'], modes: ['new'], group: 'details' },
      { key: 'id_proof_number', label: 'ID Proof Number', required: ['new'], modes: ['new'], group: 'details', mono: true, placeholder: 'The PAN / Ration Card / Voter ID / Licence number' },
      { key: 'state', label: 'State', kind: 'select', options: GST_STATES, required: ['new'], modes: ['new'], group: 'details' },
      { key: 'district', label: 'District', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'taluk', label: 'Taluk', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'village_town_city', label: 'Village / Town / City', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'street1', label: 'Street 1', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'street2', label: 'Street 2', modes: ['new'], group: 'details' },
      { key: 'door_number', label: 'Door Number / Plot Number', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'pincode', label: 'Pincode', required: ['new'], modes: ['new'], group: 'details', mono: true },
      { key: 'std_code', label: 'STD Code', modes: ['new'], group: 'details', mono: true },
      { key: 'telephone', label: 'Telephone Number', modes: ['new'], group: 'details', mono: true },
      { key: 'reg_mobile', label: 'Mobile Number (Employer / Proprietor / Owner)', kind: 'phone', required: ['new'], modes: ['new'], group: 'details', prefill: 'contact_number' },
      { key: 'reg_email', label: 'E-mail Address (Username)', kind: 'email', required: ['new'], modes: ['new'], group: 'details', prefill: 'email' },
    ],
    // Set on the portal's Security Details at registration; the login password after.
    password: { label: 'Password', required: true },
  },
  {
    code: 'import-export-code',
    title: 'Import Export Code (IEC)',
    modes: FIRST_TIME_MODES,
    fields: [
      // First time: the DGFT portal's user registration form.
      { key: 'register_as', label: 'Register User As', required: ['new'], modes: ['new'], group: 'details', placeholder: 'As chosen on the DGFT portal, e.g. IEC Applicant' },
      { key: 'first_name', label: 'First Name', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'last_name', label: 'Last Name', modes: ['new'], group: 'details' },
      { key: 'reg_email', label: 'Email ID', kind: 'email', required: ['new'], modes: ['new'], group: 'details', prefill: 'email' },
      { key: 'reg_mobile', label: 'Mobile No.', kind: 'phone', required: ['new'], modes: ['new'], group: 'details', prefill: 'contact_number' },
      { key: 'pincode', label: 'Pincode', required: ['new'], modes: ['new'], group: 'details', mono: true },
      { key: 'district', label: 'District', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'state', label: 'State', kind: 'select', options: GST_STATES, required: ['new'], modes: ['new'], group: 'details' },
      { key: 'city', label: 'City', required: ['new'], modes: ['new'], group: 'details' },
      // The DGFT login — once registered.
      { key: 'username', label: 'User Name', required: ['existing'], mono: true },
    ],
    password: { label: 'Password', required: ['existing'] },
  },
  {
    code: 'pf',
    title: 'PF Registration',
    // Two EPFO logins, no first-time section: Employer (unified employer
    // portal) and Employee (member portal, UAN).
    // Read top to bottom as two logins: Employee (UAN + password), then
    // Employer (username + password — the record's main password, shown last).
    fields: [
      { key: 'uan', label: 'Employee Login — UAN Number', required: true, mono: true, placeholder: '12-digit UAN' },
      { key: 'uan_password', label: 'Employee Login — Password', kind: 'secret', required: true },
      { key: 'username', label: 'Employer Login — Username', mono: true },
    ],
    password: { label: 'Employer Login — Password', required: false },
  },
  {
    code: 'esi',
    title: 'ESI Registration',
    modes: FIRST_TIME_MODES,
    fields: [
      // First time: the ESIC employer sign-up.
      { key: 'company_name', label: 'Company Name', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'principal_employer_name', label: 'Principal Employer Name', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'state', label: 'State', kind: 'select', options: GST_STATES, required: ['new'], modes: ['new'], group: 'details' },
      { key: 'region', label: 'Region', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'signup_email', label: 'Email (Username)', kind: 'email', required: ['new'], modes: ['new'], group: 'details', prefill: 'email' },
      { key: 'phone', label: 'Phone No.', kind: 'phone', modes: ['new'], group: 'details', prefill: 'contact_number' },
      { key: 'exclusive_contractor', label: 'Exclusive Labour Contractor / Man Power Supplier / Security Agency', kind: 'select', options: ['No', 'Yes'], modes: ['new'], group: 'details' },
      // First time: the Insured Person's USER SIGN UP (EmployeePortal) — creates the IP login below.
      { key: 'ip_insurance_number', label: 'IP Sign Up — Insurance Number', modes: ['new'], group: 'details', mono: true, placeholder: '10-digit IP number' },
      { key: 'ip_dob', label: 'IP Sign Up — Date of Birth', kind: 'date', modes: ['new'], group: 'details' },
      { key: 'ip_mobile', label: 'IP Sign Up — Mobile Number', kind: 'phone', modes: ['new'], group: 'details' },
      // Logins: Employer (Username / LIN + Password) and Insured Person (User ID + Password).
      { key: 'username', label: 'Employer Login — Username / LIN', required: ['existing'], mono: true },
      { key: 'ip_user_id', label: 'Insured Person Login — User ID', mono: true },
      { key: 'ip_password', label: 'Insured Person Login — Password', kind: 'secret' },
    ],
    password: { label: 'Employer Login — Password', required: ['existing'] },
  },
  {
    code: 'e-invoice',
    title: 'E-Invoice Registration',
    modes: FIRST_TIME_MODES,
    fields: [
      // Registration on the e-Invoice portal: enter the GSTIN; the portal
      // fills the business details from GST, then a username (6–15
      // characters) and password are chosen.
      { key: 'gstin', label: 'GSTIN', kind: 'gstin', required: ['new'], modes: ['new'], prefill: 'gstin', mono: true, group: 'details' },
      { key: 'trade_name', label: 'Trade Name', modes: ['new'], group: 'details', placeholder: 'Auto-populated by the portal from the GSTIN' },
      { key: 'legal_name', label: 'Legal Name', modes: ['new'], group: 'details', placeholder: 'Auto-populated by the portal from the GSTIN' },
      { key: 'address', label: 'Address / Place of Business', kind: 'textarea', modes: ['new'], group: 'details', placeholder: 'Auto-populated by the portal from the GSTIN' },
      { key: 'registered_mobile', label: 'Mobile Number', kind: 'phone', modes: ['new'], group: 'details', prefill: 'contact_number', placeholder: 'Shown masked on the portal' },
      { key: 'registered_email', label: 'Email ID', kind: 'email', modes: ['new'], group: 'details', prefill: 'email' },
      // The username chosen at registration (6–15 characters), or the existing login.
      { key: 'username', label: 'User Name', required: true, mono: true, placeholder: '6 to 15 characters', length: [6, 15] },
    ],
    password: { label: 'Password', required: true },
  },
  {
    code: 'e-way-bill',
    title: 'E-Way Bill Registration',
    modes: FIRST_TIME_MODES,
    fields: [
      // Registration on the e-Way Bill portal: enter the GSTIN; the portal
      // fills the business details from GST, sends an OTP, then a new
      // username and password are chosen. The OTP is never stored.
      { key: 'gstin', label: 'GSTIN', kind: 'gstin', required: ['new'], modes: ['new'], prefill: 'gstin', mono: true, group: 'details' },
      { key: 'trade_name', label: 'Trade Name', modes: ['new'], group: 'details', placeholder: 'Auto-populated by the portal from the GSTIN' },
      { key: 'legal_name', label: 'Legal Name', modes: ['new'], group: 'details', placeholder: 'Auto-populated by the portal from the GSTIN' },
      { key: 'address', label: 'Address / Building / Flat No', kind: 'textarea', modes: ['new'], group: 'details', placeholder: 'Auto-populated by the portal from the GSTIN' },
      { key: 'registered_mobile', label: 'Mobile No (OTP goes here)', kind: 'phone', modes: ['new'], group: 'details', prefill: 'contact_number', placeholder: 'Shown masked on the portal' },
      { key: 'registered_email', label: 'Mail ID', kind: 'email', modes: ['new'], group: 'details', prefill: 'email', placeholder: 'Shown masked on the portal' },
      // New username on registration; the existing one when already registered.
      { key: 'username', label: 'Username', required: true, mono: true, placeholder: 'New username chosen at registration' },
    ],
    password: { label: 'Password', required: true },
  },
  {
    // Income Tax e-Filing: the User ID is the PAN for individuals and entities
    // (or the Aadhaar / other User ID); new registrations collect what the
    // portal's "Register" flow asks for.
    code: 'income-tax-efiling',
    title: 'Income Tax e-Filing Registration',
    modes: FIRST_TIME_MODES,
    fields: [
      // Already registered: the e-Filing login.
      { key: 'username', label: 'User ID (PAN, Aadhaar or TAN)', required: ['existing'], mono: true, placeholder: 'Usually the PAN' },
      // First time: what the portal's Register form asks for.
      { key: 'pan', label: 'PAN', required: ['new'], modes: ['new'], group: 'details', mono: true, placeholder: 'AAAAA9999A' },
      { key: 'last_name', label: 'Last Name / Surname', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'middle_name', label: 'Middle Name', modes: ['new'], group: 'details' },
      { key: 'first_name', label: 'First Name', modes: ['new'], group: 'details' },
      { key: 'dob', label: 'Date of Birth', kind: 'date', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'gender', label: 'Gender', kind: 'select', options: ['Male', 'Female', 'Transgender'], required: ['new'], modes: ['new'], group: 'details' },
      { key: 'residential_status', label: 'Residential Status', kind: 'select', options: ['Resident', 'Non-Resident', 'Resident but Not Ordinarily Resident'], required: ['new'], modes: ['new'], group: 'details' },
      { key: 'registered_mobile', label: 'Mobile Number', kind: 'phone', required: ['new'], modes: ['new'], group: 'details', prefill: 'contact_number' },
      { key: 'mobile_belongs_to', label: 'Mobile Number belongs to', kind: 'select', options: BELONGS_TO, required: ['new'], modes: ['new'], group: 'details' },
      { key: 'registered_email', label: 'Email ID', kind: 'email', required: ['new'], modes: ['new'], group: 'details', prefill: 'email' },
      { key: 'email_belongs_to', label: 'Email ID belongs to', kind: 'select', options: BELONGS_TO, required: ['new'], modes: ['new'], group: 'details' },
      { key: 'landline', label: 'Landline Number', modes: ['new'], group: 'details', mono: true },
      { key: 'flat_door', label: 'Flat / Door / Block No', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'premises', label: 'Premises / Building / Village', modes: ['new'], group: 'details' },
      { key: 'road', label: 'Road / Street / Lane', modes: ['new'], group: 'details' },
      { key: 'area_locality', label: 'Area / Locality', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'pin_code', label: 'PIN Code', required: ['new'], modes: ['new'], group: 'details', mono: true },
      { key: 'post_office', label: 'Office / Sale Post Office', modes: ['new'], group: 'details' },
      { key: 'district_city', label: 'District / City', required: ['new'], modes: ['new'], group: 'details' },
      { key: 'state', label: 'State', kind: 'select', options: GST_STATES, required: ['new'], modes: ['new'], group: 'details' },
      { key: 'country', label: 'Country', required: ['new'], modes: ['new'], group: 'details', placeholder: 'India' },
      // Set at registration, confirmed on every login — kept so whoever signs in can check it.
      { key: 'secure_access_message', label: 'Secure Access Message', required: ['new'], placeholder: 'The message chosen at registration — confirm it matches on login' },
    ],
    password: { label: 'Password', required: true },
  },
]

const SPEC_BY_CODE = new Map(REGISTRATION_SPECS.map((s) => [s.code, s]))

function specFor(code: string): RegistrationSpec {
  const s = SPEC_BY_CODE.get(code)
  if (!s) throw ApiError.notFound('Unknown registration.')
  return s
}

const inMode = (modes: Mode[] | undefined, mode: Mode | null) => !modes || !mode || modes.includes(mode)
const requiredIn = (req: boolean | Mode[] | undefined, mode: Mode | null) =>
  req === true || (Array.isArray(req) && !!mode && req.includes(mode))

const cryptoField = (code: string) => `registration_${code.replace(/-/g, '_')}_password`

export const registrationCredentialsRouter = Router()

async function assertCanSeeClient(session: ReturnType<typeof requireSession>, scope: 'self' | 'department' | 'organisation', clientId: string) {
  const client = await prisma.client.findFirst({ where: { id: clientId, deletedAt: null }, select: { id: true, companyName: true } })
  if (!client) throw ApiError.notFound('Client not found.')
  const ids = await assignedClientIds(session, scope)
  if (ids !== 'ALL' && !ids.includes(client.id)) throw ApiError.notFound('Client not found.')
  return client
}

function parseFields(json: string): Record<string, string> {
  try {
    const v = JSON.parse(json) as unknown
    return v && typeof v === 'object' ? (v as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** Secret fields are stored encrypted inside fieldsJson with this prefix. */
const ENC = 'enc:'
const secretKeys = (spec: RegistrationSpec) => spec.fields.filter((f) => f.kind === 'secret').map((f) => f.key)
const secretField = (spec: RegistrationSpec, key: string) => `${cryptoField(spec.code)}_${key}`

/** Secret values never leave in a read — only whether each one is saved. */
function toApi(row: { mode: string | null; fieldsJson: string; passwordCiphertext: string | null; updatedAt: Date }, spec: RegistrationSpec) {
  const all = parseFields(row.fieldsJson)
  const secrets = secretKeys(spec)
  return {
    mode: row.mode,
    fields: Object.fromEntries(Object.entries(all).filter(([k]) => !secrets.includes(k))),
    password_present: !!row.passwordCiphertext,
    secrets_present: Object.fromEntries(secrets.map((k) => [k, typeof all[k] === 'string' && all[k].startsWith(ENC)])),
    updated_at: row.updatedAt,
  }
}

const findLive = (clientId: string, typeCode: string) =>
  prisma.registrationCredential.findFirst({ where: { clientId, typeCode, deletedAt: null } })

registrationCredentialsRouter.get('/specs', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, ...VIEW)
  ok(res, { items: REGISTRATION_SPECS })
}))

registrationCredentialsRouter.get('/:type/:clientId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...VIEW)
  const spec = specFor(req.params.type)
  await assertCanSeeClient(session, scope, req.params.clientId)
  const row = await findLive(req.params.clientId, spec.code)
  ok(res, { spec, record: row ? toApi(row, spec) : null })
}))

// PUT — `fields` holds the non-secret values. `password`: a string sets it;
// omitted keeps the stored one, so Edit can change the other fields alone.
registrationCredentialsRouter.put('/:type/:clientId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...VIEW)
  const spec = specFor(req.params.type)
  const client = await assertCanSeeClient(session, scope, req.params.clientId)

  const b = body(req)
  const e = new FieldErrors()
  let mode: Mode | null = null
  if (spec.modes) {
    mode = b.mode === 'new' || b.mode === 'existing' ? b.mode : null
    if (!mode) e.add('mode', 'Choose new registration or already registered.')
  }

  const raw = (b.fields && typeof b.fields === 'object' ? b.fields : {}) as Record<string, unknown>
  const fields: Record<string, string> = {}
  const existing = await findLive(client.id, spec.code)
  const stored = existing ? parseFields(existing.fieldsJson) : {}
  for (const f of spec.fields) {
    if (!inMode(f.modes, mode)) continue
    if (f.kind === 'secret') {
      // A typed value replaces it; blank keeps the stored one (like the password).
      const v = typeof raw[f.key] === 'string' ? (raw[f.key] as string) : ''
      if (v) {
        if (v.length > 200) e.add(`fields.${f.key}`, `${f.label} is too long.`)
        else fields[f.key] = ENC + encryptPortalSecret(v, secretField(spec, f.key))
      } else if (typeof stored[f.key] === 'string' && stored[f.key].startsWith(ENC)) {
        fields[f.key] = stored[f.key]
      } else if (requiredIn(f.required, mode)) {
        e.add(`fields.${f.key}`, `${f.label} is required.`)
      }
      continue
    }
    const v = typeof raw[f.key] === 'string' ? (raw[f.key] as string).trim() : ''
    if (!v) {
      if (requiredIn(f.required, mode)) e.add(`fields.${f.key}`, `${f.label} is required.`)
      continue
    }
    if (v.length > 500) { e.add(`fields.${f.key}`, `${f.label} is too long.`); continue }
    if (f.length && (v.length < f.length[0] || v.length > f.length[1])) e.add(`fields.${f.key}`, `${f.label} must be ${f.length[0]} to ${f.length[1]} characters.`)
    if (f.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) e.add(`fields.${f.key}`, `Enter a valid email for ${f.label}.`)
    if (f.kind === 'phone' && !/^\+?[0-9\s-]{10,15}$/.test(v)) e.add(`fields.${f.key}`, `Enter a valid mobile number for ${f.label}.`)
    if (f.kind === 'gstin' && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v.toUpperCase())) e.add(`fields.${f.key}`, 'Enter a valid 15-character GSTIN.')
    if (f.kind === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)))) e.add(`fields.${f.key}`, `Enter a valid date for ${f.label}.`)
    if (f.kind === 'select' && f.options && !f.options.includes(v)) e.add(`fields.${f.key}`, `Choose a value for ${f.label}.`)
    fields[f.key] = f.kind === 'gstin' ? v.toUpperCase() : v
  }

  const usesPassword = !!spec.password && inMode(spec.password.modes, mode)
  let password: string | undefined
  if (usesPassword) {
    if (typeof b.password === 'string' && b.password.length > 0) {
      if (b.password.length > 200) e.add('password', 'Password is too long.')
      else if (spec.password!.rule && !spec.password!.rule.test(b.password)) e.add('password', spec.password!.rule.message)
      else password = b.password
    } else if (!existing?.passwordCiphertext && requiredIn(spec.password!.required, mode)) {
      e.add('password', 'Password is required.')
    }
  }
  e.throwIfAny()

  const passwordData = !usesPassword
    ? { passwordCiphertext: null }
    : password !== undefined
      ? { passwordCiphertext: encryptPortalSecret(password, cryptoField(spec.code)) }
      : {}

  const row = await prisma.registrationCredential.upsert({
    where: { clientId_typeCode: { clientId: client.id, typeCode: spec.code } },
    create: {
      clientId: client.id, typeCode: spec.code, mode, fieldsJson: JSON.stringify(fields),
      passwordCiphertext: password !== undefined ? encryptPortalSecret(password, cryptoField(spec.code)) : null,
      createdBy: session.userId, updatedBy: session.userId,
    },
    // A soft-deleted record is revived rather than duplicated.
    update: { mode, fieldsJson: JSON.stringify(fields), ...passwordData, deletedAt: null, updatedBy: session.userId },
  })

  await writeAudit({
    actorUserId: session.userId,
    action: `registration_credential.${existing ? 'update' : 'create'}`,
    entityType: 'registration_credential', entityId: row.id,
    after: {
      client_id: client.id, registration: spec.code, mode,
      fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.startsWith(ENC) ? '<encrypted>' : v])),
      password: password !== undefined ? '<encrypted>' : usesPassword ? '<unchanged>' : '<none>',
    },
    req,
  })
  ok(res, { record: toApi(row, spec) }, existing ? 200 : 201)
}))

registrationCredentialsRouter.delete('/:type/:clientId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...VIEW)
  const spec = specFor(req.params.type)
  const client = await assertCanSeeClient(session, scope, req.params.clientId)
  const row = await findLive(client.id, spec.code)
  if (!row) throw ApiError.notFound('No saved details for this registration.')
  await prisma.registrationCredential.update({
    where: { id: row.id },
    // Secrets inside fieldsJson are wiped with the password.
    data: { deletedAt: new Date(), passwordCiphertext: null, fieldsJson: JSON.stringify(Object.fromEntries(Object.entries(parseFields(row.fieldsJson)).filter(([, v]) => !String(v).startsWith(ENC)))), updatedBy: session.userId },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'registration_credential.delete',
    entityType: 'registration_credential', entityId: row.id,
    after: { client_id: client.id, registration: spec.code }, req,
  })
  ok(res, { deleted: true })
}))

registrationCredentialsRouter.post('/:type/:clientId/reveal', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...REVEAL)
  const spec = specFor(req.params.type)
  const client = await assertCanSeeClient(session, scope, req.params.clientId)
  const row = await findLive(client.id, spec.code)
  // `field`: a secret field to reveal instead of the main password.
  const field = typeof body(req).field === 'string' ? String(body(req).field) : null
  let value: string | null
  if (field) {
    if (!secretKeys(spec).includes(field)) throw ApiError.badRequest('Unknown field.')
    const v = row ? parseFields(row.fieldsJson)[field] : undefined
    value = typeof v === 'string' && v.startsWith(ENC) ? decryptPortalSecret(v.slice(ENC.length), secretField(spec, field)) : null
  } else {
    value = row?.passwordCiphertext ? decryptPortalSecret(row.passwordCiphertext, cryptoField(spec.code)) : null
  }
  if (!row || value === null) throw ApiError.notFound('Nothing is saved for this registration.')
  const action = body(req).action === 'copy' ? 'copy' : 'show'
  await writeAudit({
    actorUserId: session.userId, action: 'registration_credential.reveal',
    entityType: 'registration_credential', entityId: row.id,
    after: { client_id: client.id, registration: spec.code, action, field: field ?? 'password' }, req,
  })
  res.setHeader('Cache-Control', 'no-store')
  ok(res, { value })
}))
