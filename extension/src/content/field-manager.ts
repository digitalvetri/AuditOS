/**
 * Finding and filling login fields — framework-safe.
 *
 * Portals are built on React, Angular, jQuery, ASP.NET and Adobe AEM forms.
 * Some keep their own copy of a field's value and wipe anything that did not
 * arrive like typing (MCA's AEM User ID box does exactly that). So a value is
 * entered with the element's native setter plus the events typing produces,
 * then read back after a moment; if the page cleared it, it is typed again
 * character by character. Nothing is ever submitted.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const isVisible = (el: Element | null): el is HTMLElement => {
  if (!(el instanceof HTMLElement)) return false;
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
};

const usable = (el: HTMLInputElement) => !el.disabled && !el.readOnly && isVisible(el);

/** First VISIBLE element matching `selector` (pages often carry hidden duplicates). */
export function queryVisible<T extends HTMLElement = HTMLInputElement>(selector: string, root: ParentNode = document): T | null {
  return ([...root.querySelectorAll<T>(selector)].find((el) => isVisible(el)) ?? null);
}

/** The visible, enabled password input on the page. */
export function findPassword(root: ParentNode = document): HTMLInputElement | null {
  return [...root.querySelectorAll<HTMLInputElement>('input[type="password"]')].filter(usable)[0] ?? null;
}

/**
 * The username input that goes with `password`: the closest visible text /
 * email / tel input before it in the same form (or document order). Search
 * boxes, CAPTCHA and OTP inputs are skipped.
 */
export function findUsernameFor(password: HTMLInputElement): HTMLInputElement | null {
  const scope: ParentNode = password.form ?? document;
  const inputs = [...scope.querySelectorAll<HTMLInputElement>('input')].filter(usable);
  const idx = inputs.indexOf(password);
  for (let i = idx - 1; i >= 0; i--) {
    const el = inputs[i];
    const t = (el.type || 'text').toLowerCase();
    if (!['text', 'email', 'tel', 'number', ''].includes(t)) continue;
    const hint = `${el.name} ${el.id} ${el.placeholder} ${el.getAttribute('aria-label') ?? ''}`.toLowerCase();
    if (/captcha|otp|search|query/.test(hint)) continue;
    return el;
  }
  return null;
}

function nativeSetter(el: HTMLInputElement): (v: string) => void {
  const proto = Object.getPrototypeOf(el) as HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  return (v: string) => set?.call(el, v);
}

const fire = (el: HTMLElement, ev: Event) => el.dispatchEvent(ev);
const same = (a: string, b: string) => a === b || a.toUpperCase() === b.toUpperCase();

/** Enter `value` the way typing would be seen by the page; true if it stuck. */
export async function setValue(el: HTMLInputElement, value: string): Promise<boolean> {
  const set = nativeSetter(el);
  el.focus();
  fire(el, new FocusEvent('focusin', { bubbles: true }));

  // 1 · whole value at once, with the events typing produces.
  set('');
  fire(el, new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  set(value);
  fire(el, new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  fire(el, new KeyboardEvent('keyup', { bubbles: true, key: value.slice(-1) }));
  fire(el, new Event('change', { bubbles: true }));
  await sleep(250);

  // 2 · the page cleared it → type it character by character.
  if (!same(el.value, value)) {
    set('');
    for (const ch of value) {
      fire(el, new KeyboardEvent('keydown', { bubbles: true, key: ch }));
      fire(el, new KeyboardEvent('keypress', { bubbles: true, key: ch }));
      set(el.value + ch);
      fire(el, new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
      fire(el, new KeyboardEvent('keyup', { bubbles: true, key: ch }));
    }
    fire(el, new Event('change', { bubbles: true }));
    await sleep(250);
  }
  if (!same(el.value, value)) return false;

  // 3 · let the page validate on blur, but if blur wipes it, put it back.
  fire(el, new FocusEvent('focusout', { bubbles: true }));
  fire(el, new FocusEvent('blur'));
  await sleep(200);
  if (!same(el.value, value)) {
    el.focus();
    set(value);
    fire(el, new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    fire(el, new Event('change', { bubbles: true }));
    await sleep(150);
  }
  return same(el.value, value);
}
