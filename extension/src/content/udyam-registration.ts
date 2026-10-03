/**
 * Udyam Registration — Aadhaar Verification (udyamregistration.gov.in/UdyamRegistration.aspx).
 * Field ids from the page (03 Oct 2026): #ctl00_ContentPlaceHolder1_txtadharno
 * (12 digits) and #ctl00_ContentPlaceHolder1_txtownername (name as per
 * Aadhaar). "Validate & Generate OTP" and the OTP are left to the person.
 */
import { queryVisible, setValue } from './field-manager';
import { waitFor } from './gst-registration';

const AADHAAR = 'input#ctl00_ContentPlaceHolder1_txtadharno';
const NAME = 'input#ctl00_ContentPlaceHolder1_txtownername';

export const isUdyamRegistrationPage = () =>
  /(^|\.)udyamregistration\.gov\.in$/.test(location.hostname) && /\/udyamregistration\.aspx$/i.test(location.pathname);

export const waitForUdyamForm = (ms: number) => waitFor(() => queryVisible(AADHAAR), ms).then(Boolean);

export async function fillUdyamRegistration(d: Record<string, string>): Promise<{ ok: boolean; message: string }> {
  const missed: string[] = [];
  const text = async (label: string, sel: string, value: string | undefined) => {
    const el = value ? queryVisible<HTMLInputElement>(sel) : null;
    if (!el || !(await setValue(el, value!))) missed.push(label);
  };
  await text('Aadhaar Number', AADHAAR, (d.aadhaar ?? '').replace(/\D/g, ''));
  await text('Name of Entrepreneur', NAME, d.entrepreneur_name);
  if (missed.length === 2) return { ok: false, message: 'The Udyam form did not accept the details. Fill it manually.' };
  const tail = 'Click “Validate & Generate OTP” and enter the OTP yourself.';
  return missed.length ? { ok: true, message: `Udyam form filled — check ${missed.join(', ')} yourself. ${tail}` } : { ok: true, message: `Udyam form filled. ${tail}` };
}
