import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import { useToast } from '@/components/Toast';

/**
 * "Revoke old links" — withdraws every download link already sent for this
 * document (email / WhatsApp), then fetches a fresh one for the dialog.
 * Links sent from now on keep working.
 */
export function RevokeLinksButton({ kind, id }: { kind: 'quotation' | 'invoice' | 'engagement'; id: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => api.post<{ revoked_before: string }>('/api/share/revoke', { kind, id }),
    onSuccess: async () => {
      // The dialog's current link was issued before the cut-off: replace it.
      await qc.invalidateQueries({ queryKey: ['share.public-link', kind, id] });
      toast.push('success', 'Old links revoked. Links you send from now on will work.');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  return (
    <button
      type="button"
      disabled={revoke.isPending}
      onClick={() => {
        if (window.confirm('Revoke every link already sent for this document? Anyone opening an old link will be asked for a new one.')) revoke.mutate();
      }}
      className="mt-1 text-12 text-neutral-500 underline hover:text-neutral-900 disabled:opacity-50"
    >
      {revoke.isPending ? 'Revoking…' : 'Revoke old links'}
    </button>
  );
}
