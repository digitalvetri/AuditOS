/**
 * Runs on allowlisted government portal pages only. Asks the service
 * worker what this tab's CRM context allows on THIS page, then fills the login
 * as soon as the form appears (the popup's Autofill does the same on demand).
 * Shows a small banner with the outcome — never a password.
 */
import { adapterFor } from '../portals';
import type { ContentState } from '../types';
import { fill } from './autofill-engine';
import { fillGstNewRegistration, isGstNewRegistrationPage, waitForGstForm } from './gst-registration';
import { fillDgftRegistration, waitForDgftRegister } from './dgft-registration';
import { fillLabourRegistration, isLabourRegistrationPage, waitForLabourForm } from './labour-registration';
import { fillEsicSignup, isEsicEmployerSignupPage, isEsicIpSignupPage, keepEsicDobAcrossLanguage, resumeEsicEmployerSignup, waitForEsicSignup } from './esic-registration';
import { fillEwbRegistration, isEwbRegistrationPage, waitForEwbRegistration } from './ewaybill-registration';
import { fillUdyamRegistration, isUdyamRegistrationPage, waitForUdyamForm } from './udyam-registration';
import { fillTnreginetRegistration, waitForTnreginetRegistration } from './tnreginet-registration';
import { withCredential } from '../security/credential-handler';
import type { Credential } from '../types';
import { extensionAlive, send } from './messaging';

function banner(text: string, tone: 'ok' | 'warn' | 'info') {
  let el = document.getElementById('auditos-autofill-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'auditos-autofill-banner';
    el.setAttribute('role', 'status');
    Object.assign(el.style, { position: 'fixed', zIndex: '2147483647', right: '16px', bottom: '16px', maxWidth: '340px', padding: '10px 14px', borderRadius: '10px', font: '13px/1.4 system-ui, sans-serif', color: '#fff', boxShadow: '0 10px 24px -8px rgba(15,23,42,.45)' });
    document.documentElement.appendChild(el);
  }
  el.style.background = tone === 'ok' ? '#0f766e' : tone === 'warn' ? '#b45309' : '#1b3a6f';
  el.textContent = `AuditOS · ${text}`;
}

/** Waits for DGFT's REGISTER tab, then fills it with the saved first-time details (once per launch). */
let watchingRegister = false;
async function watchDgftRegister(clientName: string, waitMs: number) {
  if (watchingRegister) return;
  watchingRegister = true;
  try {
    if (!(await waitForDgftRegister(waitMs))) return;
    banner(`Filling the DGFT Register form for ${clientName}…`, 'info');
    const r0 = await send<{ ok: boolean; credential?: Credential; message?: string }>({ type: 'AUDITOS_REQUEST_FILL', purpose: 'registration' });
    if (!r0?.ok || !r0.credential?.details) { banner(r0?.message ?? 'No IEC registration details for this client.', 'warn'); return; }
    const r = await withCredential(r0.credential, (c) => fillDgftRegistration(c.details!));
    banner(r.ok ? `${clientName}: ${r.message}` : r.message, r.ok ? 'ok' : 'warn');
  } finally {
    watchingRegister = false;
  }
}

/** TNREGINET: the Sign Up form loads into the same page — fill it with the saved first-time details (once per launch). */
let watchingTnreginet = false;
async function watchTnreginetRegistration(clientName: string, waitMs: number) {
  if (watchingTnreginet) return;
  watchingTnreginet = true;
  try {
    if (!(await waitForTnreginetRegistration(waitMs))) return;
    banner(`Filling the TNREGINET registration form for ${clientName}…`, 'info');
    const r0 = await send<{ ok: boolean; credential?: Credential; message?: string }>({ type: 'AUDITOS_REQUEST_FILL', purpose: 'registration' });
    if (!r0?.ok || !r0.credential?.details) { banner(r0?.message ?? 'No Partnership Firm registration details for this client.', 'warn'); return; }
    const r = await withCredential(r0.credential, (c) => fillTnreginetRegistration(c.details!));
    banner(r.ok ? `${clientName}: ${r.message}` : r.message, r.ok ? 'ok' : 'warn');
  } finally {
    watchingTnreginet = false;
  }
}

let running = false;
async function run(userInitiated: boolean): Promise<{ ok: boolean; message: string }> {
  if (running) return { ok: false, message: 'Already filling…' };
  running = true;
  try {
    let state = await send<ContentState>({ type: 'AUDITOS_GET_STATE' });
    // A login tab opened by the portal receives its launch a moment after it starts loading.
    for (let i = 0; i < 14 && state?.kind === 'none'; i++) {
      await new Promise((r) => setTimeout(r, 300));
      state = await send<ContentState>({ type: 'AUDITOS_GET_STATE' });
    }
    if (!state) return { ok: false, message: 'The extension was reloaded — reopen this portal from the CRM.' };
    if (state.kind === 'none') return { ok: false, message: 'No CRM context found. Please open this portal from the CRM.' };
    if (state.kind === 'expired' || state.kind === 'used') { banner('CRM session expired. Please reopen this service from the CRM.', 'warn'); return { ok: false, message: 'CRM session expired. Please reopen this service from the CRM.' }; }
    if (state.kind === 'mismatch') return { ok: false, message: `This page is not ${state.expected}.` };
    const adapter = adapterFor(state.ctx.portalId, state.ctx.registrationId);
    if (!adapter) return { ok: false, message: 'This portal is not currently supported.' };
    // GST New Registration (Part A): fill the saved first-time details, not a login.
    if (state.ctx.portalId === 'GST' && isGstNewRegistrationPage()) {
      banner(`Filling GST New Registration for ${state.ctx.clientName}…`, 'info');
      if (!(await waitForGstForm(30_000))) return { ok: false, message: 'The New Registration form did not appear.' };
      const r0 = await send<{ ok: boolean; credential?: Credential; message?: string }>({ type: 'AUDITOS_REQUEST_FILL', purpose: 'registration' });
      if (!r0?.ok || !r0.credential?.details) {
        const m = r0?.message ?? 'No GST registration details for this client.';
        banner(m, 'warn');
        return { ok: false, message: m };
      }
      const r = await withCredential(r0.credential, (c) => fillGstNewRegistration(c.details!));
      banner(r.ok ? `${state.ctx.clientName}: ${r.message}` : r.message, r.ok ? 'ok' : 'warn');
      return r;
    }
    // Labour TN: the applicant registration page fills the saved first-time details.
    if (state.ctx.portalId === 'LABOUR_TN' && isLabourRegistrationPage()) {
      if (state.ctx.used?.includes('registration')) return { ok: true, message: 'Registration form already filled from this launch.' };
      banner(`Filling the Labour Department registration form for ${state.ctx.clientName}…`, 'info');
      if (!(await waitForLabourForm(30_000))) return { ok: false, message: 'The registration form did not appear.' };
      const r0 = await send<{ ok: boolean; credential?: Credential; message?: string }>({ type: 'AUDITOS_REQUEST_FILL', purpose: 'registration' });
      if (!r0?.ok || !r0.credential?.details) { const m = r0?.message ?? 'No registration details for this client.'; banner(m, 'warn'); return { ok: false, message: m }; }
      const r = await withCredential(r0.credential, (c) => fillLabourRegistration(c.details!));
      banner(r.ok ? `${state.ctx.clientName}: ${r.message}` : r.message, r.ok ? 'ok' : 'warn');
      return r;
    }
    // ESIC: Employer Sign Up and Insured Person User Sign Up fill the saved first-time details.
    if (state.ctx.portalId === 'ESIC' && (isEsicEmployerSignupPage() || isEsicIpSignupPage())) {
      // Back from the State post-back: only the region is left to choose.
      const resumed = await resumeEsicEmployerSignup();
      if (resumed) { banner(`${state.ctx.clientName}: ${resumed.message}`, 'ok'); return resumed; }
      if (state.ctx.used?.includes('registration')) return { ok: true, message: 'Sign-up form already filled from this launch.' };
      banner(`Filling the ESIC sign-up form for ${state.ctx.clientName}…`, 'info');
      if (!(await waitForEsicSignup(30_000))) return { ok: false, message: 'The ESIC sign-up form did not appear.' };
      const r0 = await send<{ ok: boolean; credential?: Credential; message?: string }>({ type: 'AUDITOS_REQUEST_FILL', purpose: 'registration' });
      if (!r0?.ok || !r0.credential?.details) { const m = r0?.message ?? 'No ESI registration details for this client.'; banner(m, 'warn'); return { ok: false, message: m }; }
      const r = await withCredential(r0.credential, (c) => fillEsicSignup(c.details!));
      banner(r.ok ? `${state.ctx.clientName}: ${r.message}` : r.message, r.ok ? 'ok' : 'warn');
      return r;
    }
    // E-Way Bill: the Registration Form (Enter GSTIN) fills the saved GSTIN.
    if (state.ctx.portalId === 'EWAYBILL' && isEwbRegistrationPage()) {
      if (state.ctx.used?.includes('registration')) return { ok: true, message: 'Registration form already filled from this launch.' };
      banner(`Filling E-Way Bill registration for ${state.ctx.clientName}…`, 'info');
      if (!(await waitForEwbRegistration(30_000))) return { ok: false, message: 'The E-Way Bill registration form did not appear.' };
      const r0 = await send<{ ok: boolean; credential?: Credential; message?: string }>({ type: 'AUDITOS_REQUEST_FILL', purpose: 'registration' });
      if (!r0?.ok || !r0.credential?.details) { const m = r0?.message ?? 'No E-Way Bill registration details for this client.'; banner(m, 'warn'); return { ok: false, message: m }; }
      const r = await withCredential(r0.credential, (c) => fillEwbRegistration(c.details!));
      banner(r.ok ? `${state.ctx.clientName}: ${r.message}` : r.message, r.ok ? 'ok' : 'warn');
      return r;
    }
    // Udyam: the registration page (Aadhaar verification) fills the saved first-time details.
    if (state.ctx.portalId === 'UDYAM' && isUdyamRegistrationPage()) {
      if (state.ctx.used?.includes('registration')) return { ok: true, message: 'Registration form already filled from this launch.' };
      banner(`Filling Udyam Registration for ${state.ctx.clientName}…`, 'info');
      if (!(await waitForUdyamForm(30_000))) return { ok: false, message: 'The Udyam registration form did not appear.' };
      const r0 = await send<{ ok: boolean; credential?: Credential; message?: string }>({ type: 'AUDITOS_REQUEST_FILL', purpose: 'registration' });
      if (!r0?.ok || !r0.credential?.details) { const m = r0?.message ?? 'No Udyam registration details for this client.'; banner(m, 'warn'); return { ok: false, message: m }; }
      const r = await withCredential(r0.credential, (c) => fillUdyamRegistration(c.details!));
      banner(r.ok ? `${state.ctx.clientName}: ${r.message}` : r.message, r.ok ? 'ok' : 'warn');
      return r;
    }
    // DGFT: the pop-up has LOGIN and REGISTER tabs — fill whichever the person opens.
    const waitMs0 = Math.max(5_000, Math.min(10 * 60_000, Date.parse(state.ctx.expiresAt) - Date.now()));
    if (state.ctx.portalId === 'DGFT' && !state.ctx.used?.includes('registration')) void watchDgftRegister(state.ctx.clientName, waitMs0);
    if (state.ctx.portalId === 'TNREGINET' && !state.ctx.used?.includes('registration')) void watchTnreginetRegistration(state.ctx.clientName, waitMs0);
    if (state.ctx.used?.includes('login')) return { ok: true, message: 'Login already filled from this launch.' };
    banner(`Filling ${state.ctx.registrationName} login for ${state.ctx.clientName}…`, 'info');
    // Wait for the login form as long as this launch is valid (max 10 min).
    const waitMs = Math.max(5_000, Math.min(10 * 60_000, Date.parse(state.ctx.expiresAt) - Date.now()));
    const r = await fill(adapter, waitMs, (text) => banner(text ?? `Open the portal’s login form — the ${state.ctx.registrationName} login for ${state.ctx.clientName} fills in as soon as it appears.`, 'info'));
    banner(r.ok ? `${state.ctx.clientName}: ${r.message}` : r.message, r.ok ? 'ok' : 'warn');
    return r;
  } finally {
    running = false;
  }
}

if (extensionAlive()) {
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'AUDITOS_FILL_NOW') { void run(true).then(reply); return true; }
    return false;
  });
  // ESIC IP sign-up: the portal erases the Date of Birth on a Language change — put it back.
  void keepEsicDobAcrossLanguage();
  void run(false);
}
