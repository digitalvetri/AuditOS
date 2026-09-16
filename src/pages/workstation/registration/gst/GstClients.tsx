/**
 * GST → Clients (§11).
 *
 * These are the firm's EXISTING clients with a GST profile attached — this
 * screen creates no second client record, which is why every row carries the
 * client's own name and code from Workstation.
 */
import { useQuery } from '@tanstack/react-query';
import {
  Card, PageHeader, QueryState, Table, Row, Cell, Status,
} from '@/modules/workstation/components';
import { gstApi } from '@/modules/workstation/gst/api';

export function GstClients() {
  const clients = useQuery({ queryKey: ['gst', 'clients'], queryFn: () => gstApi.clients() });

  return (
    <div className="space-y-4">
      <PageHeader
        title="GST clients"
        subtitle="Clients registered for GST, their GSTIN and who files for them."
      />
      <Card title="Registered clients">
        <QueryState query={clients}>
          {(d) =>
            d.items.length === 0 ? (
              <div className="px-4 py-6 text-13 text-neutral-500">
                No client has a GST profile yet.
              </div>
            ) : (
              <Table head={['Client', 'GSTIN', 'PAN', 'State', 'Type', 'Frequency', 'Assigned', 'Reviewer', 'Periods', 'Status']}>
                {d.items.map((c) => (
                  <Row key={c.id} status={c.registration_status}>
                    <Cell>{c.client_name ?? c.legal_name ?? '—'}</Cell>
                    <Cell muted><span className="font-mono text-12">{c.gstin}</span></Cell>
                    <Cell muted><span className="font-mono text-12">{c.pan ?? '—'}</span></Cell>
                    <Cell muted>{c.state ?? '—'}</Cell>
                    <Cell muted className="capitalize">{c.registration_type}</Cell>
                    <Cell muted className="capitalize">{c.filing_frequency}</Cell>
                    <Cell muted>{c.assigned_employee_name ?? '—'}</Cell>
                    <Cell muted>{c.reviewer_employee_name ?? '—'}</Cell>
                    <Cell muted>{c.period_count}</Cell>
                    <Cell><Status value={c.registration_status} /></Cell>
                  </Row>
                ))}
              </Table>
            )
          }
        </QueryState>
      </Card>
    </div>
  );
}
