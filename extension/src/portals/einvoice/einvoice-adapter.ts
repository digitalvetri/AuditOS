/**
 * EINVOICE adapter — status SUPPORTED.
 * Verified 02 Oct 2026: "Login" on einvoice.gst.gov.in goes to the GST login
 * page services.gst.gov.in/services/login?flag=einvoice (#username, #user_pass).
 * The E-Invoice login is used — never the GST one: the registration in the
 * CRM context decides, not the page.
 */
import { genericAdapter } from '../adapter';

export const einvoiceAdapter = genericAdapter({
  portalId: 'EINVOICE',
  registrationIds: ['E_INVOICE'],
  domains: ['einvoice.gst.gov.in', 'services.gst.gov.in'],
  status: 'SUPPORTED',
  selectors: { username: 'form[name="loginform"] #username', password: 'form[name="loginform"] input#user_pass' },
});
