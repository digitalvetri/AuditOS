/**
 * Portal adapter contract + the generic implementation every portal starts
 * from. A portal gets its own verified selectors only after its real login
 * page has been inspected; until then it uses the generic heuristics and is
 * marked NOT_VERIFIED (no automatic fill — the user presses Autofill).
 */
import { findPassword, findUsernameFor, queryVisible, setValue } from '../content/field-manager';
import type { PortalStatus } from '../types';

export interface PortalAdapter {
  portalId: string;
  registrationIds: string[];
  status: PortalStatus;
  matches(url: URL): boolean;
  isLoginPage(): boolean;
  findUsernameField(): HTMLInputElement | null;
  findPasswordField(): HTMLInputElement | null;
  fillUsername(username: string): Promise<boolean>;
  fillPassword(password: string): Promise<boolean>;
  supportsAutofill(): boolean;
  /** Optional: reveal a login form that only opens on click (e.g. a pop-up). Returns true if it acted. */
  openLogin?(): boolean;
  /** Login has no password (UDYAM): fill the mobile number instead. */
  passwordless?: boolean;
  /** User ID and password are on two consecutive screens (Income Tax: User ID → Continue → password). */
  twoStep?: boolean;
  fillMobile?(mobile: string): Promise<boolean>;
}

export function genericAdapter(o: { portalId: string; registrationIds: string[]; domains: string[]; status: PortalStatus; selectors?: { username: string; password?: string; mobile?: string }; openLogin?: () => boolean;
  /** Only these URL paths are this registration's login (a domain can host other systems). */
  paths?: string[];
  twoStep?: boolean }): PortalAdapter {
  const byHost = (url: URL) => o.domains.some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`));
  const a: PortalAdapter = {
    portalId: o.portalId,
    registrationIds: o.registrationIds,
    status: o.status,
    matches: byHost,
    findPasswordField: () => (o.selectors ? (o.selectors.password ? queryVisible(o.selectors.password) : null) : findPassword()),
    findUsernameField: () => {
      if (o.selectors) return queryVisible(o.selectors.username);
      const p = findPassword();
      return p ? findUsernameFor(p) : null;
    },
    // A login page is one whose password box is actually on screen.
    isLoginPage: () => {
      if (o.paths && !o.paths.some((p) => location.pathname.startsWith(p))) return false;
      const shown = (el: HTMLInputElement | null) => !!el && (el.offsetWidth > 0 || el.offsetHeight > 0);
      if (o.twoStep) return shown(a.findUsernameField()) || shown(a.findPasswordField());
      return shown(o.selectors && !o.selectors.password ? a.findUsernameField() : a.findPasswordField());
    },
    fillUsername: async (v) => { const el = a.findUsernameField(); return !!el && setValue(el, v); },
    fillPassword: async (v) => { const el = a.findPasswordField(); return !!el && setValue(el, v); },
    supportsAutofill: () => o.status === 'SUPPORTED' || o.status === 'PARTIAL',
    openLogin: o.openLogin,
    passwordless: !!o.selectors && !o.selectors.password,
    twoStep: !!o.twoStep,
    fillMobile: async (v) => { const el = o.selectors?.mobile ? queryVisible(o.selectors.mobile) : null; return !!el && setValue(el, v); },
  };
  return a;
}
