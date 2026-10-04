/**
 * TNREGINET — user registration form ("பயனர் பதிவு" / Sign Up), loaded into
 * tnreginet.gov.in/portal/ by fn_signup() (webHP?…actionVal=tnIgrsRegister).
 * Field ids from the page (03 Oct 2026): #cmb_UserType, #txt_UserName,
 * #txt_Password, #txt_ConfirmPassword, #txt_SecurityQuest, #txt_Answer,
 * #cmb_Salutation, #txt_FirstName, #txt_MiddleName, #txt_Surname, #cmb_Gender,
 * #txt_id_Type, #txt_id_No, #txt_EmailAddress, #txt_ConfirmEmailAddress,
 * #day / #month / #year, #txt_Mobile, #txt_Phone, #cmb_state → #cmb_district
 * (loads after the state), #txt_Pincode, #txt_DoorFlat, #txt_Street,
 * #txt_VillageTown. The page can be in Tamil or English, so lists are chosen
 * by their option VALUES where those are fixed. CAPTCHA, OTP and "Complete
 * Registration" are left to the person; nothing is submitted.
 */
import { queryVisible, setValue } from './field-manager';
import { chooseByText, waitFor } from './gst-registration';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const formShown = () => !!queryVisible('input#txt_UserName') && !!document.querySelector('select#cmb_UserType');
export const isTnreginetRegistrationShown = formShown;

export function waitForTnreginetRegistration(timeoutMs: number): Promise<boolean> {
  if (formShown()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (v: boolean) => { obs.disconnect(); clearTimeout(t); resolve(v); };
    const obs = new MutationObserver(() => { if (formShown()) done(true); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    const t = setTimeout(() => done(formShown()), timeoutMs);
  });
}

// The portal's fixed option values (the same in Tamil and English).
const USER_TYPE: Record<string, string> = { citizen: '7000001' };
const SALUTATION: Record<string, string> = { 'mr.': '1', 'mrs.': '2', 'ms.': '4', master: '15', transgender: '6' };
const GENDER: Record<string, string> = { male: '7000002', female: '7000003', transgender: '7000004' };
const ID_TYPE: Record<string, string> = { aadhaar: '15', pan: '4', 'driving licence': '3', passport: '2', 'oci passport': '21' };
const STATE: Record<string, string> = { 'tamil nadu': '1' };

/** Select by option value; fires the page's own onchange (which loads dependent lists). */
async function chooseValue(sel: HTMLSelectElement, value: string): Promise<boolean> {
  if (![...sel.options].some((o) => o.value === value)) return false;
  sel.focus();
  sel.value = value;
  sel.dispatchEvent(new Event('input', { bubbles: true }));
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  sel.dispatchEvent(new FocusEvent('blur'));
  await sleep(150);
  return sel.value === value;
}

export async function fillTnreginetRegistration(d: Record<string, string>): Promise<{ ok: boolean; message: string }> {
  const missed: string[] = [];
  const text = async (label: string, sel: string, value: string | undefined, required = true) => {
    if (!value) { if (required) missed.push(label); return; }
    const el = await waitFor(() => queryVisible<HTMLInputElement>(sel), 4_000);
    if (!el || !(await setValue(el, value))) missed.push(label);
  };
  /** A list: by the portal's fixed value when known, else by visible text. */
  const pick = async (label: string, sel: string, value: string | undefined, values?: Record<string, string>, waitMs = 4_000) => {
    if (!value) { missed.push(label); return false; }
    const el = await waitFor(() => {
      const s = document.querySelector<HTMLSelectElement>(sel);
      return s && s.options.length > 1 ? s : null;
    }, waitMs);
    const known = values?.[value.trim().toLowerCase()];
    const ok = !!el && (known ? await chooseValue(el, known) : await chooseByText(el, value));
    if (!ok) missed.push(label);
    return ok;
  };

  await pick('User Type', 'select#cmb_UserType', d.user_type, USER_TYPE);
  await sleep(600); // the user type loads its password policy
  await text('User Name', 'input#txt_UserName', d.username);
  if (d.password) {
    await text('Password', 'input#txt_Password', d.password);
    await text('Confirm Password', 'input#txt_ConfirmPassword', d.password);
  } else missed.push('Password');

  // Security question: by its text; the portal currently lists only one.
  const q = document.querySelector<HTMLSelectElement>('select#txt_SecurityQuest');
  const real = q ? [...q.options].filter((o) => o.value && o.value !== '-1') : [];
  if (!q || !((d.security_question && (await chooseByText(q, d.security_question))) || (real.length === 1 && (await chooseValue(q, real[0].value))))) missed.push('Security Question');
  await text('Answer', 'input#txt_Answer', d.security_answer);

  // Salutation first: the page then sets a matching gender, which we confirm.
  await pick('Salutation', 'select#cmb_Salutation', d.salutation, SALUTATION);
  await text('First Name', 'input#txt_FirstName', d.first_name);
  await text('Middle Name', 'input#txt_MiddleName', d.middle_name, false);
  await text('Last Name', 'input#txt_Surname', d.last_name, false);
  await pick('Gender', 'select#cmb_Gender', d.gender, GENDER);
  await pick('Identification Type', 'select#txt_id_Type', d.identification_type, ID_TYPE);
  await text('Identification No.', 'input#txt_id_No', (d.identification_no ?? '').replace(/\s/g, ''));

  await text('Email Address', 'input#txt_EmailAddress', d.email);
  await text('Confirm Email Address', 'input#txt_ConfirmEmailAddress', d.email);
  const dob = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.dob ?? '');
  if (dob) {
    // Year and month first: the day list depends on them.
    const [, y, m, day] = dob;
    if (await pick('Date of Birth (year)', 'select#year', y, { [y]: y }))
      if (await pick('Date of Birth (month)', 'select#month', m, { [m]: m }))
        await pick('Date of Birth (day)', 'select#day', day, { [day]: day });
  } else missed.push('Date of Birth');
  await text('Mobile No.', 'input#txt_Mobile', (d.mobile ?? '').replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, ''));
  await text('Phone No.', 'input#txt_Phone', (d.phone ?? '').replace(/\D/g, ''), false);

  // Address: the district list loads after the state.
  if (await pick('State', 'select#cmb_state', d.state, STATE)) {
    const list = document.querySelector<HTMLSelectElement>('select#cmb_district');
    const free = queryVisible<HTMLInputElement>('input#txt_District');
    if (free && (!list || list.offsetParent === null)) await text('District', 'input#txt_District', d.district);
    else await pick('District', 'select#cmb_district', d.district, undefined, 10_000);
  }
  await text('PIN Code', 'input#txt_Pincode', d.pincode);
  await text('Door / Flat No.', 'input#txt_DoorFlat', d.door_flat);
  await text('Street', 'input#txt_Street', d.street);
  await text('Village / Town', 'input#txt_VillageTown', d.village_town);

  if (missed.length >= 12) return { ok: false, message: 'The registration form did not accept the details. Fill it manually.' };
  const tail = 'Type the CAPTCHA, get the OTP and complete the registration yourself.';
  return missed.length
    ? { ok: true, message: `Registration form filled — check ${missed.join(', ')} yourself. ${tail}` }
    : { ok: true, message: `Registration form filled. ${tail}` };
}
