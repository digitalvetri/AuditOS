/**
 * GST adapter — status SUPPORTED.
 * Verified 02 Oct 2026: "Login" on www.gst.gov.in goes to
 * services.gst.gov.in/services/login — form[name=loginform] with #username
 * and a visible #user_pass (a hidden duplicate password input is skipped).
 */
import { genericAdapter } from '../adapter';

export const gstAdapter = genericAdapter({
  portalId: 'GST',
  registrationIds: ['GST_REGISTRATION'],
  domains: ['gst.gov.in'],
  status: 'SUPPORTED',
  selectors: { username: 'form[name="loginform"] #username', password: 'form[name="loginform"] input#user_pass' },
});
