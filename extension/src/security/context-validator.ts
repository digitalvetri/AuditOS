/**
 * Decides whether a tab's stored CRM context may be used on the page the tab
 * is now showing. Pure function — unit-tested in tests/.
 */
import { REGISTRY, pageBelongsTo } from '../portals/registry';
import type { ContentState, LaunchContext } from '../types';

export function evaluate(ctx: LaunchContext | null, pageUrl: string, now = Date.now()): ContentState {
  if (!ctx) return { kind: 'none' };
  if (Date.parse(ctx.expiresAt) <= now) return { kind: 'expired' };
  if (ctx.state === 'filled') return { kind: 'used' };
  let url: URL;
  try { url = new URL(pageUrl); } catch { return { kind: 'mismatch', expected: ctx.portalName }; }
  // The registration must belong to the portal, and the page to that portal.
  const entry = REGISTRY.find((e) => e.portalId === ctx.portalId);
  if (!entry || !entry.registrationIds.includes(ctx.registrationId)) return { kind: 'mismatch', expected: ctx.portalName };
  if (!pageBelongsTo(url, ctx.portalId)) return { kind: 'mismatch', expected: ctx.portalName };
  const { launchToken: _t, ...safe } = ctx;
  // Every known portal responds by itself once its login form appears (the
  // person opens the login; the extension fills it). Verified portals use
  // exact selectors, NOT_VERIFIED ones generic detection.
  return { kind: 'ready', ctx: safe, autoFill: true };
}

/** CRM origins allowed to launch (also listed in the manifest). */
export const CRM_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:8080', 'http://127.0.0.1:8080'];

/** The URL a launch may open: exactly a registry starting URL. */
export function launchUrlAllowed(launchUrl: string, portalId: string): string | null {
  const e = REGISTRY.find((x) => x.portalId === portalId);
  return e && e.launchUrls.includes(launchUrl) ? launchUrl : null;
}
