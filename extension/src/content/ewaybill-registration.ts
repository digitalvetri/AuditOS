/**
 * E-Way Bill — Registration Form (ewaybillgst.gov.in/Account/EWBUserRegistration.aspx).
 * Field id from the page (03 Oct 2026): #ctl00_ContentPlaceHolder1_txt_gstin.
 * The CAPTCHA, Go, the OTP and choosing the new username / password on the
 * next steps are left to the person.
 */
import { queryVisible, setValue } from './field-manager';
import { waitFor } from './gst-registration';

const GSTIN = 'input#ctl00_ContentPlaceHolder1_txt_gstin';

export const isEwbRegistrationPage = () =>
  /(^|\.)ewaybillgst\.gov\.in$/.test(location.hostname) && /\/account\/ewbuserregistration\.aspx$/i.test(location.pathname);

export const waitForEwbRegistration = (ms: number) => waitFor(() => queryVisible(GSTIN), ms).then(Boolean);

export async function fillEwbRegistration(d: Record<string, string>): Promise<{ ok: boolean; message: string }> {
  const el = queryVisible<HTMLInputElement>(GSTIN);
  const gstin = (d.gstin ?? '').trim().toUpperCase();
  if (!gstin) return { ok: false, message: 'No GSTIN is saved. Add it in Registration → E-Way Bill → First-time registration.' };
  if (!el || !(await setValue(el, gstin))) return { ok: false, message: 'The GSTIN box did not accept the value. Enter it manually.' };
  return { ok: true, message: 'GSTIN filled. Type the CAPTCHA and click Go yourself.' };
}
