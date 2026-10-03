/**
 * TNREGINET adapter — status PARTIAL.
 * Verified 02 Oct 2026: tnreginet.gov.in/portal/ carries a hidden #LoginForm
 * (#username, #password, CAPTCHA #txt_Captcha_login). It fills as soon as
 * the person opens the login and the form becomes visible.
 */
import { genericAdapter } from '../adapter';

export const tnreginetAdapter = genericAdapter({
  portalId: 'TNREGINET',
  registrationIds: ['PARTNERSHIP_FIRM'],
  domains: ['tnreginet.gov.in'],
  status: 'PARTIAL',
  selectors: { username: '#LoginForm #username', password: '#LoginForm #password' },
});
