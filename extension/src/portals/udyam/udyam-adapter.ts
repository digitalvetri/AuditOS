/**
 * UDYAM adapter — status PARTIAL.
 * Verified 02 Oct 2026: Udyami Login (Udyam_Login.aspx) has NO password —
 * Udyam Registration Number + mobile, then a verification code and an OTP,
 * which the user always enters.
 */
import { genericAdapter } from '../adapter';

export const udyamAdapter = genericAdapter({
  portalId: 'UDYAM',
  registrationIds: ['MSME_UDYAM'],
  domains: ['udyamregistration.gov.in'],
  status: 'PARTIAL',
  selectors: {
    username: '#ctl00_ContentPlaceHolder1_txtUamNo',
    mobile: '#ctl00_ContentPlaceHolder1_txtMob',
  },
});
