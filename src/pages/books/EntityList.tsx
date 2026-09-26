import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Plus } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { booksApi, errorText, type ZRecord } from '@/modules/books/api';
import { useBooks, useOrg } from '@/modules/books/context';
import { Badge, Btn, Cell, Drawer, Empty, ErrorState, KV, Modal, PageHeader, Pager, Row, Section, Select, Skeleton, Table, TextInput, date, money } from '@/modules/books/ui';
import { ActionForm, ApplyCreditForm, BankAccountForm, ContactForm, ExpenseForm, ItemForm, PaymentForm, TaxForm, TXN, TxnEditor } from './forms';

/**
 * One list screen for every Zoho Books resource, driven by RESOURCES below:
 * server-side search / filter / sort / pagination, a detail drawer with the
 * record's lines and totals, and only the actions Zoho supports for it.
 */
type Perm = 'manage' | 'accountant' | 'settings';
interface Col { label: string; right?: boolean; sortKey?: string; render: (r: ZRecord, cur: string | null) => ReactNode }
interface FormProps { record?: ZRecord; onClose: () => void; onSaved: (r: ZRecord) => void }
export interface Resource {
  entity: string; title: string; singular: string; idField: string; nameField: string;
  subtitle?: string; filters?: { value: string; label: string }[]; dated?: boolean;
  columns: Col[]; Form?: (p: FormProps) => JSX.Element; createPerm?: Perm; editPerm?: Perm; deletePerm?: Perm;
  detail: (r: ZRecord, cur: string | null) => [string, ReactNode][];
  detailPath?: string; empty: string; pdf?: boolean;
  /** Zoho Books web-app route (after `#/`) — create / edit happen there when there is no in-app Form. */
  zohoPath?: string;
}

/** Deep link into the Zoho Books web app for the active organisation, on its data centre. */
export function useZohoWebUrl(): (path: string) => string {
  const { status } = useBooks();
  const org = useOrg();
  const dc = status.connections.find((c) => c.status === 'connected')?.data_center ?? 'https://accounts.zoho.in';
  const host = dc.replace('://accounts.', '://books.').replace(/\/$/, '');
  return (path) => `${host}/app/${org.zoho_org_id}#/${path}`;
}

const zohoLinkCls = 'h-9 px-3 text-13 font-medium rounded inline-flex items-center gap-1.5 bg-surface text-ink border border-border hover:bg-canvas';

const m = (v: unknown, r: ZRecord, cur: string | null) => money(v, r.currency_code ?? cur);
const num = (field: string): Col => ({ label: 'Number', sortKey: field, render: (r) => <span className="font-medium">{r[field] ?? '—'}</span> });
const col = (label: string, field: string, sortKey?: string): Col => ({ label, sortKey, render: (r) => r[field] || <span className="text-inkFaint">—</span> });
const dcol = (label: string, field: string, sortKey?: string): Col => ({ label, sortKey, render: (r) => date(r[field]) });
const mcol = (label: string, field: string, sortKey?: string): Col => ({ label, right: true, sortKey, render: (r, c) => m(r[field], r, c) });
const status: Col = { label: 'Status', render: (r) => <Badge status={r.status} /> };
const firstOf = (r: ZRecord, fields: string[]) => fields.map((f) => r[f]).find((v) => v !== undefined && v !== null && v !== '');
const any = (label: string, ...fields: string[]): Col => ({ label, render: (r) => { const v = firstOf(r, fields); return v === undefined ? <span className="text-inkFaint">—</span> : String(v).replace(/_/g, ' '); } });
const anyD = (label: string, ...fields: string[]): Col => ({ label, render: (r) => date(firstOf(r, fields)) });
const activeCol: Col = { label: 'Status', render: (r) => <Badge status={r.status ?? (r.is_active === false ? 'inactive' : 'active')} /> };
type KvSpec = [label: string, fields: string | string[], kind?: 'm' | 'd' | 's'];
const kv = (...spec: KvSpec[]) => (r: ZRecord, cur: string | null): [string, ReactNode][] => spec.map(([label, f, kind]) => {
  const v = firstOf(r, Array.isArray(f) ? f : [f]);
  return [label, kind === 'm' ? (v === undefined ? null : m(v, r, cur)) : kind === 'd' ? date(v) : kind === 's' ? <Badge status={v ?? (r.is_active === false ? 'inactive' : 'active')} /> : (v === undefined ? null : String(v).replace(/_/g, ' '))];
});
const st = (...xs: [string, string][]) => xs.map(([value, label]) => ({ value, label }));

const txnDetail = (party: string, numberField: string, second?: [string, string]) => (r: ZRecord, cur: string | null): [string, ReactNode][] => [
  ['Number', r[numberField]], [party === 'customer_name' ? 'Customer' : 'Vendor', r[party]], ['Status', <Badge status={r.status} />],
  ['Date', date(r.date)], ...(second ? [[second[1], date(r[second[0]])] as [string, ReactNode]] : []), ['Reference', r.reference_number],
  ['Total', m(r.total, r, cur)], ['Balance', r.balance !== undefined ? m(r.balance, r, cur) : null], ['Place of supply', r.place_of_supply],
];
const contactDetail = (balanceField: string) => (r: ZRecord, cur: string | null): [string, ReactNode][] => [
  ['Name', r.contact_name], ['Company', r.company_name], ['Email', r.email], ['Phone', r.phone ?? r.mobile], ['Status', <Badge status={r.status} />],
  ['Outstanding', m(r[balanceField], r, cur)], ['GST treatment', r.gst_treatment?.replace(/_/g, ' ')], ['GSTIN', r.gst_no], ['Payment terms', r.payment_terms_label],
];

export const RESOURCES: Record<string, Resource> = {
  customers: {
    entity: 'customers', title: 'Customers', singular: 'customer', idField: 'contact_id', nameField: 'contact_name', empty: 'No customers found.',
    filters: st(['Status.Active', 'Active'], ['Status.Inactive', 'Inactive'], ['Status.All', 'All'], ['Status.OverDue', 'Overdue'], ['Status.Unpaid', 'Unpaid']),
    columns: [col('Name', 'contact_name', 'contact_name'), col('Company', 'company_name'), col('Email', 'email', 'email'), col('Phone', 'phone'), mcol('Receivable', 'outstanding_receivable_amount', 'outstanding_receivable_amount'), status],
    Form: (p) => <ContactForm kind="customer" {...p} />, createPerm: 'manage', editPerm: 'manage', deletePerm: 'accountant', detail: contactDetail('outstanding_receivable_amount'), detailPath: '/books/customers',
  },
  vendors: {
    entity: 'vendors', title: 'Vendors', singular: 'vendor', idField: 'contact_id', nameField: 'contact_name', empty: 'No vendors found.',
    filters: st(['Status.Active', 'Active'], ['Status.Inactive', 'Inactive'], ['Status.All', 'All']),
    columns: [col('Name', 'contact_name', 'contact_name'), col('Company', 'company_name'), col('Email', 'email', 'email'), col('Phone', 'phone'), mcol('Payable', 'outstanding_payable_amount', 'outstanding_payable_amount'), status],
    Form: (p) => <ContactForm kind="vendor" {...p} />, createPerm: 'manage', editPerm: 'manage', deletePerm: 'accountant', detail: contactDetail('outstanding_payable_amount'), detailPath: '/books/vendors',
  },
  items: {
    entity: 'items', title: 'Items', singular: 'item', idField: 'item_id', nameField: 'name', empty: 'No items found.', subtitle: 'Products and services from Zoho Books.',
    filters: st(['Status.Active', 'Active'], ['Status.Inactive', 'Inactive'], ['Status.All', 'All']),
    columns: [col('Name', 'name', 'name'), col('SKU', 'sku'), col('Unit', 'unit'), mcol('Selling price', 'rate', 'rate'), mcol('Cost price', 'purchase_rate'), { label: 'Tax', render: (r) => r.tax_name ? `${r.tax_name}` : '—' }, status],
    Form: ItemForm, createPerm: 'manage', editPerm: 'manage', deletePerm: 'accountant',
    detail: (r, c) => [['Name', r.name], ['Type', r.product_type], ['SKU', r.sku], ['Unit', r.unit], ['HSN / SAC', r.hsn_or_sac], ['Status', <Badge status={r.status} />], ['Selling price', m(r.rate, r, c)], ['Cost price', r.purchase_rate != null ? m(r.purchase_rate, r, c) : null], ['Sales account', r.account_name], ['Purchase account', r.purchase_account_name], ['Tax', r.tax_name ? `${r.tax_name} (${r.tax_percentage}%)` : null], ['Stock on hand', r.stock_on_hand], ['Description', r.description]],
  },
  estimates: {
    entity: 'estimates', title: 'Quotes', singular: 'quote', idField: 'estimate_id', nameField: 'estimate_number', empty: 'No quotes found.', dated: true, pdf: true,
    filters: st(['Status.All', 'All'], ['Status.Draft', 'Draft'], ['Status.Sent', 'Sent'], ['Status.Accepted', 'Accepted'], ['Status.Declined', 'Declined'], ['Status.Invoiced', 'Invoiced'], ['Status.Expired', 'Expired']),
    columns: [dcol('Date', 'date', 'date'), num('estimate_number'), col('Customer', 'customer_name', 'customer_name'), col('Reference', 'reference_number'), status, mcol('Amount', 'total', 'total')],
    Form: (p) => <TxnEditor spec={TXN.estimates} {...p} />, createPerm: 'manage', editPerm: 'manage', deletePerm: 'accountant', detail: txnDetail('customer_name', 'estimate_number', ['expiry_date', 'Expiry date']),
  },
  salesorders: {
    entity: 'salesorders', title: 'Sales Orders', singular: 'sales order', idField: 'salesorder_id', nameField: 'salesorder_number', empty: 'No sales orders found.', dated: true, pdf: true,
    filters: st(['Status.All', 'All'], ['Status.Draft', 'Draft'], ['Status.Open', 'Open'], ['Status.Invoiced', 'Invoiced'], ['Status.Void', 'Void']),
    columns: [dcol('Date', 'date', 'date'), num('salesorder_number'), col('Customer', 'customer_name', 'customer_name'), col('Reference', 'reference_number'), status, mcol('Amount', 'total', 'total')],
    Form: (p) => <TxnEditor spec={TXN.salesorders} {...p} />, createPerm: 'manage', editPerm: 'manage', deletePerm: 'accountant', detail: txnDetail('customer_name', 'salesorder_number', ['shipment_date', 'Expected shipment']),
  },
  invoices: {
    entity: 'invoices', title: 'Invoices', singular: 'invoice', idField: 'invoice_id', nameField: 'invoice_number', empty: 'No invoices found.', dated: true, pdf: true,
    filters: st(['Status.All', 'All'], ['Status.Draft', 'Draft'], ['Status.Sent', 'Sent'], ['Status.Unpaid', 'Unpaid'], ['Status.PartiallyPaid', 'Partially paid'], ['Status.OverDue', 'Overdue'], ['Status.Paid', 'Paid'], ['Status.Void', 'Void']),
    columns: [dcol('Date', 'date', 'date'), num('invoice_number'), col('Customer', 'customer_name', 'customer_name'), dcol('Due date', 'due_date', 'due_date'), status, mcol('Amount', 'total', 'total'), mcol('Balance due', 'balance', 'balance')],
    Form: (p) => <TxnEditor spec={TXN.invoices} {...p} />, createPerm: 'manage', editPerm: 'manage', deletePerm: 'accountant', detail: txnDetail('customer_name', 'invoice_number', ['due_date', 'Due date']),
  },
  purchaseorders: {
    entity: 'purchaseorders', title: 'Purchase Orders', singular: 'purchase order', idField: 'purchaseorder_id', nameField: 'purchaseorder_number', empty: 'No purchase orders found.', dated: true, pdf: true,
    filters: st(['Status.All', 'All'], ['Status.Draft', 'Draft'], ['Status.Open', 'Open'], ['Status.Billed', 'Billed'], ['Status.Cancelled', 'Cancelled']),
    columns: [dcol('Date', 'date', 'date'), num('purchaseorder_number'), col('Vendor', 'vendor_name', 'vendor_name'), col('Reference', 'reference_number'), dcol('Delivery', 'delivery_date'), status, mcol('Amount', 'total', 'total')],
    Form: (p) => <TxnEditor spec={TXN.purchaseorders} {...p} />, createPerm: 'manage', editPerm: 'manage', deletePerm: 'accountant', detail: txnDetail('vendor_name', 'purchaseorder_number', ['delivery_date', 'Delivery date']),
  },
  bills: {
    entity: 'bills', title: 'Bills', singular: 'bill', idField: 'bill_id', nameField: 'bill_number', empty: 'No bills found.', dated: true,
    filters: st(['Status.All', 'All'], ['Status.Open', 'Open'], ['Status.PartiallyPaid', 'Partially paid'], ['Status.Overdue', 'Overdue'], ['Status.Paid', 'Paid'], ['Status.Void', 'Void']),
    columns: [dcol('Date', 'date', 'date'), num('bill_number'), col('Vendor', 'vendor_name', 'vendor_name'), dcol('Due date', 'due_date', 'due_date'), status, mcol('Amount', 'total', 'total'), mcol('Balance due', 'balance', 'balance')],
    Form: (p) => <TxnEditor spec={TXN.bills} {...p} />, createPerm: 'manage', editPerm: 'manage', deletePerm: 'accountant', detail: txnDetail('vendor_name', 'bill_number', ['due_date', 'Due date']),
  },
  expenses: {
    entity: 'expenses', title: 'Expenses', singular: 'expense', idField: 'expense_id', nameField: 'account_name', empty: 'No expenses found.',
    filters: st(['Status.All', 'All'], ['Status.Billable', 'Billable'], ['Status.Nonbillable', 'Non-billable'], ['Status.Unbilled', 'Unbilled'], ['Status.Invoiced', 'Invoiced'], ['Status.Reimbursed', 'Reimbursed']),
    columns: [dcol('Date', 'date', 'date'), col('Expense account', 'account_name'), col('Vendor', 'vendor_name'), col('Paid through', 'paid_through_account_name'), col('Customer', 'customer_name'), status, mcol('Amount', 'total', 'total')],
    Form: ExpenseForm, createPerm: 'manage', editPerm: 'manage', deletePerm: 'accountant',
    detail: (r, c) => [['Date', date(r.date)], ['Expense account', r.account_name], ['Amount', m(r.total ?? r.amount, r, c)], ['Paid through', r.paid_through_account_name], ['Vendor', r.vendor_name], ['Customer', r.customer_name], ['Billable', r.is_billable ? 'Yes' : 'No'], ['Tax', r.tax_name], ['Reference', r.reference_number], ['Receipt', r.receipt_name], ['Description', r.description], ['Status', <Badge status={r.status} />]],
  },
  customerpayments: {
    entity: 'customerpayments', title: 'Payments Received', singular: 'payment', idField: 'payment_id', nameField: 'payment_number', empty: 'No payments found.',
    columns: [dcol('Date', 'date', 'date'), num('payment_number'), col('Customer', 'customer_name', 'customer_name'), col('Mode', 'payment_mode'), col('Reference', 'reference_number'), col('Invoices', 'invoice_numbers'), mcol('Amount', 'amount', 'amount'), mcol('Unused', 'unused_amount')],
    Form: (p) => <PaymentForm side="customer" {...p} />, createPerm: 'accountant', editPerm: 'accountant', deletePerm: 'accountant',
    detail: (r, c) => [['Number', r.payment_number], ['Customer', r.customer_name], ['Date', date(r.date)], ['Amount', m(r.amount, r, c)], ['Mode', r.payment_mode], ['Reference', r.reference_number], ['Deposited to', r.account_name], ['Unused', m(r.unused_amount, r, c)], ['Applied to', ((r.invoices as ZRecord[]) ?? []).map((i) => `${i.invoice_number} (${m(i.amount_applied, r, c)})`).join(', ')], ['Notes', r.description]],
  },
  vendorpayments: {
    entity: 'vendorpayments', title: 'Payments Made', singular: 'payment', idField: 'payment_id', nameField: 'payment_number', empty: 'No payments found.',
    columns: [dcol('Date', 'date', 'date'), num('payment_number'), col('Vendor', 'vendor_name', 'vendor_name'), col('Mode', 'payment_mode'), col('Reference', 'reference_number'), col('Bills', 'bill_numbers'), mcol('Amount', 'amount', 'amount')],
    Form: (p) => <PaymentForm side="vendor" {...p} />, createPerm: 'accountant', editPerm: 'accountant', deletePerm: 'accountant',
    detail: (r, c) => [['Number', r.payment_number], ['Vendor', r.vendor_name], ['Date', date(r.date)], ['Amount', m(r.amount, r, c)], ['Mode', r.payment_mode], ['Reference', r.reference_number], ['Paid through', r.paid_through_account_name], ['Applied to', ((r.bills as ZRecord[]) ?? []).map((b) => `${b.bill_number} (${m(b.amount_applied, r, c)})`).join(', ')], ['Notes', r.description]],
  },
  creditnotes: {
    entity: 'creditnotes', title: 'Credit Notes', singular: 'credit note', idField: 'creditnote_id', nameField: 'creditnote_number', empty: 'No credit notes found.', dated: true, pdf: true,
    filters: st(['Status.All', 'All'], ['Status.Draft', 'Draft'], ['Status.Open', 'Open'], ['Status.Closed', 'Closed'], ['Status.Void', 'Void']),
    columns: [dcol('Date', 'date', 'date'), num('creditnote_number'), col('Customer', 'customer_name', 'customer_name'), col('Reference', 'reference_number'), status, mcol('Amount', 'total', 'total'), mcol('Balance', 'balance', 'balance')],
    Form: (p) => <TxnEditor spec={TXN.creditnotes} {...p} />, createPerm: 'manage', editPerm: 'manage', deletePerm: 'accountant', detail: txnDetail('customer_name', 'creditnote_number'),
  },
  vendorcredits: {
    entity: 'vendorcredits', title: 'Vendor Credits', singular: 'vendor credit', idField: 'vendor_credit_id', nameField: 'vendor_credit_number', empty: 'No vendor credits found.', dated: true,
    subtitle: 'Credits from vendors (purchase-side debit notes).',
    filters: st(['Status.All', 'All'], ['Status.Draft', 'Draft'], ['Status.Open', 'Open'], ['Status.Closed', 'Closed'], ['Status.Void', 'Void']),
    columns: [dcol('Date', 'date', 'date'), num('vendor_credit_number'), col('Vendor', 'vendor_name', 'vendor_name'), col('Reference', 'reference_number'), status, mcol('Amount', 'total', 'total'), mcol('Balance', 'balance', 'balance')],
    Form: (p) => <TxnEditor spec={TXN.vendorcredits} {...p} />, createPerm: 'manage', editPerm: 'manage', deletePerm: 'accountant', detail: txnDetail('vendor_name', 'vendor_credit_number'),
  },
  taxes: {
    entity: 'taxes', title: 'Taxes', singular: 'tax', idField: 'tax_id', nameField: 'tax_name', empty: 'No taxes configured in Zoho Books.',
    subtitle: 'Tax rates configured in the connected Zoho Books organisation.',
    columns: [col('Name', 'tax_name'), { label: 'Rate', right: true, render: (r) => `${r.tax_percentage}%` }, { label: 'Type', render: (r) => String(r.tax_type ?? '—').replace(/_/g, ' ') }, { label: 'Component', render: (r) => r.tax_specific_type ? String(r.tax_specific_type).toUpperCase() : '—' }, { label: 'Status', render: (r) => <Badge status={r.status ?? (r.is_inactive ? 'inactive' : 'active')} /> }],
    Form: TaxForm, createPerm: 'settings', editPerm: 'settings', deletePerm: 'settings',
    detail: (r) => [['Name', r.tax_name], ['Rate', `${r.tax_percentage}%`], ['Type', r.tax_type], ['Component', r.tax_specific_type], ['Authority', r.tax_authority_name], ['Default', r.is_default_tax ? 'Yes' : null]],
  },
  recurringinvoices: {
    entity: 'recurringinvoices', title: 'Recurring Invoices', singular: 'recurring invoice', idField: 'recurring_invoice_id', nameField: 'recurrence_name', empty: 'No recurring invoices found.', zohoPath: 'recurringinvoices',
    filters: st(['Status.All', 'All'], ['Status.Active', 'Active'], ['Status.Stopped', 'Stopped'], ['Status.Expired', 'Expired']),
    columns: [any('Profile name', 'recurrence_name'), col('Customer', 'customer_name', 'customer_name'), any('Frequency', 'recurrence_frequency', 'frequency'), anyD('Last invoice', 'last_sent_date'), anyD('Next invoice', 'next_invoice_date'), status, mcol('Amount', 'total')],
    deletePerm: 'accountant', detail: kv(['Profile name', 'recurrence_name'], ['Customer', 'customer_name'], ['Status', 'status', 's'], ['Frequency', ['recurrence_frequency', 'frequency']], ['Repeats every', 'repeat_every'], ['Starts', 'start_date', 'd'], ['Ends', 'end_date', 'd'], ['Last invoice', 'last_sent_date', 'd'], ['Next invoice', 'next_invoice_date', 'd'], ['Amount', 'total', 'm']),
  },
  retainerinvoices: {
    entity: 'retainerinvoices', title: 'Retainer Invoices', singular: 'retainer invoice', idField: 'retainerinvoice_id', nameField: 'retainerinvoice_number', empty: 'No retainer invoices found.', dated: true, zohoPath: 'retainerinvoices',
    filters: st(['Status.All', 'All'], ['Status.Draft', 'Draft'], ['Status.Sent', 'Sent'], ['Status.Paid', 'Paid'], ['Status.Void', 'Void']),
    columns: [dcol('Date', 'date', 'date'), num('retainerinvoice_number'), col('Customer', 'customer_name', 'customer_name'), col('Reference', 'reference_number'), status, mcol('Amount', 'total', 'total'), mcol('Balance', 'balance')],
    deletePerm: 'accountant', detail: txnDetail('customer_name', 'retainerinvoice_number'),
  },
  deliverychallans: {
    entity: 'deliverychallans', title: 'Delivery Challans', singular: 'delivery challan', idField: 'deliverychallan_id', nameField: 'deliverychallan_number', empty: 'No delivery challans found.', dated: true, zohoPath: 'deliverychallans',
    filters: st(['Status.All', 'All'], ['Status.Draft', 'Draft'], ['Status.Open', 'Open'], ['Status.Delivered', 'Delivered'], ['Status.Invoiced', 'Invoiced'], ['Status.Returned', 'Returned']),
    columns: [dcol('Date', 'date', 'date'), num('deliverychallan_number'), col('Customer', 'customer_name', 'customer_name'), any('Challan type', 'challan_type'), status, mcol('Amount', 'total', 'total')],
    deletePerm: 'accountant', detail: txnDetail('customer_name', 'deliverychallan_number'),
  },
  salesreceipts: {
    entity: 'salesreceipts', title: 'Sales Receipts', singular: 'sales receipt', idField: 'sales_receipt_id', nameField: 'sales_receipt_number', empty: 'No sales receipts found.', dated: true, zohoPath: 'salesreceipts',
    columns: [dcol('Date', 'date', 'date'), any('Number', 'sales_receipt_number', 'receipt_number'), col('Customer', 'customer_name', 'customer_name'), any('Payment mode', 'payment_mode'), status, mcol('Amount', 'total', 'total')],
    deletePerm: 'accountant', detail: kv(['Number', ['sales_receipt_number', 'receipt_number']], ['Customer', 'customer_name'], ['Date', 'date', 'd'], ['Payment mode', 'payment_mode'], ['Deposit to', 'account_name'], ['Reference', 'reference_number'], ['Amount', 'total', 'm']),
  },
  recurringexpenses: {
    entity: 'recurringexpenses', title: 'Recurring Expenses', singular: 'recurring expense', idField: 'recurring_expense_id', nameField: 'recurrence_name', empty: 'No recurring expenses found.', zohoPath: 'recurringexpenses',
    filters: st(['Status.All', 'All'], ['Status.Active', 'Active'], ['Status.Stopped', 'Stopped'], ['Status.Expired', 'Expired']),
    columns: [any('Profile name', 'recurrence_name'), any('Expense account', 'account_name'), any('Vendor', 'vendor_name'), any('Frequency', 'recurrence_frequency', 'frequency'), anyD('Next expense', 'next_expense_date'), status, mcol('Amount', 'total')],
    deletePerm: 'accountant', detail: kv(['Profile name', 'recurrence_name'], ['Expense account', 'account_name'], ['Vendor', 'vendor_name'], ['Status', 'status', 's'], ['Frequency', ['recurrence_frequency', 'frequency']], ['Starts', 'start_date', 'd'], ['Ends', 'end_date', 'd'], ['Next expense', 'next_expense_date', 'd'], ['Amount', 'total', 'm']),
  },
  recurringbills: {
    entity: 'recurringbills', title: 'Recurring Bills', singular: 'recurring bill', idField: 'recurring_bill_id', nameField: 'recurrence_name', empty: 'No recurring bills found.', zohoPath: 'recurringbills',
    filters: st(['Status.All', 'All'], ['Status.Active', 'Active'], ['Status.Stopped', 'Stopped'], ['Status.Expired', 'Expired']),
    columns: [any('Profile name', 'recurrence_name'), col('Vendor', 'vendor_name', 'vendor_name'), any('Frequency', 'recurrence_frequency', 'frequency'), anyD('Last bill', 'last_sent_date'), anyD('Next bill', 'next_bill_date'), status, mcol('Amount', 'total')],
    deletePerm: 'accountant', detail: kv(['Profile name', 'recurrence_name'], ['Vendor', 'vendor_name'], ['Status', 'status', 's'], ['Frequency', ['recurrence_frequency', 'frequency']], ['Starts', 'start_date', 'd'], ['Ends', 'end_date', 'd'], ['Next bill', 'next_bill_date', 'd'], ['Amount', 'total', 'm']),
  },
  projects: {
    entity: 'projects', title: 'Projects', singular: 'project', idField: 'project_id', nameField: 'project_name', empty: 'No projects found.', zohoPath: 'timesheet/projects',
    filters: st(['Status.All', 'All'], ['Status.Active', 'Active'], ['Status.Inactive', 'Inactive']),
    columns: [col('Project', 'project_name', 'project_name'), col('Customer', 'customer_name', 'customer_name'), any('Billing method', 'billing_type'), any('Budget', 'budget_type'), activeCol],
    deletePerm: 'accountant', detail: kv(['Project', 'project_name'], ['Customer', 'customer_name'], ['Status', 'status', 's'], ['Billing method', 'billing_type'], ['Rate', 'rate', 'm'], ['Budget', 'budget_type'], ['Budget amount', 'budget_amount', 'm'], ['Description', 'description']),
  },
  timeentries: {
    entity: 'timeentries', title: 'Timesheet', singular: 'time entry', idField: 'time_entry_id', nameField: 'log_date', empty: 'No time entries found.', zohoPath: 'timesheet/timeentries',
    columns: [anyD('Date', 'log_date'), any('Project', 'project_name'), any('Task', 'task_name'), any('User', 'user_name'), any('Time', 'log_time'), { label: 'Billable', render: (r) => (r.is_billable ? 'Yes' : 'No') }, any('Status', 'billed_status')],
    deletePerm: 'accountant', detail: kv(['Date', 'log_date', 'd'], ['Project', 'project_name'], ['Customer', 'customer_name'], ['Task', 'task_name'], ['User', 'user_name'], ['Time', 'log_time'], ['Status', 'billed_status'], ['Notes', 'notes']),
  },
  journals: {
    entity: 'journals', title: 'Manual Journals', singular: 'journal', idField: 'journal_id', nameField: 'entry_number', empty: 'No manual journals found.', dated: true, zohoPath: 'journals',
    filters: st(['JournalDate.All', 'All'], ['Status.Draft', 'Draft'], ['Status.Published', 'Published']),
    columns: [anyD('Date', 'journal_date'), any('Journal #', 'entry_number'), col('Reference', 'reference_number'), any('Notes', 'notes'), status, mcol('Amount', 'total')],
    deletePerm: 'accountant', detail: kv(['Journal #', 'entry_number'], ['Date', 'journal_date', 'd'], ['Status', 'status', 's'], ['Reference', 'reference_number'], ['Type', 'journal_type'], ['Amount', 'total', 'm'], ['Notes', 'notes']),
  },
  currencyadjustments: {
    entity: 'currencyadjustments', title: 'Currency Adjustments', singular: 'currency adjustment', idField: 'base_currency_adjustment_id', nameField: 'adjustment_date', empty: 'No currency adjustments found.', zohoPath: 'currencyadjustments',
    columns: [anyD('Date', 'adjustment_date'), any('Currency', 'currency_code'), any('Exchange rate', 'exchange_rate'), mcol('Gain / loss', 'gain_or_loss'), any('Notes', 'notes')],
    deletePerm: 'accountant', detail: kv(['Date', 'adjustment_date', 'd'], ['Currency', 'currency_code'], ['Exchange rate', 'exchange_rate'], ['Gain / loss', 'gain_or_loss', 'm'], ['Notes', 'notes']),
  },
  accounts: {
    entity: 'accounts', title: 'Chart of Accounts', singular: 'account', idField: 'account_id', nameField: 'account_name', empty: 'No accounts found.', zohoPath: 'chartofaccounts',
    filters: st(['AccountType.All', 'All'], ['AccountType.Active', 'Active'], ['AccountType.Inactive', 'Inactive'], ['AccountType.Asset', 'Assets'], ['AccountType.Liability', 'Liabilities'], ['AccountType.Equity', 'Equity'], ['AccountType.Income', 'Income'], ['AccountType.Expense', 'Expenses']),
    columns: [col('Account', 'account_name', 'account_name'), col('Code', 'account_code', 'account_code'), any('Type', 'account_type'), any('Parent', 'parent_account_name'), activeCol],
    detail: kv(['Account', 'account_name'], ['Code', 'account_code'], ['Type', 'account_type'], ['Parent', 'parent_account_name'], ['Currency', 'currency_code'], ['Status', 'is_active', 's'], ['System account', 'is_system_account'], ['Description', 'description']),
  },
  budgets: {
    entity: 'budgets', title: 'Budgets', singular: 'budget', idField: 'budget_id', nameField: 'name', empty: 'No budgets found.', zohoPath: 'budgets',
    columns: [any('Name', 'name', 'budget_name'), any('Fiscal year', 'fiscal_year'), any('Period', 'period', 'budget_period'), anyD('Start', 'start_date'), anyD('End', 'end_date')],
    deletePerm: 'accountant', detail: kv(['Name', ['name', 'budget_name']], ['Fiscal year', 'fiscal_year'], ['Period', ['period', 'budget_period']], ['Start', 'start_date', 'd'], ['End', 'end_date', 'd']),
  },
  documents: {
    entity: 'documents', title: 'Documents', singular: 'document', idField: 'document_id', nameField: 'file_name', empty: 'No documents in Zoho Books.', zohoPath: 'documents',
    columns: [any('File', 'file_name'), any('Type', 'file_type'), any('Size', 'file_size_formatted', 'file_size'), any('Uploaded by', 'uploaded_by'), anyD('Uploaded', 'uploaded_on_date', 'created_time')],
    deletePerm: 'accountant', detail: kv(['File', 'file_name'], ['Type', 'file_type'], ['Size', ['file_size_formatted', 'file_size']], ['Uploaded by', 'uploaded_by'], ['Uploaded', ['uploaded_on_date', 'created_time'], 'd']),
  },
  pricebooks: {
    entity: 'pricebooks', title: 'Price Lists', singular: 'price list', idField: 'pricebook_id', nameField: 'name', empty: 'No price lists found.', zohoPath: 'pricebooks',
    columns: [col('Name', 'name', 'name'), any('Type', 'pricebook_type'), any('Currency', 'currency_code'), any('Markup / markdown', 'percentage', 'rounding_type'), activeCol],
    deletePerm: 'accountant', detail: kv(['Name', 'name'], ['Type', 'pricebook_type'], ['Currency', 'currency_code'], ['Percentage', 'percentage'], ['Rounding', 'rounding_type'], ['Status', 'status', 's'], ['Description', 'description']),
  },
  inventoryadjustments: {
    entity: 'inventoryadjustments', title: 'Inventory Adjustments', singular: 'inventory adjustment', idField: 'inventory_adjustment_id', nameField: 'reference_number', empty: 'No inventory adjustments found.', dated: true, zohoPath: 'inventoryadjustments',
    columns: [dcol('Date', 'date', 'date'), col('Reference', 'reference_number'), any('Reason', 'reason'), any('Type', 'adjustment_type'), status],
    deletePerm: 'accountant', detail: kv(['Date', 'date', 'd'], ['Reference', 'reference_number'], ['Reason', 'reason'], ['Type', 'adjustment_type'], ['Status', 'status', 's'], ['Description', 'description']),
  },
  bankaccounts: {
    entity: 'bankaccounts', title: 'Bank accounts', singular: 'bank account', idField: 'account_id', nameField: 'account_name', empty: 'No bank accounts in Zoho Books.',
    columns: [col('Account', 'account_name'), { label: 'Type', render: (r) => String(r.account_type ?? '').replace(/_/g, ' ') }, col('Bank', 'bank_name'), col('Account #', 'account_number'), mcol('Balance', 'balance'), { label: 'Status', render: (r) => <Badge status={r.is_active === false ? 'inactive' : 'active'} /> }],
    Form: BankAccountForm, createPerm: 'accountant', editPerm: 'accountant',
    detail: (r, c) => [['Account', r.account_name], ['Type', r.account_type], ['Bank', r.bank_name], ['Account number', r.account_number], ['Balance', m(r.balance, r, c)], ['Currency', r.currency_code]],
  },
};

// ── list ──────────────────────────────────────────────────────────────────
export function EntityListPage({ resource, fixedParams, embedded = false }: { resource: Resource; fixedParams?: Record<string, string>; embedded?: boolean }) {
  const org = useOrg();
  const { can } = useBooks();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState(resource.filters?.[0]?.value ?? '');
  const [range, setRange] = useState({ from: '', to: '' });
  const [sort, setSort] = useState<{ key: string; dir: 'A' | 'D' } | undefined>(undefined);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => { const t = setTimeout(() => { setQ(search.trim()); setPage(1); }, 350); return () => clearTimeout(t); }, [search]);
  const params = {
    page, per_page: embedded ? 10 : 25, search_text: q || undefined, filter_by: filter || undefined, ...fixedParams,
    date_start: resource.dated ? range.from || undefined : undefined, date_end: resource.dated ? range.to || undefined : undefined,
    sort_column: sort?.key, sort_order: sort?.dir,
  };
  const list = useQuery({ queryKey: ['books', org.id, 'list', resource.entity, params], queryFn: () => booksApi.org(org.id).list(resource.entity, params), placeholderData: keepPreviousData });
  const cur = org.currency_code;
  const allowCreate = resource.Form && resource.createPerm && can[resource.createPerm];
  const zohoUrl = useZohoWebUrl();
  const onRow = (r: ZRecord) => (resource.detailPath && !embedded ? navigate(`${resource.detailPath}/${r[resource.idField]}`) : setOpen(String(r[resource.idField])));

  const body = (
    <Section title={embedded ? resource.title : undefined}>
      {!embedded ? (
        <div className="flex flex-wrap items-end gap-2 px-4 py-3 border-b border-border">
          <div className="w-full sm:w-64"><TextInput value={search} onChange={setSearch} placeholder={`Search ${resource.title.toLowerCase()}…`} aria-label="Search" /></div>
          {resource.filters ? <div className="w-44"><Select value={filter} onChange={(v) => { setFilter(v); setPage(1); }} options={resource.filters} /></div> : null}
          {resource.dated ? <>
            <div className="w-40"><TextInput type="date" value={range.from} onChange={(v) => { setRange({ ...range, from: v }); setPage(1); }} aria-label="From date" /></div>
            <div className="w-40"><TextInput type="date" value={range.to} onChange={(v) => { setRange({ ...range, to: v }); setPage(1); }} aria-label="To date" /></div>
          </> : null}
          {list.isFetching && !list.isLoading ? <span className="text-12 text-inkMuted pb-2">Updating…</span> : null}
        </div>
      ) : null}
      {list.isLoading ? <Skeleton rows={embedded ? 3 : 8} /> : list.isError ? <ErrorState error={errorText(list.error)} onRetry={() => list.refetch()} /> : list.data!.items.length === 0 ? <Empty title={resource.empty} /> : (
        <>
          <Table cols={resource.columns} sort={sort} onSort={(key) => { setSort((s) => (s?.key === key ? { key, dir: s.dir === 'A' ? 'D' : 'A' } : { key, dir: 'A' })); setPage(1); }} minWidth={embedded ? 560 : 820}>
            {list.data!.items.map((r) => (
              <Row key={r[resource.idField]} onClick={() => onRow(r)}>
                {resource.columns.map((c, i) => <Cell key={i} right={c.right}>{c.render(r, cur)}</Cell>)}
              </Row>
            ))}
          </Table>
          <Pager page={page} hasMore={list.data!.has_more} onPage={setPage} loading={list.isFetching} />
        </>
      )}
    </Section>
  );

  return (
    <div>
      {!embedded ? <PageHeader title={resource.title} subtitle={resource.subtitle} right={allowCreate ? <Btn variant="primary" onClick={() => setCreating(true)}><Plus size={14} />New {resource.singular}</Btn>
        : resource.zohoPath && can.manage ? <a className={zohoLinkCls} href={zohoUrl(resource.zohoPath)} target="_blank" rel="noopener noreferrer"><Plus size={14} />New {resource.singular} in Zoho Books ↗</a> : null} /> : null}
      {body}
      {open ? <DetailDrawer resource={resource} id={open} onClose={() => setOpen(null)} /> : null}
      {creating && resource.Form ? <resource.Form onClose={() => setCreating(false)} onSaved={(r) => { setCreating(false); if (r?.[resource.idField]) onRow(r); }} /> : null}
    </div>
  );
}

// ── detail ────────────────────────────────────────────────────────────────
export function DetailDrawer({ resource, id, onClose }: { resource: Resource; id: string; onClose: () => void }) {
  const org = useOrg();
  const q = useQuery({ queryKey: ['books', org.id, 'record', resource.entity, id], queryFn: () => booksApi.org(org.id).get(resource.entity, id) });
  const r = q.data;
  return (
    <Drawer title={r ? `${resource.singular[0].toUpperCase()}${resource.singular.slice(1)} ${r[resource.nameField] ?? ''}` : 'Loading…'} onClose={onClose} actions={r ? <RecordActions resource={resource} record={r} onClose={onClose} /> : null}>
      {q.isLoading ? <Skeleton rows={6} /> : q.isError ? <ErrorState error={errorText(q.error)} onRetry={() => q.refetch()} /> : r ? <RecordBody resource={resource} record={r} /> : null}
    </Drawer>
  );
}

export function RecordBody({ resource, record: r }: { resource: Resource; record: ZRecord }) {
  const org = useOrg();
  const cur = org.currency_code;
  const lines = (r.line_items as ZRecord[] | undefined) ?? [];
  return (
    <div className="space-y-5">
      <KV items={resource.detail(r, cur)} />
      {lines.length ? (
        <div className="border border-border rounded">
          <Table cols={[{ label: 'Item' }, { label: 'Qty', right: true }, { label: 'Rate', right: true }, { label: 'Discount', right: true }, { label: 'Tax' }, { label: 'Amount', right: true }]} minWidth={560}>
            {lines.map((l, i) => (
              <Row key={l.line_item_id ?? i}>
                <Cell><div className="font-medium">{l.name || l.account_name || '—'}</div>{l.description ? <div className="text-12 text-inkMuted whitespace-pre-line">{l.description}</div> : null}</Cell>
                <Cell right>{l.quantity}{l.unit ? ` ${l.unit}` : ''}</Cell>
                <Cell right>{m(l.rate, r, cur)}</Cell>
                <Cell right muted>{l.discount ? String(l.discount) : '—'}</Cell>
                <Cell muted>{l.tax_name ? `${l.tax_name}` : '—'}</Cell>
                <Cell right>{m(l.item_total, r, cur)}</Cell>
              </Row>
            ))}
          </Table>
          <div className="px-4 py-3 border-t border-border ml-auto max-w-[320px] space-y-1 text-13">
            {[['Sub-total', r.sub_total], ['Discount', r.discount_total || null], ...(((r.taxes as ZRecord[]) ?? []).map((t) => [t.tax_name, t.tax_amount])), ['Adjustment', r.adjustment || null], ['Total', r.total], ['Balance', r.balance]].filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => (
              <div key={String(k)} className={`flex justify-between ${k === 'Total' ? 'font-semibold' : ''}`}><span className="text-inkMuted">{k}</span><span className="tabular-nums">{m(v, r, cur)}</span></div>
            ))}
          </div>
        </div>
      ) : null}
      {r.notes ? <div><div className="text-11 uppercase tracking-[0.06em] text-inkMuted">Notes</div><p className="text-13 whitespace-pre-line mt-1">{r.notes}</p></div> : null}
      {r.terms ? <div><div className="text-11 uppercase tracking-[0.06em] text-inkMuted">Terms</div><p className="text-13 whitespace-pre-line mt-1">{r.terms}</p></div> : null}
      {Array.isArray(r.payments) && r.payments.length ? (
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-inkMuted mb-1">Payments</div>
          {(r.payments as ZRecord[]).map((p, i) => <div key={i} className="text-13 flex justify-between border-b border-border py-1"><span>{date(p.date)} · {p.payment_mode} {p.reference_number ? `· ${p.reference_number}` : ''}</span><span className="tabular-nums">{m(p.amount, r, cur)}</span></div>)}
        </div>
      ) : null}
    </div>
  );
}

interface Act { key: string; label: string; perm: Perm; show: boolean; danger?: boolean; confirm?: string; run: () => void }

export function RecordActions({ resource, record: r, onClose }: { resource: Resource; record: ZRecord; onClose: () => void }) {
  const org = useOrg();
  const { can } = useBooks();
  const qc = useQueryClient();
  const toast = useToast();
  const e = resource.entity;
  const id = String(r[resource.idField]);
  const [modal, setModal] = useState<ReactNode>(null);
  const [confirm, setConfirm] = useState<Act | null>(null);
  const done = () => { setModal(null); void qc.invalidateQueries({ queryKey: ['books', org.id] }); };
  const act = useMutation({
    mutationFn: (a: string) => booksApi.org(org.id).action(e, id, a),
    onSuccess: (x) => { setConfirm(null); done(); toast.push('success', x.message || 'Done.'); },
    onError: (err) => { setConfirm(null); toast.push('error', errorText(err)); },
  });
  const del = useMutation({
    mutationFn: () => booksApi.org(org.id).remove(e, id),
    onSuccess: () => { setConfirm(null); void qc.invalidateQueries({ queryKey: ['books', org.id] }); toast.push('success', `Deleted from Zoho Books.`); onClose(); },
    onError: (err) => { setConfirm(null); toast.push('error', errorText(err)); },
  });
  const status = String(r.status ?? '');
  const balance = Number(r.balance ?? 0);
  const close = () => setModal(null);
  const email = () => setModal(<ActionForm title={`Email ${resource.singular}`} entity={e} id={id} action="email" onClose={close} onDone={done}
    fields={[{ key: 'to_mail_ids', label: 'To (comma-separated)' }, { key: 'subject', label: 'Subject' }, { key: 'body', label: 'Message', type: 'textarea' }]}
    initial={{ to_mail_ids: ((r.contact_persons_details as ZRecord[]) ?? []).map((p) => p.email).filter(Boolean).join(', ') || r.email || '', subject: `${resource.singular[0].toUpperCase()}${resource.singular.slice(1)} ${r[resource.nameField] ?? ''} from ${org.name}`, body: `Dear ${r.customer_name ?? r.vendor_name ?? 'customer'},\n\nPlease find the ${resource.singular} attached.\n\nRegards,\n${org.name}` }} />);

  const status_ = (a: string, label: string, when: boolean, perm: Perm = 'manage', danger = false): Act => ({ key: a, label, perm, show: when, danger, confirm: danger ? `${label}? This is recorded in Zoho Books.` : undefined, run: () => act.mutate(a) });
  const acts: Act[] = [];
  const Form = resource.Form;
  if (Form && resource.editPerm) acts.push({ key: 'edit', label: 'Edit', perm: resource.editPerm, show: status !== 'void', run: () => setModal(<Form record={r} onClose={close} onSaved={done} />) });
  if (['recurringinvoices', 'recurringexpenses', 'recurringbills'].includes(e)) acts.push(status_('stop', 'Stop', status === 'active'), status_('resume', 'Resume', status === 'stopped'));
  if (e === 'retainerinvoices') acts.push(status_('sent', 'Mark as sent', status === 'draft'), status_('void', 'Void', !['void', 'paid'].includes(status), 'accountant', true));
  if (e === 'deliverychallans') acts.push(status_('open', 'Mark as open', status === 'draft'), status_('delivered', 'Mark as delivered', status === 'open'));
  if (e === 'journals') acts.push(status_('publish', 'Publish', status === 'draft', 'accountant'));
  if (e === 'accounts') acts.push(status_('inactive', 'Mark inactive', r.is_active !== false, 'accountant'), status_('active', 'Mark active', r.is_active === false, 'accountant'));
  if (e === 'customers' || e === 'vendors' || e === 'items' || e === 'projects' || e === 'pricebooks') {
    acts.push(status_('inactive', 'Mark inactive', status === 'active'), status_('active', 'Mark active', status === 'inactive'));
  }
  if (e === 'bankaccounts') acts.push(status_('inactive', 'Mark inactive', r.is_active !== false, 'accountant'), status_('active', 'Mark active', r.is_active === false, 'accountant'));
  if (e === 'estimates') acts.push(
    status_('sent', 'Mark as sent', status === 'draft'), status_('accepted', 'Mark accepted', ['sent', 'draft'].includes(status)), status_('declined', 'Mark declined', ['sent'].includes(status)),
    { key: 'convert', label: 'Create invoice', perm: 'manage', show: !['declined', 'invoiced'].includes(status), run: () => setModal(<TxnEditor spec={TXN.invoices} prefill={r} onClose={close} onSaved={done} />) },
  );
  if (e === 'salesorders') acts.push(status_('open', 'Mark as open', status === 'draft'),
    { key: 'convert', label: 'Create invoice', perm: 'manage', show: ['open', 'confirmed'].includes(status), run: () => setModal(<TxnEditor spec={TXN.invoices} prefill={r} onClose={close} onSaved={done} />) },
    status_('void', 'Void', status !== 'void', 'accountant', true));
  if (e === 'invoices') acts.push(status_('sent', 'Mark as sent', status === 'draft'),
    { key: 'pay', label: 'Record payment', perm: 'accountant', show: balance > 0 && !['draft', 'void'].includes(status), run: () => setModal(<PaymentForm side="customer" against={r} onClose={close} onSaved={done} />) },
    status_('draft', 'Revert to draft', status === 'sent' && balance === Number(r.total)), status_('void', 'Void', !['void', 'paid'].includes(status), 'accountant', true));
  if (e === 'purchaseorders') acts.push(status_('open', 'Mark as open', status === 'draft'),
    { key: 'convert', label: 'Create bill', perm: 'manage', show: ['open', 'issued', 'partially_billed'].includes(status), run: () => setModal(<TxnEditor spec={TXN.bills} prefill={{ ...r, reference_number: r.purchaseorder_number }} onClose={close} onSaved={done} />) },
    status_('billed', 'Mark as billed', ['open', 'issued'].includes(status)), status_('cancelled', 'Cancel', ['open', 'issued', 'draft'].includes(status), 'accountant', true));
  if (e === 'bills') acts.push(status_('open', 'Mark as open', status === 'draft'),
    { key: 'pay', label: 'Record payment', perm: 'accountant', show: balance > 0 && !['draft', 'void'].includes(status), run: () => setModal(<PaymentForm side="vendor" against={r} onClose={close} onSaved={done} />) },
    status_('void', 'Void', !['void', 'paid'].includes(status), 'accountant', true));
  if (e === 'creditnotes' || e === 'vendorcredits') acts.push(status_('open', 'Mark as open', status === 'draft'),
    { key: 'apply', label: e === 'creditnotes' ? 'Apply to invoices' : 'Apply to bills', perm: 'accountant', show: status === 'open' && balance > 0, run: () => setModal(<ApplyCreditForm entity={e} record={r} onClose={close} onDone={done} />) },
    { key: 'refund', label: 'Refund', perm: 'accountant', show: status === 'open' && balance > 0, run: () => setModal(<ActionForm title="Record refund" entity={e} id={id} action="refund" onClose={close} onDone={done}
      fields={[{ key: 'date', label: 'Date', type: 'date' }, { key: 'amount', label: 'Amount', type: 'number' }, { key: 'refund_mode', label: 'Mode' }, { key: e === 'creditnotes' ? 'from_account_id' : 'account_id', label: e === 'creditnotes' ? 'Paid from account' : 'Deposit to account', type: 'account' }, { key: 'reference_number', label: 'Reference' }, { key: 'description', label: 'Notes', type: 'textarea' }]}
      initial={{ date: new Date().toISOString().slice(0, 10), amount: balance, refund_mode: 'Bank Transfer' }} />) },
    status_('void', 'Void', status !== 'void', 'accountant', true));
  if (['estimates', 'salesorders', 'invoices', 'purchaseorders', 'creditnotes'].includes(e)) acts.push({ key: 'email', label: 'Email', perm: 'manage', show: status !== 'void' && status !== 'draft', run: email });
  if (resource.deletePerm) acts.push({ key: 'delete', label: 'Delete', perm: resource.deletePerm, show: true, danger: true, confirm: `Delete this ${resource.singular} from Zoho Books? Zoho refuses if it is referenced by other records.`, run: () => del.mutate() });

  const visible = acts.filter((a) => a.show && can[a.perm]);
  const zohoUrl = useZohoWebUrl();
  return (
    <>
      {resource.zohoPath ? <a className={zohoLinkCls} href={zohoUrl(`${resource.zohoPath}/${id}`)} target="_blank" rel="noopener noreferrer">Open in Zoho Books ↗</a> : null}
      {resource.pdf ? <a className="h-9 px-3 text-13 font-medium rounded inline-flex items-center gap-1.5 bg-surface text-ink border border-border hover:bg-canvas" href={booksApi.org(org.id).pdfUrl(e, id)} target="_blank" rel="noreferrer"><FileText size={14} />PDF</a> : null}
      {visible.map((a) => <Btn key={a.key} variant={a.danger ? 'danger' : 'secondary'} loading={(act.isPending && act.variables === a.key) || (a.key === 'delete' && del.isPending)} onClick={() => (a.confirm ? setConfirm(a) : a.run())}>{a.label}</Btn>)}
      {e === 'expenses' && can.manage ? <ReceiptUpload expenseId={id} /> : null}
      {modal}
      {confirm ? (
        <Modal title={confirm.label} onClose={() => setConfirm(null)} footer={<><Btn onClick={() => setConfirm(null)}>Cancel</Btn><Btn variant="danger" loading={act.isPending || del.isPending} onClick={confirm.run}>{confirm.label}</Btn></>}>
          <p className="text-13 text-ink">{confirm.confirm}</p>
        </Modal>
      ) : null}
    </>
  );
}

function ReceiptUpload({ expenseId }: { expenseId: string }) {
  const org = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const up = useMutation({
    mutationFn: (f: File) => booksApi.org(org.id).attachReceipt(expenseId, f),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['books', org.id, 'record', 'expenses', expenseId] }); toast.push('success', 'Receipt attached in Zoho Books.'); },
    onError: (e) => toast.push('error', errorText(e)),
  });
  return (
    <label className="h-9 px-3 text-13 font-medium rounded inline-flex items-center gap-1.5 bg-surface text-ink border border-border hover:bg-canvas cursor-pointer">
      {up.isPending ? 'Uploading…' : 'Attach receipt'}
      <input type="file" className="hidden" accept="application/pdf,image/png,image/jpeg,image/gif" onChange={(ev) => { const f = ev.target.files?.[0]; if (f) up.mutate(f); ev.target.value = ''; }} />
    </label>
  );
}
