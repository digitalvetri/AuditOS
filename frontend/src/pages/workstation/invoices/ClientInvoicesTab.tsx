import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Card, Cell, QueryState, Row, Status, Table } from '@/modules/workstation/components';
import type { ClientDetail } from '@/modules/workstation/types';
import { invoicesApi } from '@/modules/workstation/invoices/api';
import { Button } from '@/components/Button';
import { fmtDate, inr } from '@/lib/format';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';

/**
 * A client's invoices, and the way to raise another one.
 *
 * The row's action follows the invoice's own state: only a DRAFT is still
 * editable (`is_editable` is the server's word on that), so anything issued
 * opens read-only. Money and payment state come off the row as stored.
 *
 * On an ORGANIZATION the list also holds its clients' invoices — they are
 * billed in its name — with a Client column, so the partner's full billing
 * is in one place. The server still applies the caller's visibility.
 */
export function ClientInvoicesTab({ client }: { client: ClientDetail }) {
  const navigate = useNavigate();
  const { session } = useAuth();
  const mayWrite = can(session?.role.code, 'workstation.invoice.manage', 'self');
  const isOrg = !!client.is_organization;

  const invoices = useQuery({
    queryKey: ['workstation', 'client', client.id, 'invoices', isOrg ? 'with-clients' : 'own'],
    queryFn: () => invoicesApi.list({ client_id: client.id, include_organization_clients: isOrg || undefined, limit: 50 }),
  });

  const build = () => navigate(`/workstation/invoices/new?client_id=${client.id}`);
  const head = isOrg
    ? ['Invoice', 'Client', 'Date', 'Due', 'Status', 'Total', 'Balance', '']
    : ['Invoice', 'Date', 'Due', 'Status', 'Total', 'Balance', ''];

  return (
    <Card
      title="Invoices"
      right={mayWrite ? <Button onClick={build}>New invoice</Button> : undefined}
    >
      {isOrg ? (
        <div className="px-4 pt-3 text-12 text-neutral-500">
          Includes invoices for this organization&apos;s clients, which are billed in its name.
        </div>
      ) : null}
      <QueryState query={invoices} empty={isOrg ? 'No invoices for this organization or its clients yet.' : 'No invoices for this client yet.'}>
        {(data) => (
          <Table head={head}>
            {data.items.map((v) => {
              const editable = v.is_editable && mayWrite;
              return (
                <Row
                  key={v.id}
                  status={v.status}
                  onClick={() => navigate(`/workstation/invoices/${v.id}`)}
                >
                  <Cell>{v.invoice_number ?? 'Draft'}</Cell>
                  {isOrg ? <Cell>{v.client_id === client.id ? 'This organization' : v.client_name ?? '—'}</Cell> : null}
                  <Cell>{fmtDate(v.invoice_date)}</Cell>
                  <Cell>{v.due_date ? fmtDate(v.due_date) : '—'}</Cell>
                  <Cell><Status value={v.status} /></Cell>
                  <Cell>{inr(v.total_paise)}</Cell>
                  <Cell>{inr(v.balance_due_paise)}</Cell>
                  <Cell>
                    <button
                      type="button"
                      className="text-13 text-primary hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(editable
                          ? `/workstation/invoices/${v.id}/edit`
                          : `/workstation/invoices/${v.id}`);
                      }}
                    >
                      {editable ? 'Continue building' : 'View'}
                    </button>
                  </Cell>
                </Row>
              );
            })}
          </Table>
        )}
      </QueryState>
    </Card>
  );
}
