/**
 * Documents seed. Mix of types + statuses so the UI has range on first load.
 * Status is derived at read time from expiry_date + verification state.
 */

import type { EmployeeDocument } from '@/data/models';
import { addDays, istToday } from '@/lib/dates';

const now = new Date().toISOString();
const today = istToday();

function auditable(uploader = 'usr-hr') {
  return {
    created_at: now,
    updated_at: now,
    created_by: uploader,
    updated_by: uploader,
    deleted_at: null,
  };
}

export const employeeDocuments: EmployeeDocument[] = [
  {
    id: 'doc-md-offer',
    employee_id: 'emp-md',
    name: 'Offer letter — Managing Partner',
    type: 'employment',
    file_key: 'mock/offer-md.pdf',
    uploaded_by: 'usr-hr',
    uploaded_at: now,
    expiry_date: null,
    status: 'valid',
    ...auditable(),
  },
  {
    id: 'doc-hr-idcard',
    employee_id: 'emp-hr',
    name: 'ID card — Priya Nair',
    type: 'company_issued',
    file_key: 'mock/id-hr.pdf',
    uploaded_by: 'usr-hr',
    uploaded_at: now,
    expiry_date: addDays(today, 400),
    status: 'valid',
    ...auditable(),
  },
  {
    id: 'doc-exec-cert',
    employee_id: 'emp-exec',
    name: 'CA Intermediate certificate',
    type: 'certificate',
    file_key: 'mock/ca-inter-meera.pdf',
    uploaded_by: 'usr-hr',
    uploaded_at: now,
    expiry_date: null,
    status: 'valid',
    ...auditable(),
  },
  {
    id: 'doc-exec-pan',
    employee_id: 'emp-exec',
    name: 'PAN card',
    type: 'tax',
    file_key: 'mock/pan-meera.pdf',
    uploaded_by: 'usr-hr',
    uploaded_at: now,
    expiry_date: null,
    status: 'valid',
    ...auditable(),
  },
  {
    id: 'doc-articled-icai',
    employee_id: 'emp-articled',
    name: 'ICAI registration letter',
    type: 'icai',
    file_key: 'mock/icai-karthik.pdf',
    uploaded_by: 'usr-hr',
    uploaded_at: now,
    expiry_date: null,
    status: 'valid',
    ...auditable(),
  },
  {
    id: 'doc-mgr-passport',
    employee_id: 'emp-mgr',
    name: 'Passport',
    type: 'hr',
    file_key: 'mock/passport-vikram.pdf',
    uploaded_by: 'usr-hr',
    uploaded_at: now,
    expiry_date: addDays(today, 20), // Expiring Soon — will surface in Pending Actions
    status: 'expiring_soon',
    ...auditable(),
  },
  {
    id: 'doc-fin-tds',
    employee_id: 'emp-fin',
    name: 'TDS declaration FY25-26',
    type: 'tax',
    file_key: 'mock/tds-fin.pdf',
    uploaded_by: 'usr-hr',
    uploaded_at: now,
    expiry_date: addDays(today, -10), // Expired
    status: 'expired',
    ...auditable(),
  },
  {
    id: 'doc-probation-bank',
    employee_id: 'emp-probation',
    name: 'Bank details (pending verification)',
    type: 'bank',
    file_key: 'mock/bank-divya.pdf',
    uploaded_by: 'usr-emp',
    uploaded_at: now,
    expiry_date: null,
    status: 'pending_verification',
    ...auditable('usr-emp'),
  },
];
