/** Popup: shows the active tab's CRM context and an Autofill button. Never the password. */
import type { ContentState, LaunchContext } from '../../types';

const root = document.getElementById('root')!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

async function render() {
  const r = await chrome.runtime.sendMessage({ type: 'AUDITOS_POPUP_STATE' }).catch(() => null) as { state: ContentState; ctx: Omit<LaunchContext, 'launchToken'> | null } | null;
  const s = r?.state ?? { kind: 'none' };
  const c = r?.ctx;
  if (!c || s.kind === 'none') {
    root.innerHTML = `<dl><dt>CRM Connection</dt><dd><span class="chip warn">No context</span></dd></dl>
      <p id="msg">No CRM context found. Please open this portal from the CRM (client → registration → Open &amp; autofill).</p>`;
    return;
  }
  const cred = s.kind === 'ready' ? '<span class="chip ok">Ready</span>' : s.kind === 'used' ? '<span class="chip ok">Filled</span>' : s.kind === 'expired' ? '<span class="chip bad">Expired</span>' : '<span class="chip warn">Wrong page</span>';
  const status = c.status === 'SUPPORTED' ? 'Verified' : c.status === 'PARTIAL' ? 'Verified page' : 'Not verified';
  root.innerHTML = `<dl>
      <dt>CRM Connection</dt><dd><span class="chip ok">Connected</span></dd>
      <dt>Current Portal</dt><dd>${esc(c.portalId)}</dd>
      <dt>Registration</dt><dd>${esc(c.registrationName)}</dd>
      <dt>Client</dt><dd>${esc(c.clientName)}</dd>
      <dt>Portal status</dt><dd>${esc(status)}</dd>
      <dt>Credential</dt><dd>${cred}</dd>
    </dl>
    <button id="fill" ${s.kind === 'ready' ? '' : 'disabled'}>Autofill</button>
    <p id="msg">${s.kind === 'expired' || s.kind === 'used' ? 'CRM session expired. Please reopen the registration from the CRM.' : s.kind === 'mismatch' ? `This page is not ${esc(s.expected)}.` : ''}</p>
    <p class="note">CAPTCHA, OTP, MFA and DSC are always completed by you.</p>`;
  document.getElementById('fill')?.addEventListener('click', async () => {
    const msg = document.getElementById('msg')!;
    msg.textContent = 'Filling…';
    const res = await chrome.runtime.sendMessage({ type: 'AUDITOS_POPUP_FILL' }).catch(() => null) as { ok: boolean; message?: string } | null;
    msg.textContent = res?.message ?? (res?.ok ? 'Filled.' : 'Could not fill.');
    setTimeout(render, 400);
  });
}
void render();
