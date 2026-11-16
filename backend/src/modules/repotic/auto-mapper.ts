/**
 * Auto-mapper — read the headers of an uploaded file and figure out which
 * column holds what, without any firm-level configuration.
 *
 * This is what makes the Ecommerce GSTR-1 flow "just upload and it works".
 * Marketplaces label the same field in surprisingly similar ways across
 * reports ("Invoice Number" / "Invoice No" / "invoice_number", "Taxable
 * Value" / "Tax Exclusive Gross"), so a normalised-match against a short
 * list of synonyms covers Amazon MTR, Flipkart Sales, Meesho Sales and
 * most Govt. Excel templates without a stored mapping.
 *
 * The output is a column map in the same shape parser.ts already consumes
 * (`ColumnMap`), so a successful auto-map plugs straight into the same
 * code path as a saved adapter.
 *
 * Honest about ambiguity — if an obviously-required field (invoice amount,
 * taxable value) is missing, we return `null`. The upload handler then
 * refuses the file with a message naming what wasn't found, which is more
 * useful than silently zero-filling and producing a wrong GSTR-1.
 */
import type { ColumnMap } from './parser.js'

interface FieldGuess {
  key: keyof ColumnMap
  label: string
  required?: boolean
  synonyms: string[]
  /** Further columns of the same head that are ADDED to the first match
   *  (Amazon MTR: shipping and gift-wrap tax beside the item tax). */
  addSynonyms?: string[]
}

/** Normalised header synonyms per standard field. All strings here are
 *  pre-normalised (lowercase, alphanumeric only) to match the normalisation
 *  parser.ts uses when it indexes the file's header row. */
const FIELD_GUESSES: FieldGuess[] = [
  { key: 'invoice_number', label: 'invoice number', required: true,
    synonyms: ['invoicenumber', 'invoiceno', 'invno', 'invoiceid', 'orderid', 'orderno', 'ordernumber'] },
  { key: 'invoice_date', label: 'invoice date', required: true,
    synonyms: ['invoicedate', 'invdate', 'date', 'orderdate', 'orderdt'] },
  { key: 'invoice_amount', label: 'invoice amount', required: true,
    synonyms: ['invoiceamount', 'invamount', 'invoiceamt', 'invoicetotal', 'finalinvoiceamount', 'ordervalue', 'finalsaleamount', 'totalamount'] },
  { key: 'taxable_value', label: 'taxable value', required: true,
    synonyms: ['taxexclusivegross', 'taxablevalue', 'taxableamount', 'taxableval', 'netamount'] },
  { key: 'cgst_tax', label: 'CGST tax', synonyms: ['cgsttax', 'cgst', 'cgstamount'],
    addSynonyms: ['shippingcgsttax', 'giftwrapcgsttax'] },
  { key: 'sgst_tax', label: 'SGST tax', synonyms: ['sgsttax', 'sgst', 'sgstamount'],
    addSynonyms: ['shippingsgsttax', 'giftwrapsgsttax'] },
  { key: 'utgst_tax', label: 'UTGST tax', synonyms: ['utgsttax', 'utgst', 'utgstamount'],
    addSynonyms: ['shippingutgsttax', 'giftwraputgsttax'] },
  { key: 'igst_tax', label: 'IGST tax', synonyms: ['igsttax', 'igst', 'igstamount'],
    addSynonyms: ['shippingigsttax', 'giftwrapigsttax'] },
  { key: 'cess_tax', label: 'cess tax',
    synonyms: ['compensatorycesstax', 'cesstax', 'cess', 'cessamount'],
    addSynonyms: ['shippingcesstaxamount', 'shippingcesstax', 'giftwrapcompensatorycesstax', 'giftwrapcesstax'] },
  // Amazon's custom MTR spells these "… Promo Discount Tax".
  { key: 'promo_tax', label: 'promotion tax', synonyms: ['itempromotax', 'itempromodiscounttax'],
    addSynonyms: ['shippingpromotax', 'giftwrappromotax', 'shippingpromodiscounttax', 'giftwrappromodiscounttax'] },
  { key: 'cgst_rate', label: 'CGST rate', synonyms: ['cgstrate', 'cgstpct'] },
  { key: 'sgst_rate', label: 'SGST rate', synonyms: ['sgstrate', 'sgstpct'] },
  { key: 'igst_rate', label: 'IGST rate', synonyms: ['igstrate', 'igstpct'] },
  { key: 'hsn', label: 'HSN', synonyms: ['hsnsac', 'hsnsc', 'hsn', 'hsncode', 'hsnnumber'] },
  { key: 'quantity', label: 'quantity', synonyms: ['quantity', 'qty', 'noofitems', 'units'] },
  { key: 'ship_to_state', label: 'ship-to state',
    synonyms: ['shiptostate', 'shippingstate', 'customerstate', 'buyerstate', 'shiptoststate', 'placeofsupply'] },
  { key: 'seller_gstin', label: 'seller GSTIN',
    synonyms: ['sellergstin', 'gstin', 'suppliergstin', 'merchantgstin'] },
  { key: 'transaction_type', label: 'transaction type',
    synonyms: ['transactiontype', 'txntype', 'orderstatus', 'type'] },
  { key: 'credit_note_number', label: 'credit note number',
    synonyms: ['creditnoteno', 'creditnotenumber', 'cnno', 'creditnotenbr', 'returnid', 'refundid'] },
  { key: 'credit_note_date', label: 'credit note date',
    synonyms: ['creditnotedate', 'cndate', 'returndate', 'refunddate'] },
]

/**
 * Marketplace layouts, tried BEFORE the generic synonyms. A trailing `*`
 * matches by prefix: Flipkart's headers carry explanations in brackets
 * ("Taxable Value (Final Invoice Amount -Taxes)") that change wording.
 *
 * Flipkart — Seller Hub "Sales Report" (sheet "Sales Report"): the GST
 *   invoice is "Buyer Invoice ID / Date", not the Order ID; the row kind is
 *   "Event Sub Type" (Sale / Return / Cancellation / Return Cancellation).
 * Meesho — supplier panel GST report `tcs_sales` (and `tcs_sales_return`):
 *   one `tax_amount` column with no CGST/SGST/IGST split and a `gst_rate`;
 *   `eco_tcs_gstin` is Meesho's own GSTIN (the Table 14 ETIN).
 * Sources: header lists in the report (tools-fix-2-repotic-report.md);
 * neither marketplace publishes them officially, so the generic synonyms
 * stay as a fallback.
 */
const MARKETPLACE_SYNONYMS: Record<string, Partial<Record<keyof ColumnMap, string[]>>> = {
  flipkart: {
    invoice_number: ['buyerinvoiceid', 'buyerinvoiceno', 'invoiceid'],
    invoice_date: ['buyerinvoicedate', 'invoicedate'],
    invoice_amount: ['buyerinvoiceamount', 'finalinvoiceamount*'],
    taxable_value: ['taxablevalue*'],
    igst_tax: ['igstamount'],
    cgst_tax: ['cgstamount'],
    sgst_tax: ['sgstamount*'],
    cess_tax: ['luxurycessamount', 'cessamount'],
    igst_rate: ['igstrate'],
    cgst_rate: ['cgstrate'],
    sgst_rate: ['sgstrate*'],
    quantity: ['itemquantity', 'quantity'],
    ship_to_state: ['customersdeliverystate', 'customerdeliverystate', 'customersbillingstate'],
    transaction_type: ['eventsubtype', 'eventtype'],
    credit_note_number: ['creditnoteiddebitnoteid', 'creditnoteid*'],
  },
  meesho: {
    invoice_number: ['subordernum', 'subordernumber', 'ordernum', 'suborderno'],
    invoice_date: ['orderdate'],
    invoice_amount: ['totalinvoicevalue', 'invoicevalue'],
    taxable_value: ['totaltaxablesalevalue', 'tcstaxableamount', 'taxablevalue'],
    single_tax: ['taxamount'],
    single_rate: ['gstrate'],
    hsn: ['hsncode'],
    ship_to_state: ['endcustomerstatenew', 'endcustomerstate', 'resellerstate'],
    seller_gstin: ['gstin'],
    transaction_type: ['transactiontype', 'orderstatus'],
    credit_note_date: ['cancelreturndate'],
    eco_gstin: ['ecotcsgstin'],
  },
}

/** Header strings each required field is looked for under — for the error
 *  shown when a file cannot be read. */
const EXPECTED_HEADERS: Record<string, Record<string, string>> = {
  amazon: { 'invoice number': 'Invoice Number', 'invoice date': 'Invoice Date', 'invoice amount': 'Invoice Amount', 'taxable value': 'Tax Exclusive Gross' },
  flipkart: { 'invoice number': 'Buyer Invoice ID', 'invoice date': 'Buyer Invoice Date', 'invoice amount': 'Buyer Invoice Amount or Final Invoice Amount (…)', 'taxable value': 'Taxable Value (…)' },
  meesho: { 'invoice number': 'sub_order_num', 'invoice date': 'order_date', 'invoice amount': 'total_invoice_value', 'taxable value': 'total_taxable_sale_value' },
}

/** "Missing: invoice number (expected "Buyer Invoice ID"), …" */
export function missingColumnsMessage(marketplace: string, missing: string[]): string {
  const ex = EXPECTED_HEADERS[marketplace] ?? EXPECTED_HEADERS.amazon
  const list = missing.map((m) => `${m} (expected a column like "${ex[m] ?? m}")`).join('; ')
  return `This file's columns could not be read. Missing: ${list}. Check that you exported the right report from the marketplace and uploaded the sheet with the column headings.`
}

function norm(h: string): string {
  return (h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export interface AutoMapResult {
  columnMap: ColumnMap
  mappedFields: Array<keyof ColumnMap>
  missingRequired: string[]
}

const MP_ONLY: Array<{ key: keyof ColumnMap; label: string }> = [
  { key: 'single_tax', label: 'tax amount' }, { key: 'single_rate', label: 'GST rate' }, { key: 'eco_gstin', label: 'ECO GSTIN' },
]

/**
 * Try to derive a column map from the file's header row.
 *
 * Returns:
 *   - a column map populated with every field whose synonyms matched a header
 *   - the list of standard fields that got mapped
 *   - the list of REQUIRED labels (invoice number / date / amount / taxable
 *     value) that couldn't be mapped — if non-empty, caller should refuse
 *     the upload
 */
export function autoMap(headers: string[], marketplace?: string): AutoMapResult {
  const normalised: Array<[string, string]> = []
  const seen = new Set<string>()
  for (const h of headers) {
    const k = norm(h)
    if (k && !seen.has(k)) { seen.add(k); normalised.push([k, h]) }
  }
  const find = (syn: string) => syn.endsWith('*')
    ? normalised.find(([k]) => k.startsWith(syn.slice(0, -1)))?.[1]
    : normalised.find(([k]) => k === syn)?.[1]
  const profile = (marketplace && MARKETPLACE_SYNONYMS[marketplace]) || {}
  const columnMap: ColumnMap = {}
  const mappedFields: Array<keyof ColumnMap> = []
  const missingRequired: string[] = []
  const set = (key: keyof ColumnMap, v: string | string[]) => {
    ;(columnMap as Record<string, string | string[]>)[key] = v
    mappedFields.push(key)
  }

  for (const guess of FIELD_GUESSES) {
    const hit = [...(profile[guess.key] ?? []), ...guess.synonyms].map(find).find((h): h is string => Boolean(h))
    if (hit) {
      // The ColumnMap stores the ORIGINAL header string — the parser's
      // header-index lookup normalises both sides at compare time.
      const extra = (guess.addSynonyms ?? []).map(find).filter((h): h is string => Boolean(h))
      set(guess.key, extra.length ? [hit, ...extra] : hit)
    } else if (guess.required) {
      missingRequired.push(guess.label)
    }
  }
  for (const { key } of MP_ONLY) {
    const hit = (profile[key] ?? []).map(find).find((h): h is string => Boolean(h))
    if (hit) set(key, hit)
  }
  // Meesho sends returns as a separate file with the same columns plus
  // `cancel_return_date`: every row of it is a return.
  if (marketplace === 'meesho') {
    columnMap.default_tx_type = find('cancelreturndate') ? 'refund' : 'shipment'
  }
  return { columnMap, mappedFields, missingRequired }
}
