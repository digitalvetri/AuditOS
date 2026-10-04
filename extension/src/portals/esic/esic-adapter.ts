/**
 * ESIC adapter — status SUPPORTED.
 * Verified 02 Oct 2026: Employer Login at portal.esic.gov.in/EmployerPortal/
 * ESICInsurancePortal/Portal_Loginnew.aspx — #txtUserName, #txtPassword;
 * CAPTCHA #txtChallanCaptcha is left to the user.
 * Insured Person login (03 Oct 2026): portal.esic.gov.in/EmployeePortal/login.aspx
 * — #txtIPNumber, #txtPassword; the server hands over the client's Insured
 * Person login there, never the employer's. CAPTCHA #txtCaptcha is left to the user.
 */
import { genericAdapter } from '../adapter';

export const esicAdapter = genericAdapter({
  portalId: 'ESIC',
  registrationIds: ['ESI_ESIC'],
  domains: ['esic.gov.in'],
  status: 'SUPPORTED',
  selectors: { username: '#txtUserName, #txtIPNumber', password: '#txtPassword' },
});
