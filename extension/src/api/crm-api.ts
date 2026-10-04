/**
 * The one backend call the extension makes: redeem a launch token for the
 * single credential it was issued for. Called on the CRM origin (/api/...),
 * which the manifest allowlists — no CORS, no cookies needed: the signed,
 * single-use token is the authority.
 */
import type { Credential, FillPurpose, LaunchContext } from '../types';

export async function requestCredential(ctx: LaunchContext, pageUrl: string, purpose: FillPurpose = 'login'): Promise<{ ok: true; credential: Credential } | { ok: false; message: string }> {
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
        purpose,
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, message: body?.error?.message ?? 'Credential authorization failed.' };
    const d = body?.data;
    // GST New Registration page: the saved Part A details, no login.
    if (['gst_new_registration', 'iec_registration', 'labour_registration', 'tnreginet_registration', 'udyam_registration', 'esi_registration', 'ewb_registration'].includes(d?.kind) && d.details && typeof d.details === 'object') {
      return { ok: true, credential: { username: '', password: '', details: d.details } };
    }
    if (typeof d?.username !== 'string' || typeof d?.password !== 'string') return { ok: false, message: 'Credential authorization failed.' };
    return { ok: true, credential: { username: d.username, password: d.password, ...(typeof d.mobile === 'string' ? { mobile: d.mobile } : {}) } };
  } catch {
    return { ok: false, message: 'Cannot reach the CRM. Is it running?' };
  }
}
