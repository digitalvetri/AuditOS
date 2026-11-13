/**
 * ETIN (E-commerce TIN) lookup for Table 14 of GSTR-1.
 *
 * The seller's MTR CSV does not carry the marketplace's own GSTIN. GSTN's
 * portal wants Table 14 keyed by the marketplace GSTIN for the seller's
 * state (so an Amazon seller in Tamil Nadu reports Amazon-TN's GSTIN). The
 * list below is public (every marketplace prints their GSTINs on invoices
 * they raise to sellers for commission/logistics).
 *
 * Extendable — if a seller files from a state not listed, lookup returns
 * null and the caller omits that supeco entry with a warning rather than
 * emitting a wrong ETIN that the portal would reject at upload.
 */

export type MarketplaceKey = 'amazon' | 'flipkart' | 'myntra' | 'meesho'

// Amazon Seller Services Private Limited — PAN AAICA3918J. The last 3 chars
// vary per state registration (entity-number, Z-checksum).
const AMAZON_ETIN_BY_STATE: Record<string, string> = {
  '33': '33AAICA3918J1C0',  // Tamil Nadu — verified from Repotic reference output
  // Add further states as they are confirmed against invoices / portal filings.
  // '07': '07AAICA3918J1CH',  // Delhi
  // '27': '27AAICA3918J1CD',  // Maharashtra
  // '29': '29AAICA3918J1CZ',  // Karnataka
}

const ETIN_BY_MARKETPLACE: Record<MarketplaceKey, Record<string, string>> = {
  amazon: AMAZON_ETIN_BY_STATE,
  flipkart: {},
  myntra: {},
  meesho: {},
}

/**
 * Return the marketplace's GSTIN that matches the seller's state, or null
 * if we do not have a verified ETIN for that combination. Null is NOT an
 * error — the Table 14 entry is simply omitted and the caller records a
 * warning so the user knows to add the ETIN before portal upload.
 */
export function lookupEtin(marketplace: MarketplaceKey, sellerStateCode: string): string | null {
  return ETIN_BY_MARKETPLACE[marketplace]?.[sellerStateCode] ?? null
}
