/**
 * EWAYBILL adapter — status SUPPORTED.
 * Verified 02 Oct 2026: ewaybillgst.gov.in/Login.aspx — #txt_username,
 * #txt_password; CAPTCHA #txtCaptcha is left to the user.
 */
import { genericAdapter } from '../adapter';

export const ewaybillAdapter = genericAdapter({
  portalId: 'EWAYBILL',
  registrationIds: ['E_WAY_BILL'],
  domains: ['ewaybillgst.gov.in'],
  status: 'SUPPORTED',
  selectors: { username: '#txt_username', password: '#txt_password' },
});
