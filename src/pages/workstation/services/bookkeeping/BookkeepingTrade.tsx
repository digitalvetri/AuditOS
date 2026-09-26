import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Button } from '@/components/Button';
import { bookkeepingAccountingApi } from '@/modules/tools/audit-automation/bookkeeping';
import { DataTable, Money, Panel, Loading, ErrorNote, usePeriod, ReportHeader, ExportButtons } from '@/modules/tools/bookkeeping/ui';

/**
 * /sales and /purchase — the trade workspaces.
 *
 * One component, two modes: the register for the period, the outstanding
 * position for the counterparties, and the shortcuts that create the
 * documents in that cycle. Every figure comes from the same vouchers the
 * reports read.
 */
export function BookkeepingTrade({ mode }: { mode: 'sales' | 'purchase' }) {
  const { companyId = '' } = useParams();
  const { from, to } = usePeriod();
  const navigate = useNavigate();
  const base = `/workstation/services/bookkeeping/companies/${companyId}`;
  const isSales = mode === 'sales';

  const registerQ = useQuery({
    queryKey: ['tally.register', companyId, mode, from, to],
    queryFn: () => bookkeepingAccountingApi.register(companyId, mode, { from, to }),
  });
  const notesQ = useQuery({
    queryKey: ['tally.register', companyId, isSales ? 'credit_note' : 'debit_note', from, to],
    queryFn: () => bookkeepingAccountingApi.register(companyId, isSales ? 'credit_note' : 'debit_note', { from, to }),
  });
  const outstandingQ = useQuery({
    queryKey: ['tally.outstandings', companyId, isSales ? 'receivable' : 'payable', to],
    queryFn: () => bookkeepingAccountingApi.outstandings(companyId, isSales ? 'receivable' : 'payable', { as_of: to }),
  });

  const shortcuts: { code: string; label: string }[] = isSales
    ? [
        { code: 'quotation', label: 'Quotation' },
        { code: 'sales_order', label: 'Sales order' },
        { code: 'delivery_note', label: 'Delivery note' },
        { code: 'sales', label: 'Sales invoice' },
        { code: 'credit_note', label: 'Credit note' },
        { code: 'receipt', label: 'Receipt' },
      ]
    : [
        { code: 'purchase_order', label: 'Purchase order' },
        { code: 'receipt_note', label: 'Receipt note' },
        { code: 'purchase', label: 'Purchase invoice' },
        { code: 'debit_note', label: 'Debit note' },
        { code: 'payment', label: 'Payment' },
      ];

  if (registerQ.isLoading) return <Loading />;
  if (registerQ.isError) return <ErrorNote message={(registerQ.error as Error).message} />;
  const reg = registerQ.data!;

  const columns = [
    { key: 'date', label: 'Date', value: (r: typeof reg.items[number]) => r.date },
    { key: 'no', label: 'No.', value: (r: typeof reg.items[number]) => r.voucher_number, render: (r: typeof reg.items[number]) => <Link to={`${base}/vouchers/${r.voucher_id}`} className="text-neutral-900 font-medium hover:text-gold">{r.voucher_number}</Link> },
    { key: 'party', label: isSales ? 'Customer' : 'Supplier', value: (r: typeof reg.items[number]) => r.party_name ?? '' },
    { key: 'taxable', label: 'Taxable', align: 'right' as const, value: (r: typeof reg.items[number]) => r.taxable_value_paise / 100, render: (r: typeof reg.items[number]) => <Money paise={r.taxable_value_paise} /> },
    { key: 'tax', label: 'Tax', align: 'right' as const, value: (r: typeof reg.items[number]) => (r.cgst_paise + r.sgst_paise + r.igst_paise) / 100, render: (r: typeof reg.items[number]) => <Money paise={r.cgst_paise + r.sgst_paise + r.igst_paise} /> },
    { key: 'total', label: 'Total', align: 'right' as const, value: (r: typeof reg.items[number]) => r.grand_total_paise / 100, render: (r: typeof reg.items[number]) => <Money paise={r.grand_total_paise} /> },
  ];

  return (
    <div data-testid={`tally-${mode}`}>
      <ReportHeader
        title={isSales ? 'Sales' : 'Purchase'}
        subtitle={`${from} to ${to}`}
        actions={
          <>
            <ExportButtons filename={`${mode}-register.csv`} rows={reg.items} columns={columns} />
            <Button variant="primary" size="sm" onClick={() => navigate(`${base}/vouchers/new?type=${mode}`)}>
              <Plus size={14} className="mr-1" /> New {isSales ? 'invoice' : 'bill'}
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap gap-2 mb-4 print:hidden">
        {shortcuts.map((s) => (
          <Link
            key={s.code}
            to={`${base}/vouchers/new?type=${s.code}`}
            className="h-8 px-3 inline-flex items-center text-12 border border-neutral-300 rounded bg-white hover:border-gold"
          >
            + {s.label}
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
        <Box label={isSales ? 'Sales value' : 'Purchase value'} paise={reg.totals.taxableValuePaise} />
        <Box label="Tax" paise={reg.totals.cgstPaise + reg.totals.sgstPaise + reg.totals.igstPaise} />
        <Box label="Invoice total" paise={reg.totals.grandTotalPaise} />
        <Box label={isSales ? 'Receivable' : 'Payable'} paise={outstandingQ.data?.totalPaise ?? 0} />
      </div>

      <Panel title={`${isSales ? 'Sales' : 'Purchase'} register`} className="mb-4">
        <DataTable
          minWidth="760px" rows={reg.items} rowKey={(r) => r.voucher_id} columns={columns}
          onRowClick={(r) => navigate(`${base}/vouchers/${r.voucher_id}`)}
          empty={`No ${isSales ? 'invoices' : 'bills'} in this period.`}
          footer={
            <tr>
              <td className="px-3 py-2" colSpan={3}>Total</td>
              <td className="px-3 py-2 text-right"><Money paise={reg.totals.taxableValuePaise} bold /></td>
              <td className="px-3 py-2 text-right"><Money paise={reg.totals.cgstPaise + reg.totals.sgstPaise + reg.totals.igstPaise} bold /></td>
              <td className="px-3 py-2 text-right"><Money paise={reg.totals.grandTotalPaise} bold /></td>
            </tr>
          }
        />
      </Panel>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel
          title={isSales ? 'Customer outstanding' : 'Supplier outstanding'}
          actions={<Link to={`${base}/reports/outstandings?side=${isSales ? 'receivable' : 'payable'}`} className="text-12 text-gold hover:underline">Bill-wise →</Link>}
        >
          <DataTable
            minWidth="420px"
            rows={outstandingQ.data?.parties ?? []}
            rowKey={(p) => p.ledger_id}
            columns={[
              { key: 'party', label: 'Party', value: (p) => p.ledger_name, render: (p) => <Link to={`${base}/reports/ledger/${p.ledger_id}`} className="text-neutral-900 hover:text-gold">{p.ledger_name}</Link> },
              { key: 'bills', label: 'Open bills', align: 'right', value: (p) => p.bills.length },
              { key: 'total', label: 'Outstanding', align: 'right', value: (p) => p.total_paise / 100, render: (p) => <Money paise={p.total_paise} /> },
            ]}
            empty="Nothing outstanding."
          />
        </Panel>

        <Panel title={isSales ? 'Credit notes' : 'Debit notes'}>
          <DataTable
            minWidth="420px"
            rows={notesQ.data?.items ?? []}
            rowKey={(r) => r.voucher_id}
            columns={[
              { key: 'date', label: 'Date', value: (r) => r.date },
              { key: 'no', label: 'No.', value: (r) => r.voucher_number, render: (r) => <Link to={`${base}/vouchers/${r.voucher_id}`} className="text-neutral-900 hover:text-gold">{r.voucher_number}</Link> },
              { key: 'party', label: 'Party', value: (r) => r.party_name ?? '' },
              { key: 'total', label: 'Total', align: 'right', value: (r) => r.grand_total_paise / 100, render: (r) => <Money paise={r.grand_total_paise} /> },
            ]}
            empty="None in this period."
          />
        </Panel>
      </div>
    </div>
  );
}

function Box({ label, paise }: { label: string; paise: number }) {
  return (
    <div className="bg-white border border-neutral-200 rounded p-3">
      <div className="text-11 text-neutral-500">{label}</div>
      <div className="text-16 font-semibold text-neutral-900 mt-0.5"><Money paise={paise} /></div>
    </div>
  );
}
