/**
 * Runs on the CRM's own pages only. The CRM posts a launch message with
 * window.postMessage; this forwards it to the service worker and posts the
 * result back. It also announces the extension so the CRM can show
 * "Open & autofill" instead of a plain link.
 */
import { extensionAlive, send } from './messaging';

const READY = { source: 'auditos-extension', type: 'AUDITOS_EXTENSION_READY', version: extensionAlive() ? chrome.runtime.getManifest().version : '0' };
window.postMessage(READY, window.location.origin);

window.addEventListener('message', (ev) => {
  if (ev.source !== window || ev.origin !== window.location.origin) return;
  const d = ev.data;
  if (d?.source !== 'auditos-crm') return;
  // A reloaded extension leaves this old copy disconnected: stay silent so the
  // CRM falls back to opening the portal without autofill.
  if (!extensionAlive()) return;
  if (d.type === 'AUDITOS_PING') { window.postMessage(READY, window.location.origin); return; }
  if (d.type === 'AUDITOS_PORTAL_LAUNCH') {
    void send<{ ok: boolean; error?: string }>({ type: 'AUDITOS_PORTAL_LAUNCH', payload: d.payload }).then((r) => {
      window.postMessage({ source: 'auditos-extension', type: 'AUDITOS_PORTAL_LAUNCH_RESULT', requestId: d.requestId, ok: !!r?.ok, error: r ? (r.error ?? null) : 'The extension was reloaded — refresh this CRM page and try again.' }, window.location.origin);
    });
  }
});
