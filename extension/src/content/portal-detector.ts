/**
 * Runs on allowlisted government portal pages only. Asks the service
 * worker what this tab's CRM context allows on THIS page, then fills the login
 * as soon as the form appears (the popup's Autofill does the same on demand).
 * Shows a small banner with the outcome — never a password.
 */
import { adapterFor } from '../portals';
import type { ContentState } from '../types';
import { fill } from './autofill-engine';
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

let running = false;
async function run(userInitiated: boolean): Promise<{ ok: boolean; message: string }> {
  if (running) return { ok: false, message: 'Already filling…' };
  running = true;
  try {
    let state = await send<ContentState>({ type: 'AUDITOS_GET_STATE' });
    // A login tab opened by the portal receives its launch a moment after it starts loading.
    for (let i = 0; i < 6 && state?.kind === 'none'; i++) {
      await new Promise((r) => setTimeout(r, 700));
      state = await send<ContentState>({ type: 'AUDITOS_GET_STATE' });
    }
    if (!state) return { ok: false, message: 'The extension was reloaded — reopen this portal from the CRM.' };
    if (state.kind === 'none') return { ok: false, message: 'No CRM context found. Please open this portal from the CRM.' };
    if (state.kind === 'expired' || state.kind === 'used') { banner('CRM session expired. Please reopen this service from the CRM.', 'warn'); return { ok: false, message: 'CRM session expired. Please reopen this service from the CRM.' }; }
    if (state.kind === 'mismatch') return { ok: false, message: `This page is not ${state.expected}.` };
    const adapter = adapterFor(state.ctx.portalId, state.ctx.registrationId);
    if (!adapter) return { ok: false, message: 'This portal is not currently supported.' };
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
  void run(false);
}
