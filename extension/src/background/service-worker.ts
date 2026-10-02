/**
 * Service worker — the only place a tab's CRM context and a credential meet.
 *
 * Context is stored per TAB in chrome.storage.session (memory only, cleared
 * when the browser closes, not readable by content scripts, never synced).
 * It holds a short-lived token, never a password. A credential is fetched
 * only when a content script on the matching portal page asks to fill, and
 * is handed straight back to that one tab.
 */
import { requestCredential } from '../api/crm-api';
import { CRM_ORIGINS, evaluate, launchUrlAllowed } from '../security/context-validator';
import type { ContentState, LaunchContext, LaunchMessage } from '../types';

const key = (tabId: number) => `ctx:${tabId}`;

async function getCtx(tabId: number): Promise<LaunchContext | null> {
  const r = await chrome.storage.session.get(key(tabId));
  return (r[key(tabId)] as LaunchContext | undefined) ?? null;
}
const setCtx = (tabId: number, ctx: LaunchContext) => chrome.storage.session.set({ [key(tabId)]: ctx });

chrome.tabs.onRemoved.addListener((tabId) => { void chrome.storage.session.remove(key(tabId)); });

/**
 * Portals often open their login in a NEW tab (ESIC "Employer Login", EPFO's
 * employer portal, Labour TN). A tab opened FROM a launched portal tab carries
 * the same launch — same client, registration and portal; it is still checked
 * against that portal's domains on every page and the token is still single-
 * use. Tabs the person opens any other way get nothing.
 */
async function inherit(sourceTabId: number, tabId: number) {
  if (sourceTabId === tabId) return;
  const ctx = await getCtx(sourceTabId);
  if (!ctx || ctx.state === 'filled' || Date.parse(ctx.expiresAt) <= Date.now()) return;
  if (await getCtx(tabId)) return;
  await setCtx(tabId, { ...ctx });
}
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => { void inherit(d.sourceTabId, d.tabId); });
chrome.tabs.onCreated.addListener((tab) => { if (tab.id !== undefined && tab.openerTabId !== undefined) void inherit(tab.openerTabId, tab.id); });

/** One launch, one fill: once any tab used the token, every tab sharing it is done. */
async function markLaunchUsed(launchToken: string) {
  const all = await chrome.storage.session.get(null);
  const updates: Record<string, LaunchContext> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('ctx:') && (v as LaunchContext).launchToken === launchToken) updates[k] = { ...(v as LaunchContext), state: 'filled' };
  }
  if (Object.keys(updates).length) await chrome.storage.session.set(updates);
}

const HANDLED = new Set(['AUDITOS_PORTAL_LAUNCH', 'AUDITOS_GET_STATE', 'AUDITOS_REQUEST_FILL', 'AUDITOS_POPUP_STATE', 'AUDITOS_POPUP_FILL']);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!HANDLED.has(msg?.type)) return false;
  // reply() throws if the asking tab/page has gone; that is not an error.
  const answer = (v: unknown) => { try { reply(v); } catch { /* sender gone */ } };
  void (async () => {
    // ── From the CRM bridge: open the portal in a new tab, bound to this context.
    if (msg?.type === 'AUDITOS_PORTAL_LAUNCH') {
      const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : '');
      if (!CRM_ORIGINS.includes(origin)) return answer({ ok: false, error: 'Launch must come from the CRM.' });
      const p = (msg as LaunchMessage).payload;
      const url = launchUrlAllowed(p.launch_url, p.portal_id);
      if (!url) return answer({ ok: false, error: 'This portal is not currently supported.' });
      const tab = await chrome.tabs.create({ url });
      if (tab.id === undefined) return answer({ ok: false, error: 'Could not open the portal.' });
      await setCtx(tab.id, {
        launchToken: p.launch_token,
        clientId: p.client.id, clientName: p.client.name, clientCode: p.client.code,
        registrationId: p.registration_id, registrationName: p.registration_name,
        portalId: p.portal_id, portalName: p.portal_name,
        status: p.status, crmOrigin: origin, expiresAt: p.expires_at, state: 'ready',
      });
      return answer({ ok: true });
    }

    // ── From a portal page: what may happen on this tab?
    if (msg?.type === 'AUDITOS_GET_STATE') {
      const tabId = sender.tab?.id;
      const state: ContentState = tabId === undefined ? { kind: 'none' } : evaluate(await getCtx(tabId), sender.url ?? '');
      return answer(state);
    }

    // ── From a portal page: fetch THIS tab's credential (once) to fill.
    if (msg?.type === 'AUDITOS_REQUEST_FILL') {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return answer({ ok: false, message: 'No CRM context found. Please open this portal from the CRM.' });
      const ctx = await getCtx(tabId);
      const state = evaluate(ctx, sender.url ?? '');
      if (state.kind !== 'ready' || !ctx) {
        const message = state.kind === 'expired' || state.kind === 'used'
          ? 'CRM session expired. Please reopen this service from the CRM.'
          : state.kind === 'mismatch' ? `This page is not ${state.expected}.` : 'No CRM context found. Please open this portal from the CRM.';
        return answer({ ok: false, message });
      }
      const r = await requestCredential(ctx, sender.url ?? '');
      if (r.ok) await markLaunchUsed(ctx.launchToken);
      else await setCtx(tabId, { ...ctx, state: 'failed', lastError: r.message });
      return answer(r.ok ? { ok: true, credential: r.credential } : { ok: false, message: r.message });
    }

    // ── From the popup: describe the active tab (never the password).
    if (msg?.type === 'AUDITOS_POPUP_STATE') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return answer({ kind: 'none' });
      const ctx = await getCtx(tab.id);
      return answer({ state: evaluate(ctx, tab.url ?? ''), ctx: ctx ? { ...ctx, launchToken: undefined } : null, tabId: tab.id });
    }

    // ── From the popup: ask the page to fill now (user-initiated).
    if (msg?.type === 'AUDITOS_POPUP_FILL') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return answer({ ok: false });
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'AUDITOS_FILL_NOW' }).catch(() => ({ ok: false, message: 'Reload the portal page (it was open before the extension updated), then press Autofill.' }));
      return answer(r);
    }
  })().catch(() => answer({ ok: false, message: 'Something went wrong — reopen this portal from the CRM.' }));
  return true; // async reply
});
