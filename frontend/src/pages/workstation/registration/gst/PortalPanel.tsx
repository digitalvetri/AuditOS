/**
 * GST Portal Login Credentials — the full-panel version of the read-only
 * strip. Sits at the TOP of the GST client view because a filer starting
 * work on a period reaches for the portal user ID and password first;
 * everything else on the page is contingent on getting in.
 *
 * Layout mirrors the spec:
 *   Header:  GST Portal Login Credentials      • Configured / Not configured
 *   Two columns:  User ID + [Copy]     Password + [Show] [Copy]
 *   Footer:  Edit Credentials · Delete · "Show/Copy are audit-logged. Password hides after 30s."
 *
 * The panel renders even when no credentials are saved — an empty panel
 * with a "Not configured" badge and an Add Credentials button tells the
 * operator something is missing; hiding the panel would tell them nothing.
 *
 * The 30-second auto-hide and audit-per-view invariant follow the same
 * pattern as the PartnershipCase strip (§3): plaintext never lives in
 * client state past the timer, so a re-view re-hits the endpoint and
 * writes a fresh audit row. Copy hits the same endpoint and writes the
 * same audit row (distinguished by `action: 'copy'` vs `'show'`), so
 * copy is never a stealth read.
 *
 * Edit opens the existing PortalAccessSection inside a modal — the same
 * form the Clients edit dialog uses — so the two paths converge on one
 * editor. Delete clears portal_username + portal_password and preserves
 * MFA / OTP / EWB / IRP data; a "hard delete of the row" would nuke
 * credentials the operator did not intend to touch.
 *
 * 403 handling: a caller without `workstation.gst.portal.view` gets
 * `q.error` from the GET; we render an explicit "you don't have permission"
 * strip rather than a broken button or a silent empty state.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Eye, EyeOff, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { Modal } from '@/modules/workstation/components';
import { gstPortalApi } from '@/modules/gstPortal/api';
import { useToast } from '@/components/Toast';
import type { ApiError } from '@/services/api';
import { PortalAccessSection } from './PortalAccessSection';

const REVEAL_MS = 30_000;

export function PortalPanel({ gstProfileId }: { gstProfileId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimer = () => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
  };
  const armHideTimer = () => {
    clearHideTimer();
    hideTimer.current = setTimeout(() => setRevealed(null), REVEAL_MS);
  };
  useEffect(() => () => clearHideTimer(), []);

  const q = useQuery({
    queryKey: ['gst-portal', gstProfileId],
    queryFn: () => gstPortalApi.get(gstProfileId),
    retry: false,
  });

  const showMx = useMutation({
    mutationFn: () => gstPortalApi.reveal(gstProfileId, 'portal_password', 'show'),
    onSuccess: (r) => {
      if (r.value == null) { toast.push('error', 'No password stored to reveal.'); return; }
      setRevealed(r.value);
      armHideTimer();
    },
    onError: (e: ApiError) => toast.push('error', e.message),
  });
  const copyPasswordMx = useMutation({
    mutationFn: () => gstPortalApi.reveal(gstProfileId, 'portal_password', 'copy'),
    onSuccess: async (r) => {
      if (r.value == null) { toast.push('error', 'No password stored to copy.'); return; }
      try {
        await navigator.clipboard.writeText(r.value);
        toast.push('success', 'Password copied.');
      } catch {
        toast.push('error', 'Clipboard unavailable — copy failed.');
      }
    },
    onError: (e: ApiError) => toast.push('error', e.message),
  });
  const logUsernameCopyMx = useMutation({
    mutationFn: () => gstPortalApi.logAccess(gstProfileId, { field: 'portal_username', action: 'copy' }),
    // The clipboard write already happened on the client; the audit log
    // is fire-and-forget from the operator's POV. Surface errors quietly.
    onError: (e: ApiError) => console.warn('username access-log failed:', e.message),
  });

  const deleteMx = useMutation({
    mutationFn: () => gstPortalApi.save(gstProfileId, {
      portal_username: null,
      portal_password: null,
    }),
    onSuccess: (r) => {
      qc.setQueryData(['gst-portal', gstProfileId], { data: { record: r.record } });
      clearHideTimer(); setRevealed(null);
      setConfirmingDelete(false);
      toast.push('success', 'Credentials cleared.');
    },
    onError: (e: ApiError) => toast.push('error', e.message),
  });

  // Loading and 403 — render something rather than nothing. The empty-panel
  // rule from the spec ("an absent panel tells the user nothing") applies
  // here too: a missing permission is a real state, not a reason to hide.
  if (q.isLoading) {
    return <PanelShell><PanelHeader configured={false} /><div className="px-4 py-3 text-13 text-neutral-500">Loading…</div></PanelShell>;
  }
  if (q.error) {
    return (
      <PanelShell>
        <PanelHeader configured={false} />
        <div className="px-4 py-3 text-13 text-neutral-500">
          You don't have permission to view portal credentials for this client.
        </div>
      </PanelShell>
    );
  }
  const record = q.data?.record ?? null;
  const clientHolds = record?.password_held_by === 'client';
  const configured = !!(record?.portal_username || record?.portal_password_present);

  const copyUsername = async () => {
    if (!record?.portal_username) return;
    try {
      await navigator.clipboard.writeText(record.portal_username);
      toast.push('success', 'User ID copied.');
      logUsernameCopyMx.mutate();
    } catch {
      toast.push('error', 'Clipboard unavailable — copy failed.');
    }
  };
  const hidePassword = () => { clearHideTimer(); setRevealed(null); };

  return (
    <PanelShell>
      <PanelHeader configured={configured} />

      {!configured ? (
        <div className="px-4 py-4 flex items-center gap-3">
          <span className="text-13 text-neutral-500 flex-1">
            No portal credentials saved for this GSTIN. Add them to save time
            when a filer next opens a return case.
          </span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1 h-8 px-3 text-13 border border-neutral-300 rounded hover:border-neutral-400"
          >
            <Plus size={14} /> Add Credentials
          </button>
        </div>
      ) : (
        <>
          <div className="px-4 py-3 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
            <FieldBlock label="User ID">
              {record.portal_username ? (
                <>
                  <span className="font-mono text-13 text-neutral-900 min-w-0 truncate">{record.portal_username}</span>
                  <IconButton onClick={copyUsername} label="Copy user ID"><Copy size={13} /></IconButton>
                </>
              ) : (
                <span className="text-13 text-neutral-400">not set</span>
              )}
            </FieldBlock>

            <FieldBlock label="Password">
              {clientHolds ? (
                <span className="text-13 text-neutral-500">Client holds the password</span>
              ) : !record.portal_password_present ? (
                <span className="text-13 text-neutral-400">no password stored</span>
              ) : revealed ? (
                <>
                  <span className="font-mono text-13 text-neutral-900 min-w-0 truncate">{revealed}</span>
                  <IconButton onClick={hidePassword} label="Hide password"><EyeOff size={13} /></IconButton>
                  <IconButton
                    onClick={() => copyPasswordMx.mutate()}
                    disabled={copyPasswordMx.isPending}
                    label="Copy password"
                  ><Copy size={13} /></IconButton>
                </>
              ) : (
                <>
                  <span className="font-mono text-13 text-neutral-500 tracking-widest">••••••••</span>
                  <IconButton
                    onClick={() => showMx.mutate()}
                    disabled={showMx.isPending}
                    label="Show password"
                  ><Eye size={13} /></IconButton>
                  <IconButton
                    onClick={() => copyPasswordMx.mutate()}
                    disabled={copyPasswordMx.isPending}
                    label="Copy password"
                  ><Copy size={13} /></IconButton>
                </>
              )}
            </FieldBlock>
          </div>

          <div className="px-4 py-2 border-t border-neutral-200 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1 text-13 text-neutral-700 underline hover:text-neutral-900"
            >
              <Pencil size={13} /> Edit Credentials
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-red"
            >
              <Trash2 size={13} /> Delete
            </button>
            <span className="flex-1" />
            <span className="text-12 text-neutral-500">
              Show and Copy are audit-logged. Password hides after 30s.
            </span>
          </div>
        </>
      )}

      <Modal open={editing} title="GST Portal Access" onClose={() => setEditing(false)} width="w-[720px]">
        <PortalAccessSection gstProfileId={gstProfileId} />
      </Modal>

      <Modal
        open={confirmingDelete}
        title="Delete portal credentials?"
        onClose={() => setConfirmingDelete(false)}
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="h-8 px-3 text-13 border border-neutral-300 rounded hover:border-neutral-400"
            >Cancel</button>
            <button
              type="button"
              disabled={deleteMx.isPending}
              onClick={() => deleteMx.mutate()}
              className="h-8 px-3 text-13 bg-red text-white rounded hover:opacity-90 disabled:opacity-60"
            >{deleteMx.isPending ? 'Deleting…' : 'Delete'}</button>
          </>
        }
      >
        <p className="text-13 text-neutral-700">
          Clears the stored user ID and password. Any MFA contact, EWB and
          IRP fields on this GSTIN are left untouched.
        </p>
      </Modal>
    </PanelShell>
  );
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return <section className="bg-white border border-neutral-200 rounded">{children}</section>;
}

function PanelHeader({ configured }: { configured: boolean }) {
  return (
    <div className="h-10 px-4 flex items-center border-b border-neutral-200">
      <KeyRound size={14} className="text-neutral-500 mr-2" aria-hidden />
      <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">
        GST Portal Login Credentials
      </span>
      <div className="flex-1" />
      <span
        className={
          'inline-flex items-center gap-1 text-11 px-2 py-[2px] rounded-full ' +
          (configured
            ? 'bg-neutral-50 text-neutral-700 border border-neutral-200'
            : 'bg-neutral-50 text-neutral-500 border border-neutral-200')
        }
      >
        <span
          className={
            'inline-block h-[6px] w-[6px] rounded-full ' +
            (configured ? 'bg-green' : 'bg-neutral-300')
          }
        />
        {configured ? 'Configured' : 'Not configured'}
      </span>
    </div>
  );
}

function FieldBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">{label}</div>
      <div className="flex items-center gap-2 min-h-[24px]">{children}</div>
    </div>
  );
}

function IconButton({
  onClick, disabled, label, children,
}: {
  onClick: () => void; disabled?: boolean; label: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex items-center h-6 w-6 text-neutral-500 hover:text-neutral-900 disabled:opacity-40"
    >
      {children}
    </button>
  );
}
