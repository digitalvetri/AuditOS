/**
 * Indian numbering → English words for payslips.
 *   inrToWords(12500) → "Twelve thousand five hundred rupees only"
 *   Handles paise (2dp), Lakhs and Crores per Indian convention.
 */

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return TENS[t] + (o ? ' ' + ONES[o] : '');
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h) parts.push(ONES[h] + ' hundred');
  if (rest) parts.push(twoDigits(rest));
  return parts.join(' ');
}

/** Whole rupees → words (Indian grouping). */
function rupeesToWords(n: number): string {
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 10_000_000);
  n %= 10_000_000;
  const lakh = Math.floor(n / 100_000);
  n %= 100_000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  const parts: string[] = [];
  if (crore) parts.push(twoDigits(crore) + ' crore');
  if (lakh) parts.push(twoDigits(lakh) + ' lakh');
  if (thousand) parts.push(twoDigits(thousand) + ' thousand');
  if (n) parts.push(threeDigits(n));
  return parts.join(' ').trim();
}

/**
 * Format an amount in paise to a payslip-appropriate "in words" string.
 * Rounding: paise portion becomes " and NN paise" only when non-zero.
 */
export function inrToWords(paise: number): string {
  const abs = Math.abs(Math.round(paise));
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  const sign = paise < 0 ? 'Negative ' : '';
  let out = sign + rupeesToWords(rupees) + ' rupees';
  if (p > 0) out += ' and ' + twoDigits(p) + ' paise';
  out += ' only';
  return out;
}
