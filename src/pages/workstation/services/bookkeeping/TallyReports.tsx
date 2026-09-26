import { useParams, Link } from 'react-router-dom';
import { BookOpen, Scale, TrendingUp, Landmark, Users, Boxes, Percent, LineChart } from 'lucide-react';
import { usePeriod } from '@/modules/tools/tally/ui';

/**
 * /reports — the report index. Grouped the way an accountant looks for
 * them, and every link carries the current period so the report opens on
 * the dates already selected.
 */
const SECTIONS = [
  {
    heading: 'Accounting',
    icon: BookOpen,
    reports: [
      { to: 'day-book', label: 'Day Book', hint: 'Every voucher, newest first' },
      { to: 'trial-balance', label: 'Trial Balance', hint: 'Opening, movement, closing, and whether it balances' },
      { to: 'profit-and-loss', label: 'Profit & Loss', hint: 'Income and expenses for the period' },
      { to: 'balance-sheet', label: 'Balance Sheet', hint: 'Assets against liabilities and capital' },
      { to: 'group-summary', label: 'Group Summary', hint: 'Balances rolled up the group tree' },
    ],
  },
  {
    heading: 'Registers',
    icon: Scale,
    reports: [
      { to: 'register/sales', label: 'Sales Register', hint: 'Invoices with taxable value and tax' },
      { to: 'register/purchase', label: 'Purchase Register', hint: 'Bills with input tax' },
      { to: 'register/payment', label: 'Payment Register', hint: 'Money out' },
      { to: 'register/receipt', label: 'Receipt Register', hint: 'Money in' },
      { to: 'register/journal', label: 'Journal Register', hint: 'Adjustments' },
      { to: 'register/contra', label: 'Contra Register', hint: 'Cash ↔ bank movements' },
      { to: 'register/credit_note', label: 'Credit Note Register', hint: 'Sales returns and allowances' },
      { to: 'register/debit_note', label: 'Debit Note Register', hint: 'Purchase returns' },
    ],
  },
  {
    heading: 'Outstanding',
    icon: Users,
    reports: [
      { to: 'outstandings?side=receivable', label: 'Receivables', hint: 'Bill-wise, with ageing' },
      { to: 'outstandings?side=payable', label: 'Payables', hint: 'Bill-wise, with ageing' },
    ],
  },
  {
    heading: 'Cash & bank',
    icon: Landmark,
    reports: [
      { to: 'book/cash', label: 'Cash Book', hint: 'Every cash ledger' },
      { to: 'book/bank', label: 'Bank Book', hint: 'Every bank ledger' },
      { to: 'cash-flow', label: 'Cash Flow', hint: 'What moved cash, and where it went' },
    ],
  },
  {
    heading: 'Analysis',
    icon: LineChart,
    reports: [{ to: 'ratios', label: 'Ratio Analysis', hint: 'Liquidity, gearing and margins' }],
  },
];

export function TallyReports() {
  const { companyId = '' } = useParams();
  const { from, to } = usePeriod();
  const base = `/tally/companies/${companyId}/reports`;
  const query = (path: string) => `${base}/${path}${path.includes('?') ? '&' : '?'}from=${from}&to=${to}`;

  return (
    <div data-testid="tally-reports">
      <header className="mb-4">
        <h2 className="text-16 font-semibold text-neutral-900">Reports</h2>
        <p className="text-12 text-neutral-500 mt-0.5">
          Every report below is computed from posted vouchers for {from} to {to}. Each one drills down to the transactions behind it.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {SECTIONS.map((s) => (
          <section key={s.heading} className="bg-white border border-neutral-200 rounded">
            <div className="px-3 py-2 border-b border-neutral-100 flex items-center gap-2">
              <s.icon size={14} strokeWidth={1.75} className="text-neutral-500" />
              <h3 className="text-13 font-semibold text-neutral-900">{s.heading}</h3>
            </div>
            <ul className="divide-y divide-neutral-100">
              {s.reports.map((r) => (
                <li key={r.to}>
                  <Link to={query(r.to)} className="block px-3 py-2 hover:bg-neutral-50">
                    <div className="text-13 text-neutral-900">{r.label}</div>
                    <div className="text-11 text-neutral-500">{r.hint}</div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <section className="bg-white border border-neutral-200 rounded">
          <div className="px-3 py-2 border-b border-neutral-100 flex items-center gap-2">
            <Boxes size={14} strokeWidth={1.75} className="text-neutral-500" />
            <h3 className="text-13 font-semibold text-neutral-900">Inventory &amp; tax</h3>
          </div>
          <ul className="divide-y divide-neutral-100">
            <li><Link to={`/tally/companies/${companyId}/inventory`} className="block px-3 py-2 hover:bg-neutral-50"><div className="text-13 text-neutral-900">Stock Summary</div><div className="text-11 text-neutral-500">Opening, inward, outward, closing and valuation</div></Link></li>
            <li><Link to={`/tally/companies/${companyId}/gst`} className="block px-3 py-2 hover:bg-neutral-50"><div className="text-13 text-neutral-900 flex items-center gap-1"><Percent size={12} /> GST Summary, GSTR-1, GSTR-3B</div><div className="text-11 text-neutral-500">Prepared from posted vouchers</div></Link></li>
            <li><Link to={`/tally/companies/${companyId}/audit`} className="block px-3 py-2 hover:bg-neutral-50"><div className="text-13 text-neutral-900 flex items-center gap-1"><TrendingUp size={12} /> Audit &amp; exception reports</div><div className="text-11 text-neutral-500">Altered, cancelled and unusual transactions</div></Link></li>
          </ul>
        </section>
      </div>
    </div>
  );
}
