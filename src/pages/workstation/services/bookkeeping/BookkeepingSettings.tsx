import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { tallyAccountingApi } from '@/modules/tools/audit-automation/tally';
import { Panel, Loading, ErrorNote, ReportHeader, DataTable } from '@/modules/tools/tally/ui';
import type { ApiError } from '@/services/api';

/**
 * /settings — per-company configuration and voucher numbering.
 *
 * Everything here is a stored override on a documented default, so a
 * business rule is a setting rather than a code change.
 */
const LABELS: Record<string, string> = {
  accounting: 'Accounting', inventory: 'Inventory', gst: 'GST', voucher: 'Vouchers',
  invoice: 'Invoice printing', payroll: 'Payroll statutory rates', audit: 'Audit', security: 'Security',
};

export function BookkeepingSettings() {
  const { companyId = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Record<string, Record<string, unknown>>>({});

  const q = useQuery({ queryKey: ['tally.settings', companyId], queryFn: () => tallyAccountingApi.getSettings(companyId) });
  const typesQ = useQuery({ queryKey: ['tally.voucherTypes', companyId], queryFn: () => tallyAccountingApi.listVoucherTypes(companyId) });

  const save = useMutation({
    mutationFn: (group: string) => tallyAccountingApi.updateSettings(companyId, group, draft[group] ?? {}),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['tally.settings', companyId] });
      setDraft((d) => ({ ...d, [r.group]: {} }));
      toast.push('success', `${LABELS[r.group] ?? r.group} settings saved.`);
    },
    onError: (e: ApiError) => toast.push('error', e.message),
  });

  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const settings = q.data!;

  const valueOf = (group: string, key: string) => (draft[group] && key in draft[group] ? draft[group][key] : settings[group][key]);
  const setValue = (group: string, key: string, value: unknown) =>
    setDraft((d) => ({ ...d, [group]: { ...(d[group] ?? {}), [key]: value } }));

  return (
    <div data-testid="tally-settings">
      <ReportHeader title="Settings" subtitle="Business rules are configuration, not code. Changes apply to this company only." />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {Object.entries(settings).map(([group, values]) => (
          <Panel
            key={group}
            title={LABELS[group] ?? group}
            actions={
              <Button size="sm" variant="secondary" disabled={!draft[group] || Object.keys(draft[group]).length === 0 || save.isPending} onClick={() => save.mutate(group)}>
                Save
              </Button>
            }
          >
            <ul className="divide-y divide-neutral-100">
              {Object.entries(values).map(([key, def]) => (
                <li key={key} className="px-3 py-2 flex items-center justify-between gap-3">
                  <span className="text-13 text-neutral-700">{key.replace(/_/g, ' ')}</span>
                  {typeof def === 'boolean' ? (
                    <input type="checkbox" checked={Boolean(valueOf(group, key))} onChange={(e) => setValue(group, key, e.target.checked)} className="h-4 w-4 accent-neutral-900" />
                  ) : typeof def === 'number' ? (
                    <input
                      type="number" value={String(valueOf(group, key) ?? 0)}
                      onChange={(e) => setValue(group, key, Number(e.target.value))}
                      className="h-8 w-[140px] px-2 text-13 text-right border border-neutral-300 rounded font-mono focus:outline-none focus:border-gold"
                    />
                  ) : (
                    <input
                      value={String(valueOf(group, key) ?? '')}
                      onChange={(e) => setValue(group, key, e.target.value)}
                      className="h-8 w-[220px] px-2 text-13 border border-neutral-300 rounded focus:outline-none focus:border-gold"
                    />
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        ))}
      </div>

      <Panel title="Voucher numbering" className="mt-4">
        <DataTable
          minWidth="620px"
          rows={typesQ.data?.items ?? []}
          rowKey={(t) => t.id}
          columns={[
            { key: 'name', label: 'Voucher type', value: (t) => t.name },
            { key: 'method', label: 'Numbering', value: (t) => t.numbering_method },
            { key: 'prefix', label: 'Prefix', value: (t) => t.prefix ?? '' },
            { key: 'current', label: 'Last number', align: 'right', value: (t) => t.current_number },
            { key: 'effects', label: 'Effect', value: (t) => [t.affects_accounts ? 'accounts' : '', t.affects_stock ? 'stock' : '', t.is_order ? 'order only' : ''].filter(Boolean).join(' + ') },
          ]}
          empty="No voucher types."
        />
      </Panel>
    </div>
  );
}
