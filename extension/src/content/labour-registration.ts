/**
 * Labour Department TN — applicant REGISTRATION FORM
 * (labour.tn.gov.in/services/Applicants/applicantRegistration).
 * Field ids from the page (03 Oct 2026): #name, #designation, #dob
 * (dd-mm-yyyy), #aadhaar-no, #id-proof → #pan / #ration / #voting / #licence,
 * the address chain #state-id → #district-id → #taluk-id →
 * #revenue-village-id → #street-id (each list loads after the one before),
 * #street-two, #door-no, #pincode, #std-code, #telephone-no, #mobile-no,
 * #email, #password, #retype-pwd. Document uploads, CAPTCHA and the OTPs are
 * left to the person; nothing is submitted.
 */
import { queryVisible, setValue } from './field-manager';
import { chooseByText, waitFor } from './gst-registration';

export const isLabourRegistrationPage = () =>
  location.hostname === 'labour.tn.gov.in' && /\/applicants\/applicantregistration/i.test(location.pathname);

const formShown = () => !!queryVisible('input#name') && !!document.querySelector('select#state-id');

export function waitForLabourForm(timeoutMs: number): Promise<boolean> {
  if (formShown()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (v: boolean) => { obs.disconnect(); clearTimeout(t); resolve(v); };
    const obs = new MutationObserver(() => { if (formShown()) done(true); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    const t = setTimeout(() => done(formShown()), timeoutMs);
  });
}

/** yyyy-mm-dd (as saved) → dd-mm-yyyy (as the form wants). */
const dmy = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v.split('-').reverse().join('-') : v);

const ID_INPUT: [RegExp, string][] = [[/pan/i, 'input#pan'], [/ration/i, 'input#ration'], [/voter/i, 'input#voting'], [/driv|licen/i, 'input#licence']];

export async function fillLabourRegistration(d: Record<string, string>): Promise<{ ok: boolean; message: string }> {
  const missed: string[] = [];
  const text = async (label: string, sel: string, value: string | undefined, required = true) => {
    if (!value) { if (required) missed.push(label); return; }
    const el = await waitFor(() => queryVisible<HTMLInputElement>(sel), 4_000);
    if (!el || !(await setValue(el, value))) missed.push(label);
  };
  /** A select whose options arrive after the previous choice. */
  const pick = async (label: string, sel: string, value: string | undefined) => {
    if (!value) { missed.push(label); return false; }
    const el = await waitFor(() => {
      const s = document.querySelector<HTMLSelectElement>(sel);
      return s && s.options.length > 1 ? s : null;
    }, 10_000);
    const ok = !!el && (await chooseByText(el, value));
    if (!ok) missed.push(label);
    return ok;
  };

  await text('Name of the Applicant', 'input#name', d.name);
  await text('Designation', 'input#designation', d.designation);
  await text('Date of Birth', 'input#dob', dmy(d.dob ?? ''));
  await text('Aadhaar Number', 'input#aadhaar-no', (d.aadhaar ?? '').replace(/\s/g, ''));
  if (await pick('ID Proof', 'select#id-proof', d.id_proof)) {
    const sel = ID_INPUT.find(([re]) => re.test(d.id_proof))?.[1];
    if (sel) await text('ID Proof Number', sel, d.id_number);
  }
  // Address: each list loads after the one before it.
  if (await pick('State', 'select#state-id', d.state))
    if (await pick('District', 'select#district-id', d.district))
      if (await pick('Taluk', 'select#taluk-id', d.taluk))
        if (await pick('Village / Town / City', 'select#revenue-village-id', d.village))
          await pick('Street 1', 'select#street-id', d.street1);
  await text('Street 2', 'input#street-two', d.street2, false);
  await text('Door Number', 'input#door-no', d.door_no);
  await text('Pincode', 'input#pincode', d.pincode);
  await text('STD code', 'input#std-code', d.std_code, false);
  await text('Telephone', 'input#telephone-no', d.telephone, false);
  await text('Mobile Number', 'input#mobile-no', (d.mobile ?? '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, ''));
  await text('E-mail Address', 'input#email', d.email);
  if (d.password) {
    await text('Password', 'input#password', d.password);
    await text('Retype Password', 'input#retype-pwd', d.password);
  } else missed.push('Password');

  if (missed.length >= 12) return { ok: false, message: 'The registration form did not accept the details. Fill it manually.' };
  const tail = 'Upload the documents, verify mobile and e-mail, and type the CAPTCHA yourself.';
  return missed.length
    ? { ok: true, message: `Registration form filled — check ${missed.join(', ')} yourself. ${tail}` }
    : { ok: true, message: `Registration form filled. ${tail}` };
}
