/**
 * LABOUR_TN adapter — status SUPPORTED.
 *
 * Verified 02 Oct 2026: the Shops & Establishment login is
 * labour.tn.gov.in/services/users/login — form#userLogin with
 * input[name=username], input[name=password]; CAPTCHA (captcha_code) is left
 * to the user.
 *
 * The same domain hosts other systems with their own logins (e.g. the Migrant
 * Workers portal at /ism/users/login), so this only fills under /services/ —
 * a Shops login is never typed into another department's system.
 */
import { genericAdapter } from '../adapter';

export const labourAdapter = genericAdapter({
  portalId: 'LABOUR_TN',
  registrationIds: ['SHOPS_ESTABLISHMENT'],
  domains: ['labour.tn.gov.in'],
  status: 'SUPPORTED',
  paths: ['/services/'],
  selectors: { username: 'form#userLogin input[name="username"]', password: 'form#userLogin input[name="password"]' },
});
