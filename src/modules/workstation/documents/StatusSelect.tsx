import { useMutation, useQueryClient } from '@tanstack/react-query';
import { workstationApi } from '@/modules/workstation/api';
import { useToast } from '@/components/Toast';

/**
 * Inline status control for a client document, shared by the client's
 * Documents folders and the firm-wide Documents list.
 */

const DOC_STATUSES = ['requested', 'pending', 'uploaded', 'under_review', 'verified', 'rejected', 'expired'] as const;
const statusLabel = (v: string) => v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function StatusSelect({
  value, canVerify, onChange,
}: {
  value: string;
  canVerify: boolean;
  onChange: (status: string) => void;
}) {
  // Verified / Rejected are a reviewer's call — only offered to verifiers,
  // but always shown when the document already carries them.
  const options = DOC_STATUSES.filter((s) => canVerify || (s !== 'verified' && s !== 'rejected') || s === value);
  return (
    <select
      value={value}
      // Rows elsewhere navigate on click; changing status must not.
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => { if (e.target.value !== value) onChange(e.target.value); }}
      className="h-7 pl-2 pr-7 text-12 border border-neutral-200 bg-white text-neutral-900 hover:border-neutral-400 focus:outline-none focus:border-gold"
      aria-label="Document status"
    >
      {options.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
    </select>
  );
}

/** Verified / Rejected go through the verify action; the rest are a plain update. */
export function useSetDocumentStatus() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      status === 'verified' || status === 'rejected'
        ? workstationApi.verifyDocument(id, status === 'verified', status === 'rejected' ? 'Rejected on review.' : undefined)
        : workstationApi.updateDocument(id, { status }),
    onSuccess: (doc) => {
      toast.push('success', `${doc.name} marked ${doc.status.replace(/_/g, ' ')}.`);
    },
    onError: (e: Error) => toast.push('error', e.message),
    // Refetch either way so a rejected change snaps back to the saved value.
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['workstation'] }); },
  });
}
