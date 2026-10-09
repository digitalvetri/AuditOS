/**
 * Audit-file picker options for other modules (task form, invoice builder):
 * the live audit files of one client. Hidden quietly — `available: false` —
 * when the caller cannot read audit files (403) or no client is chosen.
 */
import { useQuery } from '@tanstack/react-query';
import { auditApi } from './api';

export interface AuditFileOption { value: string; label: string }

export function useAuditFileOptions(clientId: string | null | undefined) {
  const q = useQuery({
    queryKey: ['audits', 'picker', clientId ?? ''],
    queryFn: () => auditApi.list({ client_id: clientId ?? undefined }),
    enabled: Boolean(clientId),
    retry: false,
    staleTime: 60_000,
  });
  const options: AuditFileOption[] = (q.data?.items ?? [])
    .filter((a) => a.status !== 'archived')
    .map((a) => ({ value: a.id, label: `${a.audit_code} — ${a.title}` }));
  return { options, loading: q.isLoading, available: Boolean(clientId) && !q.isError };
}
