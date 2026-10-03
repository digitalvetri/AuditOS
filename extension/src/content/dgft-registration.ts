/**
 * DGFT — REGISTER tab of the Login / Register pop-up (www.dgft.gov.in/CP/).
 * The pop-up is built at runtime (loginPopup.openPopup()), so fields are found
 * by their visible labels — exactly what the person sees: Register User As,
 * First Name, Last Name, Email ID, Mobile No., Pincode, District, State, City.
 * Only inside the panel holding "Register User As", so the LOGIN tab's fields
 * are never touched. CAPTCHA, terms and Send OTP are left to the person.
 */
import { isVisible, setValue } from './field-manager';
import { chooseByText, waitFor } from './gst-registration';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) => s.toLowerCase().replace(/\*/g, '').replace(/[^a-z0-9]/g, '');

/** The visible element whose own text is exactly `text` (a label). */
function labelEl(text: string, root: ParentNode = document): HTMLElement | null {
  const want = norm(text);
  // Real <label>s first; other text elements only as a fallback.
  for (const sel of ['label', 'span, p, b, strong, div']) {
    for (const el of root.querySelectorAll<HTMLElement>(sel)) {
      if (!isVisible(el) || el.children.length > 2) continue;
      if (norm(el.textContent ?? '') === want) return el;
    }
  }
  return null;
}

/** The register panel: the closest container that holds the "Register User As" label and a few fields. */
function registerPanel(): HTMLElement | null {
  const l = labelEl('Register User As');
  let el: HTMLElement | null = l;
  for (let i = 0; el && i < 8; i++) {
    if (el.querySelectorAll('input, select').length >= 6) return el;
    el = el.parentElement;
  }
  return null;
}

export const isDgftRegisterShown = () => !!registerPanel();

/** The input / select a label belongs to: label[for], else the first control after it in its group. */
function controlFor(panel: HTMLElement, text: string): HTMLInputElement | HTMLSelectElement | null {
  const l = labelEl(text, panel);
  if (!l) return null;
  const forId = l.getAttribute('for');
  if (forId) {
    const c = document.getElementById(forId) as HTMLInputElement | HTMLSelectElement | null;
    if (c && isVisible(c)) return c;
  }
  // Its own group first (a wrapper holding just this field), then outward.
  let box: HTMLElement | null = l;
  for (let i = 0; box && i < 4; i++) {
    const c = [...box.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select')].find((x) => isVisible(x));
    if (c) return c;
    box = box.parentElement;
  }
  return null;
}

export function waitForDgftRegister(timeoutMs: number): Promise<boolean> {
  if (isDgftRegisterShown()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (v: boolean) => { obs.disconnect(); clearTimeout(t); resolve(v); };
    const obs = new MutationObserver(() => { if (isDgftRegisterShown()) done(true); });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    const t = setTimeout(() => done(isDgftRegisterShown()), timeoutMs);
  });
}

export async function fillDgftRegistration(d: Record<string, string>): Promise<{ ok: boolean; message: string }> {
  const panel = registerPanel();
  if (!panel) return { ok: false, message: 'The Register form is not open.' };
  const missed: string[] = [];
  const put = async (label: string, value: string | undefined) => {
    if (!value) { missed.push(label); return; }
    const c = controlFor(panel, label);
    if (!c) { missed.push(label); return; }
    const okay = c instanceof HTMLSelectElement ? await chooseByText(c, value) : await setValue(c, value);
    if (!okay) missed.push(label);
  };
  await put('Register User As', d.register_as);
  await sleep(400);
  await put('First Name', d.first_name);
  if (d.last_name) await put('Last Name', d.last_name);
  await put('Email ID', d.email);
  await put('Mobile No.', (d.mobile ?? '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, ''));
  await put('Pincode', d.pincode);
  await sleep(800); // the portal may look up the pincode
  await put('State', d.state);
  // Districts load once the state is chosen.
  if (d.district) {
    const ready = await waitFor(() => {
      const c = controlFor(panel, 'District');
      return c instanceof HTMLSelectElement && c.options.length > 1 ? c : null;
    }, 8_000);
    if (!ready || !(await chooseByText(ready, d.district))) missed.push('District');
  } else missed.push('District');
  await put('City', d.city);
  if (missed.length >= 8) return { ok: false, message: 'The Register form did not accept the details. Fill it manually.' };
  return missed.length
    ? { ok: true, message: `Register form filled — check ${missed.join(', ')} yourself, then type the CAPTCHA, accept the terms and click Send OTP.` }
    : { ok: true, message: 'Register form filled. Type the CAPTCHA, accept the terms and click Send OTP.' };
}
