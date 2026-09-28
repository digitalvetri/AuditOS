/**
 * Form No. 140 (formerly 26Q) — the quarterly non-salary TDS statement for
 * Tax Year 2026-27 onwards, under the Income-tax Act, 2025.
 *
 * Source: Protean "File Format for Non-Salary TDS File - Form Number 140
 * (26Q) - Q1 to Q4 (Version 1.1) for Tax Year 2026-27 and onwards",
 * published 22-07-2026 (tinpan.proteantech.in › e-TDS › Regular). Field
 * numbers in comments below are that document's "Sr. No.". Validate the
 * output with FVU 1.2 — the FVU for TY 2025-26 and earlier (9.x) reads the
 * old 26Q layout and rejects this one.
 */

/** Annexure 2 — section codes accepted in DD field 15. */
export const SECTION_CODES: Record<string, string> = {
  '1004': 'Accumulated balance due to an employee — 392(7)',
  '1005': 'Commission or brokerage (insurance) — 393(1) Sl. 1(i)',
  '1006': 'Commission or brokerage (others) — 393(1) Sl. 1(ii)',
  '1008': 'Rent on machinery etc. — 393(1) Sl. 2(ii).D(a)',
  '1009': 'Rent other than machinery — 393(1) Sl. 2(ii).D(b)',
  '1011': 'Consideration under agreement in section 67(14) — 393(1) Sl. 3(ii)',
  '1012': 'Compensation on acquisition of immovable property — 393(1) Sl. 3(iii)',
  '1013': 'Income on units of mutual funds etc. — 393(1) Sl. 4(i)',
  '1014': 'Interest from units of a business trust — 393(1) Sl. 4(ii)',
  '1015': 'Dividend from units of a business trust — 393(1) Sl. 4(ii)',
  '1016': 'Rent from units of a REIT — 393(1) Sl. 4(ii)',
  '1017': 'Income from units of an investment fund — 393(1) Sl. 4(iii)',
  '1018': 'Income from a securitisation trust — 393(1) Sl. 4(iv)',
  '1019': 'Interest on securities — 393(1) Sl. 5(i)',
  '1020': 'Interest other than on securities, senior citizen — 393(1) Sl. 5(ii).D(a)',
  '1021': 'Interest other than on securities, not senior citizen — 393(1) Sl. 5(ii).D(b)',
  '1022': 'Interest other than interest on securities — 393(1) Sl. 5(iii)',
  '1023': 'Contract work, contractor individual/HUF — 393(1) Sl. 6(i).D(a)',
  '1024': 'Contract work, contractor other than individual/HUF — 393(1) Sl. 6(i).D(b)',
  '1026': 'Fees for technical services / call centre — 393(1) Sl. 6(iii).D(a)',
  '1027': 'Fees for professional services — 393(1) Sl. 6(iii).D(b)',
  '1028': 'Director remuneration / fees / commission — 393(1) Sl. 6(iii).D(b)',
  '1029': 'Dividends — 393(1) Sl. 7',
  '1030': 'Life insurance policy payout — 393(1) Sl. 8(i)',
  '1031': 'Purchase of goods — 393(1) Sl. 8(ii)',
  '1033': 'Business benefit or perquisite — 393(1) Sl. 8(iv)',
  '1034': 'Business benefit or perquisite in kind — 393(1) Sl. 8(iv) Note 6',
  '1035': 'E-commerce participant — 393(1) Sl. 8(v)',
  '1037': 'Transfer of a virtual digital asset — 393(1) Sl. 8(vi)',
  '1038': 'Transfer of a virtual digital asset, in kind — 393(1) Sl. 8(vi) Note 6',
  '1058': 'Winnings (lottery, crossword etc.) — 393(3) Sl. 1',
  '1059': 'Winnings in kind — 393(3) Sl. 1 Note 2',
  '1060': 'Winnings from online games — 393(3) Sl. 2',
  '1061': 'Winnings from online games in kind — 393(3) Sl. 2 Note 2',
  '1062': 'Winnings from horse races — 393(3) Sl. 3',
  '1063': 'Commission on lottery tickets — 393(3) Sl. 4',
  '1064': 'Cash withdrawal, co-operative society — 393(3) Sl. 5.D(a)',
  '1065': 'Cash withdrawal, others — 393(3) Sl. 5.D(b)',
  '1066': 'Amount under section 80CCA(2)(a) of the 1961 Act — 393(3) Sl. 6',
  '1067': 'Partner salary, remuneration, commission, bonus or interest — 393(3) Sl. 7',
}

/**
 * Sections where the benefit is in kind and tax is 0.00 (DD fields 24, 25
 * and 28 must be zero, and no default PAN is allowed).
 */
export const IN_KIND_SECTIONS = new Set(['1034', '1038', '1059', '1061'])

/** Cash-withdrawal sections need DD fields 22/23, which the sheet doesn't carry. */
export const UNSUPPORTED_SECTIONS = new Set(['1064', '1065'])

/**
 * Old Income-tax Act, 1961 section → Form 140 code, where the mapping is
 * one-to-one. Sections that split under the new Act (194C, 194J, 194-I) are
 * resolved by `resolveSection` from the deductee PAN or the rate instead.
 */
const OLD_SECTION: Record<string, string> = {
  '192A': '1004', '193': '1019', '194': '1029', '194A': '1022',
  '194B': '1058', '194BA': '1060', '194BB': '1062', '194D': '1005',
  '194DA': '1030', '194G': '1063', '194H': '1006', '194IC': '1011',
  '194K': '1013', '194LA': '1012', '194LBB': '1017', '194LBC': '1018',
  '194O': '1035', '194Q': '1031', '194R': '1033', '194S': '1037',
  '194T': '1067', '194JA': '1026', '194JB': '1027',
}

/**
 * The Form 140 section code for what the sheet says, or why it can't be
 * decided. Takes the 4-digit code (1027) as-is; maps old sections (194H,
 * 194C, 194J…) where the sheet gives enough to decide. New-Act section text
 * like "393(1)" isn't taken — several codes share one sub-section.
 */
export function resolveSection(raw: string, pan: string, rate: number | null): { code: string } | { problem: string } {
  const s = raw.toUpperCase().replace(/[\s\-_.()]/g, '')
  if (!s) return { problem: 'no section code' }
  if (/^10\d\d$/.test(s)) {
    return SECTION_CODES[s] ? { code: s } : { problem: `"${raw}" is not a Form 140 section code` }
  }
  const old = s.replace(/^SEC(TION)?/, '')
  // 194C splits on who the contractor is; the PAN's 4th letter says so.
  if (old === '194C') {
    const kind = pan[3]
    if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) return { problem: '194C needs a valid PAN to tell 1023 (individual/HUF) from 1024 — or write the code' }
    return { code: kind === 'P' || kind === 'H' ? '1023' : '1024' }
  }
  // 194J splits into technical (2%) and professional (10%) fees.
  if (old === '194J') {
    if (rate === 2) return { code: '1026' }
    if (rate === 10) return { code: '1027' }
    return { problem: '194J is 1026 (technical, 2%) or 1027 (professional, 10%) — write the code' }
  }
  // 194-I splits into machinery (2%) and land/building (10%).
  if (old === '194I') {
    if (rate === 2) return { code: '1008' }
    if (rate === 10) return { code: '1009' }
    return { problem: '194-I is 1008 (machinery, 2%) or 1009 (land/building, 10%) — write the code' }
  }
  if (old === '194IA' || old === '194IB' || old === '194M') {
    return { problem: `${raw} is reported on its own challan-cum-statement, not in Form 140` }
  }
  const code = OLD_SECTION[old]
  if (code) return { code }
  return { problem: `section "${raw}" has no Form 140 equivalent here — write the 4-digit code from Annexure 2` }
}

/** Annexure 1 — state codes. Keys are normalised names. */
export const STATE_CODES: Record<string, string> = {
  'ANDAMAN AND NICOBAR ISLANDS': '01', 'ANDHRA PRADESH': '02', 'ARUNACHAL PRADESH': '03',
  'ASSAM': '04', 'BIHAR': '05', 'CHANDIGARH': '06',
  'DADRA & NAGAR HAVELI AND DAMAN & DIU': '07', 'DELHI': '09', 'GOA': '10',
  'GUJARAT': '11', 'HARYANA': '12', 'HIMACHAL PRADESH': '13', 'JAMMU & KASHMIR': '14',
  'KARNATAKA': '15', 'KERALA': '16', 'LAKSHWADEEP': '17', 'MADHYA PRADESH': '18',
  'MAHARASHTRA': '19', 'MANIPUR': '20', 'MEGHALAYA': '21', 'MIZORAM': '22',
  'NAGALAND': '23', 'ODISHA': '24', 'PONDICHERRY': '25', 'PUNJAB': '26',
  'RAJASTHAN': '27', 'SIKKIM': '28', 'TAMIL NADU': '29', 'TRIPURA': '30',
  'UTTAR PRADESH': '31', 'WEST BENGAL': '32', 'CHHATTISGARH': '33',
  'UTTARAKHAND': '34', 'JHARKHAND': '35', 'TELANGANA': '36', 'LADAKH': '37',
}
export const STATE_CODE_VALUES = new Set(Object.values(STATE_CODES))

/**
 * Annexure 4 — deductor categories. Government categories (A, S, D, E, G,
 * H, L, N) also need ministry / AIN / book-entry details this tool doesn't
 * collect, so only these are offered.
 */
export const DEDUCTOR_TYPES: Record<string, string> = {
  K: 'Company', M: 'Branch / Division of Company', F: 'Firm',
  Q: 'Individual/HUF', P: 'Association of Person (AOP)', T: 'Association of Person (Trust)',
  B: 'Body of Individuals', J: 'Artificial Juridical Person',
}

/** Remark codes (DD field 32) from Annexure 6. */
export const REMARK_CODES = new Set(['A', 'B', 'C', 'D', 'E', 'N', 'O', 'P', 'Q', 'S', 'T', 'Y', 'Z'])

/** Default PAN values the spec allows in place of a PAN. */
export const DEFAULT_PANS = new Set(['PANAPPLIED', 'PANINVALID', 'PANNOTAVBL'])

/** First and last day of a quarter of a tax year, as Date (UTC). */
export function quarterRange(startYear: number, quarter: string): { from: Date; to: Date } {
  const q = Number(quarter.slice(1))
  // Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec of startYear; Q4 Jan–Mar of startYear + 1.
  const [y, m] = q === 4 ? [startYear + 1, 0] : [startYear, 3 + (q - 1) * 3]
  return { from: new Date(Date.UTC(y, m, 1)), to: new Date(Date.UTC(y, m + 3, 0)) }
}

/** "dd/mm/yyyy" (the parser's output) → Date (UTC). */
export function dmyToDate(dmy: string): Date {
  const [d, m, y] = dmy.split('/').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/** "dd/mm/yyyy" → "ddmmyyyy", the only date form the file accepts. */
export const ddmmyyyy = (dmy: string) => dmy.replace(/\//g, '')

/** Amounts are always written with two decimals, whole-rupee fields as "1000.00". */
export const amt = (n: number) => n.toFixed(2)

/**
 * Free text for a CHAR field: ASCII only, no "^" (the delimiter), no line
 * breaks, collapsed spaces, cut to the field's size.
 */
export function text(v: string, size: number): string {
  return v
    .normalize('NFKD').replace(/[^\x20-\x7E]/g, '')
    .replace(/\^/g, ' ').replace(/\s+/g, ' ').trim()
    .slice(0, size).trim()
}

/** A record: line number and fields joined by "^", checked for its field count. */
export function record(fields: (string | number)[], expected: number): string {
  if (fields.length !== expected) {
    throw new Error(`Form 140 ${fields[1]} record built with ${fields.length} fields, spec says ${expected}`)
  }
  return fields.join('^')
}

/** Field counts per record type (spec v1.1). */
export const FIELD_COUNT = { FH: 18, BH: 72, CD: 30, DD: 45 } as const
