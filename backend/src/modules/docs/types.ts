/**
 * The document TYPES the Doc module offers.
 *
 * The full template — blocks, fields, actions — lives on the client, in
 * src/modules/workstation/docs/registry.ts: it is composition, and the server
 * stores composition verbatim. What the server keeps is this list, because a
 * `docType` decides what a row IS and must not be a free string from a
 * browser. The two lists must name the same thirteen ids.
 */
export const DOC_TYPES = [
  'appointment-letter',
  'consent-letter',
  'non-disqualification',
  'director-resignation',
  'board-resolution-appointment',
  'board-resolution-resignation',
  'board-resolution-authorised-signatory',
  'shareholders-resolution',
  'authorised-signatory-declaration',
  'noc-gst',
  'noc-incorporation',
  'llp-agreement',
  'partnership-agreement',
  'authorised-signatory-pvt-ltd',
  'lease-deed',
  'epf-letter',
] as const

export type DocType = (typeof DOC_TYPES)[number]

export const isDocType = (v: unknown): v is DocType =>
  typeof v === 'string' && (DOC_TYPES as readonly string[]).includes(v)
