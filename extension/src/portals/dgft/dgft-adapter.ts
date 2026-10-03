/**
 * DGFT adapter — status PARTIAL (selectors verified 02 Oct 2026 against
 * https://www.dgft.gov.in/CP/).
 *
 * The starting page has no login form; "Login" calls loginPopup.openPopup()
 * which shows #LoginForm with:
 *   #username     Email ID      (filled)
 *   #password     Password      (filled)
 *   #txt_Captcha  CAPTCHA       (never touched — the user enters it)
 * PARTIAL because the form lives in a pop-up the adapter has to open first.
 */
import { genericAdapter } from '../adapter';

export const dgftAdapter = genericAdapter({
  portalId: 'DGFT',
  registrationIds: ['IEC_REGISTRATION'],
  domains: ['dgft.gov.in'],
  status: 'PARTIAL',
  selectors: { username: '#LoginForm #username', password: '#LoginForm #password' },
  openLogin: () => {
    const pw = document.querySelector<HTMLInputElement>('#LoginForm #password');
    if (pw && (pw.offsetWidth > 0 || pw.offsetHeight > 0)) return false; // already open
    const link = document.querySelector<HTMLElement>('a[onclick*="loginPopup.openPopup"], button[onclick*="loginPopup.openPopup"]');
    if (!link) return false;
    link.click();
    return true;
  },
});
