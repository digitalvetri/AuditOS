/**
 * EPFO adapter — status PARTIAL.
 *
 * Inspected 02 Oct 2026: the employer login is
 * unifiedportal-emp.epfindia.gov.in/epfo/ — #AuthenticationForm with
 *   #username1, #password   (filled)
 *   #captcha                (left to the user)
 * PARTIAL: not live-tested by us (the site blocks automated browsers).
 */
import { genericAdapter } from '../adapter';

export const epfoAdapter = genericAdapter({
  portalId: 'EPFO',
  registrationIds: ['PF_EPFO'],
  domains: ['epfo.gov.in', 'epfindia.gov.in'],
  status: 'PARTIAL',
  // Employer portal (#username1) or the member portal's UAN login (#userName, 03 Oct 2026).
  // The server hands over the UAN login on the member portal, never the employer's.
  selectors: { username: '#AuthenticationForm #username1, input#userName', password: '#AuthenticationForm #password, input#password' },
});
