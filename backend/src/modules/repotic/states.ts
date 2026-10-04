/**
 * Indian state → GSTIN state code map.
 *
 * The GSTIN's first two digits are the state code; GSTR-1's `pos` field also
 * uses this code. Marketplaces write state names loosely ("TAMIL NADU",
 * "Tamil Nadu", "TN"), so this map normalises on an uppercased, trimmed form.
 *
 * REPOTIC-MODULE.md §3 — PoS (Place of Supply) is what decides whether a
 * sale is interstate; getting the mapping wrong flips a sale between Table
 * 5A/7 (intra) and the IGST bucket, which the GST portal rejects. One source
 * of truth here.
 */

const RAW: Array<[string, string, string[]]> = [
  // [code, canonical, aliases]
  ['01', 'JAMMU AND KASHMIR', ['JK', 'J&K', 'JAMMU & KASHMIR']],
  ['02', 'HIMACHAL PRADESH', ['HP']],
  ['03', 'PUNJAB', []],
  ['04', 'CHANDIGARH', ['CH']],
  ['05', 'UTTARAKHAND', ['UK', 'UTTARANCHAL']],
  ['06', 'HARYANA', ['HR']],
  ['07', 'DELHI', ['DL', 'NCT OF DELHI']],
  ['08', 'RAJASTHAN', ['RJ']],
  ['09', 'UTTAR PRADESH', ['UP']],
  ['10', 'BIHAR', ['BR']],
  ['11', 'SIKKIM', ['SK']],
  ['12', 'ARUNACHAL PRADESH', ['AR']],
  ['13', 'NAGALAND', ['NL']],
  ['14', 'MANIPUR', ['MN']],
  ['15', 'MIZORAM', ['MZ']],
  ['16', 'TRIPURA', ['TR']],
  ['17', 'MEGHALAYA', ['ML']],
  ['18', 'ASSAM', ['AS']],
  ['19', 'WEST BENGAL', ['WB']],
  ['20', 'JHARKHAND', ['JH']],
  ['21', 'ODISHA', ['OD', 'ORISSA']],
  ['22', 'CHHATTISGARH', ['CT', 'CG']],
  ['23', 'MADHYA PRADESH', ['MP']],
  ['24', 'GUJARAT', ['GJ']],
  ['25', 'DAMAN AND DIU', ['DD', 'DAMAN & DIU']],
  ['26', 'DADRA AND NAGAR HAVELI AND DAMAN AND DIU', ['DN', 'DADRA & NAGAR HAVELI']],
  ['27', 'MAHARASHTRA', ['MH']],
  ['28', 'ANDHRA PRADESH', ['AP']],
  ['29', 'KARNATAKA', ['KA']],
  ['30', 'GOA', ['GA']],
  ['31', 'LAKSHADWEEP', ['LD']],
  ['32', 'KERALA', ['KL']],
  ['33', 'TAMIL NADU', ['TN', 'TAMILNADU']],
  ['34', 'PUDUCHERRY', ['PY', 'PONDICHERRY']],
  ['35', 'ANDAMAN AND NICOBAR ISLANDS', ['AN']],
  ['36', 'TELANGANA', ['TG', 'TS']],
  ['37', 'ANDHRA PRADESH (NEW)', []],
  ['38', 'LADAKH', ['LA']],
  ['97', 'OTHER TERRITORY', []],
]

const BY_NAME = new Map<string, string>()
for (const [code, canonical, aliases] of RAW) {
  BY_NAME.set(canonical, code)
  for (const alias of aliases) BY_NAME.set(alias, code)
}

/** 'Tamil Nadu' / ' tamil  nadu ' / 'TN' → '33'. Returns null if unknown. */
export function stateNameToCode(name: string | null | undefined): string | null {
  if (!name) return null
  const key = name.trim().toUpperCase().replace(/\s+/g, ' ')
  return BY_NAME.get(key) ?? null
}

/** First two digits of a GSTIN (state code). Returns null if invalid. */
export function gstinStateCode(gstin: string | null | undefined): string | null {
  if (!gstin || gstin.length < 2) return null
  const code = gstin.slice(0, 2)
  return /^\d{2}$/.test(code) ? code : null
}
