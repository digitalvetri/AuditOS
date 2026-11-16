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

function norm(h: string): string {
  return (h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export interface AutoMapResult {
  columnMap: ColumnMap
  mappedFields: Array<keyof ColumnMap>
  missingRequired: string[]
}

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
export function autoMap(headers: string[]): AutoMapResult {
  const normalisedHeaders = new Map<string, string>()
  for (const h of headers) {
    const k = norm(h)
    if (k && !normalisedHeaders.has(k)) normalisedHeaders.set(k, h)
  }
  const columnMap: ColumnMap = {}
  const mappedFields: Array<keyof ColumnMap> = []
  const missingRequired: string[] = []

  for (const guess of FIELD_GUESSES) {
    const hit = guess.synonyms
      .map((s) => normalisedHeaders.get(s))
      .find((h): h is string => Boolean(h))
    if (hit) {
      // The ColumnMap stores the ORIGINAL header string — the parser's
      // header-index lookup normalises both sides at compare time.
      const extra = (guess.addSynonyms ?? []).map((s) => normalisedHeaders.get(s)).filter((h): h is string => Boolean(h))
      ;(columnMap as Record<string, string | string[]>)[guess.key] = extra.length ? [hit, ...extra] : hit
      mappedFields.push(guess.key)
    } else if (guess.required) {
      missingRequired.push(guess.label)
    }
  }
  return { columnMap, mappedFields, missingRequired }
}
