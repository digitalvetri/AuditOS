/**
 * Read-only Portal Access strip for the case header — GST-RETURNS-CASE-
 * SCREEN §5.4 / §9-5. A person filing at 6pm on a return case needs to
 * see, without leaving the case, which portal username to type and whose
 * phone to ring for the OTP. The password itself is behind a Reveal
 * button — the server writes an audit row per reveal.
 *
 * Renders nothing when: no GstProfile on the client (client_holds=null),
 * no record saved yet (record=null), or the caller lacks
 * workstation.gst.portal.view (server 403s the GET; we render an empty
 * strip in that case, not a broken button).
 */
import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import { gstPortalApi, type PasswordField } from '@/modules/gstPortal/api';
import { useToast } from '@/components/Toast';
import type { ApiError } from '@/services/api';

export function PortalStrip({ gstProfileId }: { gstProfileId: string }) {
  const toast = useToast();
  const [revealed, setRevealed] = useState<Record<PasswordField, string | null>>({
    portal_password: null, ewb_password: null, irp_password: null,
  });
  const q = useQuery({
    queryKey: ['gst-portal', gstProfileId],
    queryFn: () => gstPortalApi.get(gstProfileId),
    // 403 = no permission; render blank strip rather than surfacing errors.
    retry: false,
  });
  const reveal = useMutation({
    mutationFn: (field: PasswordField) => gstPortalApi.reveal(gstProfileId, field),
    onSuccess: (r) => setRevealed((s) => ({ ...s, [r.field]: r.value })),
    onError: (e: ApiError) => toast.push('error', e.message),
  });

  if (q.error || !q.data) return null;
  const r = q.data.record;
  if (!r) return null; // No record for this GSTIN yet — nothing to strip.

  const clientHolds = r.password_held_by === 'client';
  const passwordCell = clientHolds
    ? <span className="text-neutral-500">Client holds the password</span>
    : r.portal_password_present
      ? (revealed.portal_password
          ? <>
              <span className="font-mono text-13">{revealed.portal_password}</span>
              <button className="text-11 underline text-neutral-500" onClick={() => setRevealed((s) => ({ ...s, portal_password: null }))}><EyeOff size={12} className="inline" /> Hide</button>
            </>
          : <button
              className="inline-flex items-center gap-1 text-13 text-neutral-700 underline hover:text-neutral-900 disabled:opacity-60"
              disabled={reveal.isPending}
              onClick={() => reveal.mutate('portal_password')}
            >
              <Eye size={12} /> {reveal.isPending && reveal.variables === 'portal_password' ? 'Revealing…' : 'Reveal'}
            </button>)
      : <span className="text-neutral-400">no password stored</span>;

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
      <span>
        <span className="text-11 text-neutral-500">password</span>{' '}
        {passwordCell}
      </span>
    </div>
  );
}
