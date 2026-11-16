import { isValidGstin } from './types.js'
import type { ExtractedField } from './invoicePdf.js'

/**
 * Checks run on an extracted invoice / transit document. A value that fails
 * one is kept for the reviewer but drops to `low` confidence with a warning,
 * so nothing that is demonstrably wrong arrives labelled "high".
 */
const low = <T>(f: ExtractedField<T>): ExtractedField<T> => ({ ...f, confidence: 'low' })

/** GSTIN shape and check digit. */
export function checkGstin(f: ExtractedField<string>, label: string, warnings: string[]): ExtractedField<string> {
  if (f.value && !isValidGstin(f.value)) {
    warnings.push(`${label} ${f.value} fails the GSTIN check digit — it was probably misread.`)
    return low(f)
  }
  return f
}

/** The same GSTIN read for both parties: the second one is not trusted. */
export function checkDistinct(a: ExtractedField<string>, b: ExtractedField<string>, label: string, warnings: string[]): ExtractedField<string> {
  if (a.value && b.value && a.value === b.value) {
    warnings.push(`The ${label} GSTIN read is the same as the other party's — enter it by hand.`)
    return { value: null, confidence: 'low', source: b.source }
  }
  return b
}

/** A GST-era date that is not in the future. */
export function checkDate(f: ExtractedField<string>, label: string, warnings: string[], today = new Date().toISOString().slice(0, 10)): ExtractedField<string> {
  if (f.value && (f.value < '2017-07-01' || f.value > today)) {
    warnings.push(`The ${label} ${f.value} is ${f.value > today ? 'in the future' : 'before GST began'} — check it.`)
    return low(f)
  }
  return f
}
