/**
 * Config-table seed (§8.11 + §3).
 *   - ExpenseCategory (Part 2 Expenses consumes; Part 1 manages)
 *   - StatutoryRate (Part 2 Payroll consumes; Part 1 manages)
 *
 * Statutory values here are placeholders — [VERIFY] against current law
 * before payroll goes live. They live as DATA per §3, never as constants.
 */

import type { ExpenseCategory, StatutoryRate } from '@/data/models';
import { organisation } from './index';

const now = new Date().toISOString();
const audit = () => ({
  created_at: now,
  updated_at: now,
  created_by: null,
  updated_by: null,
  deleted_at: null,
});

const FY_START = '2026-04-01';

export const expenseCategories: ExpenseCategory[] = [
  { id: 'ec-travel', organisation_id: organisation.id, name: 'Travel', code: 'TRAVEL', is_active: true, requires_receipt: true, gl_account: '6100-Travel', ...audit() },
  { id: 'ec-meals', organisation_id: organisation.id, name: 'Meals & Entertainment', code: 'MEALS', is_active: true, requires_receipt: true, gl_account: '6110-Meals', ...audit() },
  { id: 'ec-phone', organisation_id: organisation.id, name: 'Phone & Internet', code: 'PHONE', is_active: true, requires_receipt: false, gl_account: '6200-Comms', ...audit() },
  { id: 'ec-sub', organisation_id: organisation.id, name: 'Subscriptions', code: 'SUB', is_active: true, requires_receipt: true, gl_account: '6300-Subs', ...audit() },
  { id: 'ec-office', organisation_id: organisation.id, name: 'Office Supplies', code: 'OFFICE', is_active: true, requires_receipt: true, gl_account: '6400-Office', ...audit() },
  { id: 'ec-other', organisation_id: organisation.id, name: 'Other', code: 'OTHER', is_active: true, requires_receipt: true, gl_account: '6900-Other', ...audit() },
];

export const statutoryRates: StatutoryRate[] = [
  {
    id: 'sr-pf-emp',
    organisation_id: organisation.id,
    code: 'pf.employee_rate',
    value: '0.12',
    effective_from: FY_START,
    effective_to: null,
    notes: '[VERIFY] EPF employee contribution rate',
    ...audit(),
  },
  {
    id: 'sr-pf-empr',
    organisation_id: organisation.id,
    code: 'pf.employer_rate',
    value: '0.12',
    effective_from: FY_START,
    effective_to: null,
    notes: '[VERIFY] EPF employer contribution rate',
    ...audit(),
  },
  {
    id: 'sr-pf-ceiling',
    organisation_id: organisation.id,
    code: 'pf.wage_ceiling',
    value: '15000',
    effective_from: FY_START,
    effective_to: null,
    notes: '[VERIFY] EPF monthly wage ceiling (₹). [DECIDE] restrict Basic to ceiling?',
    ...audit(),
  },
  {
    id: 'sr-esi-thresh',
    organisation_id: organisation.id,
    code: 'esi.gross_threshold',
    value: '21000',
    effective_from: FY_START,
    effective_to: null,
    notes: '[VERIFY] ESI applies when monthly gross ≤ this amount',
    ...audit(),
  },
  {
    id: 'sr-esi-emp',
    organisation_id: organisation.id,
    code: 'esi.employee_rate',
    value: '0.0075',
    effective_from: FY_START,
    effective_to: null,
    notes: '[VERIFY] ESI employee rate',
    ...audit(),
  },
  {
    id: 'sr-esi-empr',
    organisation_id: organisation.id,
    code: 'esi.employer_rate',
    value: '0.0325',
    effective_from: FY_START,
    effective_to: null,
    notes: '[VERIFY] ESI employer rate',
    ...audit(),
  },
  {
    id: 'sr-pt-tn',
    organisation_id: organisation.id,
    code: 'pt.tn.slab',
    // Half-yearly slab for Tamil Nadu (per Greater Chennai Corporation).
    // Format: JSON array of { half_yearly_income_up_to, tax_amount } — [VERIFY].
    value: JSON.stringify([
      { half_yearly_income_up_to: 21000, tax_amount: 0 },
      { half_yearly_income_up_to: 30000, tax_amount: 135 },
      { half_yearly_income_up_to: 45000, tax_amount: 315 },
      { half_yearly_income_up_to: 60000, tax_amount: 690 },
      { half_yearly_income_up_to: 75000, tax_amount: 1025 },
      { half_yearly_income_up_to: Number.MAX_SAFE_INTEGER, tax_amount: 1250 },
    ]),
    effective_from: FY_START,
    effective_to: null,
    notes: '[VERIFY] TN half-yearly Professional Tax slab (Chennai)',
    ...audit(),
  },
  {
    id: 'sr-gratuity',
    organisation_id: organisation.id,
    code: 'gratuity.eligible_after_years',
    value: '5',
    effective_from: FY_START,
    effective_to: null,
    notes: '[VERIFY] Continuous service years for gratuity eligibility',
    ...audit(),
  },
];
