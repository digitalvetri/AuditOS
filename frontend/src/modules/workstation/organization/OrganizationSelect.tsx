import { useQuery } from '@tanstack/react-query';
import { workstationApi } from '@/modules/workstation/api';
import { Field, inputClass } from '@/modules/workstation/components';

/**
 * The optional "Organization" a client sits under — Add Client and Edit
 * Client Details. Lists the active organizations the caller can see, with
 * "None" first. Choosing one bills the client in the organization's name.
 *
 * `current` keeps an organization that is no longer listed (inactive, or not
 * visible to this caller) selectable, so opening the form never silently
 * changes the link.
 */
export function OrganizationSelect({ value, onChange, error, current }: {
  value: string;
  onChange: (id: string) => void;
  error?: string;
  current?: { id: string; name: string } | null;
}) {
  const orgs = useQuery({
    queryKey: ['workstation', 'clients', 'organizations'],
    queryFn: () => workstationApi.listClients({ kind: 'organization' }),
    staleTime: 60_000,
  });
  const options = (orgs.data?.items ?? [])
    .filter((o) => o.status !== 'inactive' || o.id === value)
    .map((o) => ({ id: o.id, name: o.company_name }));
  if (current && !options.some((o) => o.id === current.id)) options.unshift(current);

  return (
    <Field
      label="Organization"
      error={error}
      hint="Invoices and quotations for this client are billed in the organization's name."
    >
      <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} disabled={orgs.isLoading}>
        <option value="">None</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </Field>
  );
}
