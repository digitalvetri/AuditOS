import { useMutation, useQueryClient } from '@tanstack/react-query';
import { workstationApi } from '@/modules/workstation/api';
import { useToast } from '@/components/Toast';
import { StatusChipSelect } from '@/modules/workstation/listUi';

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
    <StatusChipSelect
      value={value}
      label="Document status"
      options={options.map((s) => ({ value: s, label: statusLabel(s) }))}
      onChange={onChange}
    />
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
