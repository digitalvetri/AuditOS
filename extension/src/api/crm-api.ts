/**
 * The one backend call the extension makes: redeem a launch token for the
 * single credential it was issued for. Called on the CRM origin (/api/...),
 * which the manifest allowlists — no CORS, no cookies needed: the signed,
 * single-use token is the authority.
 */
import type { Credential, LaunchContext } from '../types';

export async function requestCredential(ctx: LaunchContext, pageUrl: string): Promise<{ ok: true; credential: Credential } | { ok: false; message: string }> {
  try {
    const res = await fetch(`${ctx.crmOrigin}/api/extension/credentials/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      body: JSON.stringify({
        launchToken: ctx.launchToken,
        clientId: ctx.clientId,
        portalId: ctx.portalId,
        registrationId: ctx.registrationId,
        pageUrl,
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, message: body?.error?.message ?? 'Credential authorization failed.' };
    const d = body?.data;
    if (typeof d?.username !== 'string' || typeof d?.password !== 'string') return { ok: false, message: 'Credential authorization failed.' };
    return { ok: true, credential: { username: d.username, password: d.password, ...(typeof d.mobile === 'string' ? { mobile: d.mobile } : {}) } };
  } catch {
    return { ok: false, message: 'Cannot reach the CRM. Is it running?' };
  }
}
