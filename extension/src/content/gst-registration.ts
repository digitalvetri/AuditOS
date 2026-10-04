/**
 * GST portal — New Registration, Part A (reg.gst.gov.in/registration/).
 * Field ids from the portal's own template (/pages/registration/newrg/index.html,
 * read 03 Oct 2026): #radionew, #applnType, #applnState, #applnDistr (loads
 * after the state), #bnm, #pan_card, #email, #mobile. Selects are matched by
 * their visible text, so the portal's internal codes never matter.
 * The captcha is never filled and nothing is submitted.
 */
import { isVisible, queryVisible, setValue } from './field-manager';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const isGstNewRegistrationPage = () =>
  location.hostname === 'reg.gst.gov.in' && location.pathname.startsWith('/registration');

/** The Part A form is on screen (Angular renders it after the page loads). */
const formShown = () => !!queryVisible<HTMLSelectElement>('select#applnType') && (queryVisible<HTMLSelectElement>('select#applnType')?.options.length ?? 0) > 1;

export function waitForGstForm(timeoutMs: number): Promise<boolean> {
  if (formShown()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (v: boolean) => { obs.disconnect(); clearTimeout(t); resolve(v); };
    const obs = new MutationObserver(() => { if (formShown()) done(true); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    const t = setTimeout(() => done(formShown()), timeoutMs);
  });
}

export async function waitFor<T>(get: () => T | null, ms = 10_000): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(100);
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Choose the option whose text matches `wanted` (exact, else starts with / contains). */
export async function chooseByText(select: HTMLSelectElement, wanted: string): Promise<boolean> {
  const w = norm(wanted);
  if (!w) return false;
  const opts = [...select.options].filter((o) => o.value && o.value !== '?' && !o.disabled);
  const hit = opts.find((o) => norm(o.text) === w) ?? opts.find((o) => norm(o.text).startsWith(w)) ?? opts.find((o) => norm(o.text).includes(w) || w.includes(norm(o.text)));
  if (!hit) return false;
  select.focus();
  select.value = hit.value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  select.dispatchEvent(new FocusEvent('blur'));
  await sleep(150);
  return select.value === hit.value;
}

export async function fillGstNewRegistration(raw: Record<string, string>): Promise<{ ok: boolean; message: string }> {
  const d = { applicant_type: '', state: '', district: '', legal_name: '', pan: '', email: '', mobile: '', ...raw };
  const missed: string[] = [];
  // "New Registration" (not TRN).
  const radio = document.querySelector<HTMLInputElement>('input#radionew');
  if (radio && !radio.checked) { radio.click(); await sleep(400); }

  const type = queryVisible<HTMLSelectElement>('select#applnType');
  if (!type || !(await chooseByText(type, d.applicant_type || 'Taxpayer'))) missed.push('I am a');

  const state = queryVisible<HTMLSelectElement>('select#applnState');
  if (d.state) {
    if (!state || !(await chooseByText(state, d.state))) missed.push('State/UT');
  } else missed.push('State/UT');

  // Districts arrive from the portal after the state is chosen.
  if (d.district) {
    const distr = await waitFor(() => {
      const el = queryVisible<HTMLSelectElement>('select#applnDistr');
      return el && el.options.length > 1 ? el : null;
    });
    if (!distr || !(await chooseByText(distr, d.district))) missed.push('District');
  }

  // Legal name / PAN / email / mobile render once the applicant type is set.
  const field = (sel: string) => waitFor(() => queryVisible<HTMLInputElement>(sel), 5_000);
  for (const [label, sel, value] of [
    ['Legal Name', 'input#bnm', d.legal_name],
    ['PAN', 'input#pan_card', d.pan.toUpperCase()],
    ['Email', 'input#email', d.email],
    ['Mobile', 'input#mobile', d.mobile.replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '')],
  ] as const) {
    if (!value) { missed.push(label); continue; }
    const el = await field(sel);
    if (!el || !isVisible(el) || !(await setValue(el, value))) missed.push(label);
  }

  if (missed.length === 7) return { ok: false, message: 'The New Registration form did not accept the details. Fill it manually.' };
  return missed.length
    ? { ok: true, message: `New Registration filled — check ${missed.join(', ')} yourself, then type the captcha and click Proceed.` }
    : { ok: true, message: 'New Registration filled. Check the details, type the captcha, then click Proceed.' };
}
