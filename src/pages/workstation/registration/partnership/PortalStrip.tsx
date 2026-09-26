/**
 * Read-only Portal Access strip for the case header — GST-RETURNS-CASE-
 * SCREEN §5.4 / §9-5. A person filing at 6pm on a return case needs to
 * see, without leaving the case, which portal username to type and whose
 * phone to ring for the OTP. The password itself is behind a Reveal /
 * Copy pair — the server writes an audit row per reveal or copy call.
 *
 * §3 refinements (GST-CLIENT-DASHBOARD-TASKS):
 *   • Copy button that writes plaintext to the clipboard without showing it.
 *   • 30-second auto-hide on Reveal — the plaintext is nulled out of state
 *     when the timer fires, and a subsequent view re-hits the endpoint
 *     (preserving the "audit row per view" invariant — we deliberately
 *     do NOT cache plaintext across an auto-hide cycle).
 *   • Copy triggers the same reveal endpoint and therefore writes the same
 *     audit row — Copy is not a stealth read.
 *
 * Deliberate non-goal: a 30-second clipboard-clear companion. It's a
 * plausible next ask, but not part of §3.
 *
 * Renders nothing when: no GstProfile on the client (client_holds=null),
 * no record saved yet (record=null), or the caller lacks
 * workstation.gst.portal.view (server 403s the GET; we render an empty
 * strip in that case, not a broken button).
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Eye, EyeOff, Copy } from 'lucide-react';
import { gstPortalApi, type PasswordField } from '@/modules/gstPortal/api';
import { useToast } from '@/components/Toast';
import type { ApiError } from '@/services/api';

const REVEAL_MS = 30_000;

export function PortalStrip({ gstProfileId }: { gstProfileId: string }) {
  const toast = useToast();
  const [revealed, setRevealed] = useState<string | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimer = () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };
  const armHideTimer = () => {
    clearHideTimer();
    hideTimer.current = setTimeout(() => setRevealed(null), REVEAL_MS);
  };

  useEffect(() => () => clearHideTimer(), []);

  const q = useQuery({
    queryKey: ['gst-portal', gstProfileId],
    queryFn: () => gstPortalApi.get(gstProfileId),
    // 403 = no permission; render blank strip rather than surfacing errors.
    retry: false,
  });

  // Two mutations sharing one endpoint so React Query tracks them
  // independently — otherwise a Copy in flight would flip the Reveal
  // button's `isPending` and vice versa.
  const revealMx = useMutation({
    mutationFn: (field: PasswordField) => gstPortalApi.reveal(gstProfileId, field),
    onSuccess: (r) => {
      if (r.value == null) {
        toast.push('error', 'No password stored to reveal.');
        return;
      }
      setRevealed(r.value);
      armHideTimer();
    },
    onError: (e: ApiError) => toast.push('error', e.message),
  });
  const copyMx = useMutation({
    mutationFn: (field: PasswordField) => gstPortalApi.reveal(gstProfileId, field),
    onSuccess: async (r) => {
      if (r.value == null) {
        toast.push('error', 'No password stored to copy.');
        return;
      }
      try {
        await navigator.clipboard.writeText(r.value);
        toast.push('success', 'Password copied.');
      } catch {
        toast.push('error', 'Clipboard unavailable — copy failed.');
      }
    },
    onError: (e: ApiError) => toast.push('error', e.message),
  });

  if (q.error || !q.data) return null;
  const r = q.data.record;
  if (!r) return null; // No record for this GSTIN yet — nothing to strip.

  const clientHolds = r.password_held_by === 'client';

  const passwordCell = clientHolds ? (
    <span className="text-neutral-500">Client holds the password</span>
  ) : !r.portal_password_present ? (
    <span className="text-neutral-400">no password stored</span>
  ) : revealed ? (
    <>
      <span className="font-mono text-13">{revealed}</span>
      <button
        type="button"
        className="inline-flex items-center gap-1 text-11 underline text-neutral-500 hover:text-neutral-700"
        onClick={() => { clearHideTimer(); setRevealed(null); }}
      >
        <EyeOff size={12} /> Hide
      </button>
    </>
  ) : (
    <span className="inline-flex items-center gap-3">
      <button
        type="button"
        className="inline-flex items-center gap-1 text-13 text-neutral-700 underline hover:text-neutral-900 disabled:opacity-60"
        disabled={revealMx.isPending}
        onClick={() => revealMx.mutate('portal_password')}
      >
        <Eye size={12} /> {revealMx.isPending ? 'Revealing…' : 'Reveal'}
      </button>
      <button
        type="button"
        className="inline-flex items-center gap-1 text-13 text-neutral-700 underline hover:text-neutral-900 disabled:opacity-60"
        disabled={copyMx.isPending}
        onClick={() => copyMx.mutate('portal_password')}
      >
        <Copy size={12} /> {copyMx.isPending ? 'Copying…' : 'Copy'}
      </button>
    </span>
  );

  return (
    <div className="px-4 py-2 text-13 bg-neutral-50 border-t border-neutral-200 flex flex-wrap items-center gap-x-6 gap-y-1">
      <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">Portal access</span>
      <span>
        <span className="text-11 text-neutral-500">user</span>{' '}
        <span className="font-mono text-13">{r.portal_username ?? '—'}</span>
      </span>
      {r.otp_contact_name || r.otp_contact_number ? (
        <span>
          <span className="text-11 text-neutral-500">OTP →</span>{' '}
          <span>{r.otp_contact_name ?? '—'}</span>{' '}
          {r.otp_contact_number ? <span className="font-mono text-12 text-neutral-500">{r.otp_contact_number}</span> : null}
        </span>
      ) : null}
      <span className="inline-flex items-center gap-2">
        <span className="text-11 text-neutral-500">password</span>{' '}
        {passwordCell}
      </span>
    </div>
  );
}
