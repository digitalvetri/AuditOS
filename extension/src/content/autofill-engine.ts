/**
 * Detect the login form (it may render late), ask the service worker for this
 * tab's credential, fill username + password, verify, stop. CAPTCHA, OTP, MFA
 * and DSC are always left to the user.
 */
import type { PortalAdapter } from '../portals/adapter';
import { withCredential } from '../security/credential-handler';
import type { Credential } from '../types';
import { send } from './messaging';

/** Wait for a login form: MutationObserver with a hard timeout — never polls forever. */
export function waitForLogin(adapter: PortalAdapter, timeoutMs = 20_000): Promise<boolean> {
  if (adapter.isLoginPage()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (v: boolean) => { obs.disconnect(); clearTimeout(t); resolve(v); };
    const obs = new MutationObserver(() => { if (adapter.isLoginPage()) done(true); });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'style', 'class', 'hidden'] });
    const t = setTimeout(() => done(adapter.isLoginPage()), timeoutMs);
  });
}

/**
 * `waitMs` is bounded by the launch's own expiry, so a person who needs a
 * moment to reach the login form still gets filled — and it never waits
 * forever.
 */
export async function fill(adapter: PortalAdapter, waitMs = 20_000, onWaiting?: (text?: string) => void): Promise<{ ok: boolean; message: string }> {
  if (!adapter.isLoginPage()) {
    adapter.openLogin?.();
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!adapter.isLoginPage()) onWaiting?.();
  if (!(await waitForLogin(adapter, waitMs))) return { ok: false, message: 'No login form found yet. Open the portal’s login, then press Autofill in the extension.' };
  const r = await send<{ ok: boolean; credential?: Credential; message?: string }>({ type: 'AUDITOS_REQUEST_FILL' });
  if (!r?.ok || !r.credential) return { ok: false, message: r?.message ?? 'Credential authorization failed.' };
  return withCredential(r.credential, async (c) => {
    if (adapter.twoStep) return twoStepFill(adapter, c, onWaiting);
    const u = await adapter.fillUsername(c.username);
    if (adapter.passwordless) {
      if (c.mobile) await adapter.fillMobile?.(c.mobile);
      if (u) return { ok: true, message: c.mobile ? 'Number and mobile filled. Enter the verification code and OTP yourself.' : 'Number filled. Enter the mobile, verification code and OTP yourself.' };
      return { ok: false, message: 'The page did not accept the values. Fill the login manually.' };
    }
    const p = await adapter.fillPassword(c.password);
    if (u && p) return { ok: true, message: 'Login filled. Complete the CAPTCHA / OTP yourself, then sign in.' };
    return { ok: false, message: 'The page did not accept the values. Fill the login manually.' };
  });
}

const shown = (el: HTMLInputElement | null) => !!el && (el.offsetWidth > 0 || el.offsetHeight > 0);

/**
 * Two-screen logins (Income Tax e-Filing): fill the User ID, let the person
 * press Continue, then fill the password the moment that screen appears. The
 * credential stays only in this function's memory, at most 3 minutes, and is
 * wiped by withCredential() when it returns.
 */
async function twoStepFill(adapter: PortalAdapter, c: Credential, onWaiting?: (text?: string) => void): Promise<{ ok: boolean; message: string }> {
  if (shown(adapter.findUsernameField()) && !shown(adapter.findPasswordField())) {
    if (!(await adapter.fillUsername(c.username))) return { ok: false, message: 'The page did not accept the User ID. Fill the login manually.' };
    onWaiting?.('User ID filled — press Continue; the password fills on the next screen.');
    const deadline = Date.now() + 3 * 60_000;
    while (!shown(adapter.findPasswordField())) {
      if (Date.now() > deadline) return { ok: false, message: 'Password screen did not appear. Reopen the portal from the CRM to try again.' };
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const p = await adapter.fillPassword(c.password);
  return p
    ? { ok: true, message: 'Login filled. Tick the secure-access confirmation if asked, complete any OTP yourself, then sign in.' }
    : { ok: false, message: 'The page did not accept the password. Fill it manually.' };
}
