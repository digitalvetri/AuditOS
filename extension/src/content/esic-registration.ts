/**
 * ESIC sign-up forms (both under ESI Registration):
 *
 * Employer Sign Up — portal.esic.gov.in/ESICInsurance1/ESICInsurancePortal/ESICSignup.aspx
 * (03 Oct 2026): #ctl00_HomePageContent_txtFirstName (Company Name),
 * _txtLastName (Principal Employer Name), _ddlState (posts back, then the
 * page reloads with its regions), _ddlRegion, _txtUsername (Email),
 * _txtPhoneNo, _chkcategory (exclusive labour contractor / man power
 * supplier / security agency).
 *
 * Insured Person USER SIGN UP — portal.esic.gov.in/EmployeePortal/SignUp.aspx:
 * #txtIPNumber (10 digits), #txtDOB (dd/mm/yyyy), #txtMobileNo.
 *
 * CAPTCHA and Submit / Sign Up are left to the person.
 */
import { queryVisible, setValue } from './field-manager';
import { chooseByText, waitFor } from './gst-registration';

const P = '#ctl00_HomePageContent_';
const REGION_PENDING = 'auditos:esic-region';

export const isEsicEmployerSignupPage = () => /esic\.gov\.in$/.test(location.hostname) && /\/esicsignup\.aspx$/i.test(location.pathname);
export const isEsicIpSignupPage = () => /esic\.gov\.in$/.test(location.hostname) && /\/employeeportal\/signup\.aspx$/i.test(location.pathname);

export const waitForEsicSignup = (ms: number) =>
  waitFor(() => (isEsicEmployerSignupPage() ? queryVisible(`input${P}txtFirstName`) : queryVisible('input#txtDOB')), ms).then(Boolean);

type Result = { ok: boolean; message: string };
const done = (missed: string[], tail: string): Result =>
  missed.length ? { ok: true, message: `Sign-up form filled — check ${missed.join(', ')} yourself. ${tail}` } : { ok: true, message: `Sign-up form filled. ${tail}` };

async function text(missed: string[], label: string, sel: string, value: string | undefined, required = true) {
  if (!value) { if (required) missed.push(label); return; }
  const el = await waitFor(() => queryVisible<HTMLInputElement>(sel), 4_000);
  if (!el || !(await setValue(el, value))) missed.push(label);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The IP sign-up's Date of Birth is an AjaxControlToolkit MaskedEdit
 * (mask 99/99/9999). It keeps its own copy of what was typed and posts THAT —
 * a value set directly shows in the box but is posted as the empty mask, so
 * any post-back (Language, Sign Up) erased it. Type the digits as key presses
 * the mask control accepts instead.
 */
async function typeMasked(el: HTMLInputElement, formatted: string): Promise<boolean> {
  const digits = formatted.replace(/\D/g, '');
  el.focus();
  el.dispatchEvent(new FocusEvent('focus'));
  await sleep(150);
  try { el.setSelectionRange(0, 0); } catch { /* not a text input */ }
  for (const ch of digits) {
    const code = ch.charCodeAt(0);
    const init = { bubbles: true, cancelable: true, key: ch, code: `Digit${ch}`, keyCode: code, charCode: code, which: code } as KeyboardEventInit;
    el.dispatchEvent(new KeyboardEvent('keydown', { ...init, charCode: 0 } as KeyboardEventInit));
    const press = new KeyboardEvent('keypress', init);
    // The mask control handles the key itself and cancels it; if nothing did, insert it as typing would.
    if (el.dispatchEvent(press)) {
      const at = el.selectionStart ?? el.value.length;
      el.setRangeText(ch, at, at + 1, 'end');
    }
    el.dispatchEvent(new KeyboardEvent('keyup', { ...init, charCode: 0 } as KeyboardEventInit));
    await sleep(30);
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.blur();
  el.dispatchEvent(new FocusEvent('blur'));
  await sleep(200);
  return el.value.replace(/\D/g, '') === digits;
}

const DOB_KEEP = 'auditos:esic-dob';

/**
 * ESIC's own page drops the Date of Birth when the Language is changed (the
 * post-back re-renders it as __/__/____ — typed by hand or filled). Remember
 * it as the language changes and type it back after the reload. Runs on the
 * IP sign-up page whether or not this launch already filled it; the value
 * lives in the tab's session storage only until it is restored.
 */
export async function keepEsicDobAcrossLanguage(): Promise<void> {
  if (!isEsicIpSignupPage()) return;
  let kept: string | null = null;
  try { kept = sessionStorage.getItem(DOB_KEEP); sessionStorage.removeItem(DOB_KEEP); } catch { /* storage blocked */ }
  const dobEl = await waitFor(() => queryVisible<HTMLInputElement>('input#txtDOB'), 10_000);
  if (kept && dobEl && dobEl.value.replace(/\D/g, '') === '') await typeMasked(dobEl, kept);
  document.getElementById('ddlLanguage')?.addEventListener('change', () => {
    const v = document.querySelector<HTMLInputElement>('input#txtDOB')?.value ?? '';
    try { if (/^\d{2}\/\d{2}\/\d{4}$/.test(v)) sessionStorage.setItem(DOB_KEEP, v); } catch { /* storage blocked */ }
  });
}

/** The region list arrives after the State post-back reloads the page. */
async function pickRegion(region: string): Promise<boolean> {
  const el = await waitFor(() => {
    const s = document.querySelector<HTMLSelectElement>(`select${P}ddlRegion`);
    return s && s.options.length > 1 ? s : null;
  }, 10_000);
  return !!el && chooseByText(el, region);
}

/** After the State post-back: choose the region remembered before the reload (not sensitive). */
export async function resumeEsicEmployerSignup(): Promise<Result | null> {
  let region: string | null = null;
  try { region = sessionStorage.getItem(REGION_PENDING); sessionStorage.removeItem(REGION_PENDING); } catch { /* storage blocked */ }
  if (!region || !isEsicEmployerSignupPage()) return null;
  const ok = await pickRegion(region);
  return done(ok ? [] : ['Regions'], 'Type the CAPTCHA and submit yourself.');
}

export async function fillEsicSignup(d: Record<string, string>): Promise<Result> {
  const missed: string[] = [];
  if (isEsicIpSignupPage()) {
    const dob = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.ip_dob ?? '');
    await text(missed, 'Insurance Number', 'input#txtIPNumber', (d.ip_number ?? '').replace(/\D/g, ''));
    const dobEl = queryVisible<HTMLInputElement>('input#txtDOB');
    if (!dob || !dobEl || !(await typeMasked(dobEl, `${dob[3]}/${dob[2]}/${dob[1]}`))) missed.push('Date of Birth');
    await text(missed, 'Mobile Number', 'input#txtMobileNo', (d.ip_mobile ?? '').replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, ''));
    if (missed.length === 3) return { ok: false, message: 'No Insured Person sign-up details are saved. Add them in Registration → ESI → First-time registration.' };
    return done(missed, 'Type the CAPTCHA and click Sign Up yourself.');
  }

  await text(missed, 'Company Name', `input${P}txtFirstName`, d.company_name);
  await text(missed, 'Principal Employer Name', `input${P}txtLastName`, d.principal_employer_name);
  await text(missed, 'Email (Username)', `input${P}txtUsername`, d.email);
  await text(missed, 'Phone No.', `input${P}txtPhoneNo`, (d.phone ?? '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, ''), false);
  const chk = document.querySelector<HTMLInputElement>(`input${P}chkcategory`);
  if (chk && (d.exclusive_contractor === 'Yes') !== chk.checked) chk.click();

  // State posts back and reloads the page; the typed fields come back with it,
  // and the region is chosen once the reloaded page lists them.
  const state = document.querySelector<HTMLSelectElement>(`select${P}ddlState`);
  if (!d.state || !state) missed.push('State', 'Regions');
  else if (d.region) {
    try { sessionStorage.setItem(REGION_PENDING, d.region); } catch { /* storage blocked */ }
    if (!(await chooseByText(state, d.state))) { missed.push('State', 'Regions'); try { sessionStorage.removeItem(REGION_PENDING); } catch { /* */ } }
    else if (await pickRegion(d.region)) { try { sessionStorage.removeItem(REGION_PENDING); } catch { /* */ } } // no reload happened
  } else if (!(await chooseByText(state, d.state))) missed.push('State');
  if (missed.length >= 4) return { ok: false, message: 'The ESIC sign-up form did not accept the details. Fill it manually.' };
  return done(missed, 'Choose the Region if it is not selected, type the CAPTCHA and submit yourself.');
}
