/**
 * Income Tax e-Filing adapter — status PARTIAL.
 *
 * Inspected 02 Oct 2026: "Login" on www.incometax.gov.in/iec/foportal/ goes to
 * eportal.incometax.gov.in/iec/foservices/#/login — a two-screen login:
 *   1 · #panAdhaarUserId  (PAN / Aadhaar / Other User ID) → Continue (the person)
 *   2 · password screen   → the visible password box is filled
 * Screen 2 was not inspected (reaching it means submitting a real User ID),
 * hence PARTIAL. The secure-access confirmation and any OTP stay with the person.
 */
import { genericAdapter } from '../adapter';

export const itdAdapter = genericAdapter({
  portalId: 'ITD',
  registrationIds: ['INCOME_TAX_EFILING'],
  domains: ['incometax.gov.in'],
  status: 'PARTIAL',
  twoStep: true,
  selectors: { username: '#panAdhaarUserId', password: 'input[type="password"]' },
});
