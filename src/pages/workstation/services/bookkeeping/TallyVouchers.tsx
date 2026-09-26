import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { Button } from '@/components/Button';
import { tallyAccountingApi, type TallyVoucher } from '@/modules/tools/audit-automation/tally';
import { DataTable, Money, Panel, Loading, usePeriod, ReportHeader, ExportButtons, StatusPill, type Column } from '@/modules/tools/tally/ui';

/**
 * /tally/companies/:companyId/vouchers — the voucher register.
 * Filter by type, date, ledger, status or free text; open any row to the
 * voucher, or start a new one in any configured voucher type.
 */
export function TallyVouchers() {
  const { companyId = '' } = useParams();
  const navigate = useNavigate();
  const { from, to } = usePeriod();
  const [typeCode, setTypeCode] = useState('');
  const [status, setStatus] = useState('active');
  const [q, setQ] = useState('');

  const typesQ = useQuery({
    queryKey: ['tally.voucherTypes', companyId],
    enabled: Boolean(companyId),
    queryFn: () => tallyAccountingApi.listVoucherTypes(companyId),
  });
  const vouchersQ = useQuery({
    queryKey: ['tally.vouchers', companyId, from, to, typeCode, status, q],
    enabled: Boolean(companyId),
    queryFn: () => tallyAccountingApi.listVouchers(companyId, {
      from, to, type_codes: typeCode || undefined, status, q: q.trim() || undefined, limit: 200,
    }),
  });

  const base = `/tally/companies/${companyId}`;
  const rows = vouchersQ.data?.items ?? [];
  const columns = voucherColumns(base);

  return (
    <div data-testid="tally-vouchers">
      <ReportHeader
        title="Vouchers"
        subtitle="Every posted transaction. Debits equal credits on all of them — the engine will not save one that does not."
        actions={
          <>
            <ExportButtons filename="vouchers.csv" rows={rows} columns={columns} />
            <Button variant="primary" size="sm" onClick={() => navigate(`${base}/vouchers/new`)}>
              <Plus size={14} strokeWidth={1.75} className="mr-1" /> New voucher
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select
          value={typeCode}
          onChange={(e) => setTypeCode(e.target.value)}
          className="h-8 px-2 text-12 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
          aria-label="Voucher type"
        >
          <option value="">All voucher types</option>
          {(typesQ.data?.items ?? []).map((t) => <option key={t.id} value={t.code}>{t.name}</option>)}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-8 px-2 text-12 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
          aria-label="Status"
        >
          <option value="active">Active</option>
          <option value="cancelled">Cancelled</option>
          <option value="all">All</option>
        </select>
        <label className="relative">
          <span className="absolute inset-y-0 left-2 flex items-center text-neutral-400"><Search size={13} strokeWidth={1.75} /></span>
          <input
            type="search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Number, party, narration…"
            className="h-8 w-[240px] pl-7 pr-2 text-12 bg-white border border-neutral-300 rounded focus:outline-none focus:border-gold"
          />
        </label>
        <span className="text-12 text-neutral-500">
          {vouchersQ.data ? `${vouchersQ.data.total} voucher${vouchersQ.data.total === 1 ? '' : 's'}` : ''}
        </span>
      </div>

      {vouchersQ.isLoading ? <Loading /> : (
        <Panel>
          <DataTable<TallyVoucher>
            rows={rows}
            rowKey={(r) => r.id}
            columns={columns}
            onRowClick={(r) => navigate(`${base}/vouchers/${r.id}`)}
            empty="No vouchers match these filters."
          />
        </Panel>
      )}
    </div>
  );
}

export function voucherColumns(base: string): Column<TallyVoucher>[] {
  return [
    { key: 'date', label: 'Date', width: '96px', value: (r) => r.date, render: (r) => <span className="tabular-nums text-neutral-600">{r.date}</span> },
    { key: 'type', label: 'Type', value: (r) => r.voucher_type_name ?? r.voucher_type_code, render: (r) => <span className="capitalize text-neutral-700">{r.voucher_type_name ?? r.voucher_type_code.replace(/_/g, ' ')}</span> },
    {
      key: 'number', label: 'No.', value: (r) => r.voucher_number,
      render: (r) => <Link to={`${base}/vouchers/${r.id}`} className="text-neutral-900 font-medium hover:text-gold">{r.voucher_number}</Link>,
    },
    { key: 'party', label: 'Party', value: (r) => r.party_name ?? '', render: (r) => <span className="text-neutral-700">{r.party_name ?? '—'}</span> },
    { key: 'narration', label: 'Narration', value: (r) => r.narration ?? '', render: (r) => <span className="text-neutral-500 truncate block max-w-[240px]">{r.narration ?? '—'}</span> },
    { key: 'amount', label: 'Amount', align: 'right', value: (r) => (r.grand_total_paise || r.total_debit_paise) / 100, render: (r) => <Money paise={r.grand_total_paise || r.total_debit_paise} /> },
    {
      key: 'status', label: 'Status', align: 'center', value: (r) => r.status,
      render: (r) => (r.status === 'active' ? (r.version > 1 ? <StatusPill status="altered" /> : <span className="text-11 text-neutral-400">—</span>) : <StatusPill status={r.status} />),
    },
  ];
}
