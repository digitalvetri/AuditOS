/**
 * LLM prompts for GST notices.
 *
 * Two prompts per notice kind:
 *   - EXTRACT: notice text → structured JSON of the facts (reference no, FY,
 *     period, section, demand amount, officer, jurisdiction). Called right
 *     after upload. The user then reviews and corrects.
 *   - DRAFT:   extracted facts + practitioner-entered grounds → the reply
 *     letter in Markdown. Called when the user clicks "Generate draft".
 *
 * DRC-07 (Summary of the Order) is the only kind fully specified today. The
 * other three — DRC-01 (SCN), ASMT-10 (scrutiny), GSTR-3A (non-filer) — reuse
 * the same extraction schema and a slimmer draft brief; dedicated templates
 * come when the first live notice of each kind lands.
 */

export const NOTICE_KINDS = ['DRC07', 'DRC01', 'ASMT10', 'GSTR3A'] as const
export type NoticeKind = (typeof NOTICE_KINDS)[number]

export interface ExtractedFields {
  reference_no: string | null
  notice_date: string | null
  section: string | null
  financial_year: string | null
  period_from: string | null
  period_to: string | null
  officer_name: string | null
  officer_designation: string | null
  jurisdiction: string | null
  total_demand: number | null
}

export interface ReplyInputs {
  grounds: string
  facts: string
  documents_in_support?: string
  prayer?: string
  taxpayer_name?: string
  taxpayer_gstin?: string
}

const EXTRACT_SCHEMA_DOC = `
Return a single JSON object with exactly these keys (use null when a value is not present):
{
  "reference_no":        string | null,  // e.g. "ZD3308262..." or notice reference
  "notice_date":         string | null,  // ISO date YYYY-MM-DD if clearly stated, else null
  "section":             string | null,  // e.g. "74", "73", "61", "46"
  "financial_year":      string | null,  // "YYYY-YYYY" e.g. "2023-2024"
  "period_from":         string | null,  // ISO date YYYY-MM-DD if present
  "period_to":           string | null,  // ISO date YYYY-MM-DD if present
  "officer_name":        string | null,
  "officer_designation": string | null,  // e.g. "Assistant Commissioner"
  "jurisdiction":        string | null,  // circle/ward/division as printed
  "total_demand":        number | null   // rupees as a plain number; sum of tax+interest+penalty if a table is given
}
`.trim()

const KIND_HINTS: Record<NoticeKind, string> = {
  DRC07:
    'This is a GST DRC-07 — "Summary of the Order" issued under section 73 or 74 of the CGST Act after an adjudication order. The total demand is a tabular sum (Tax + Interest + Penalty + Fee + Others) across one or more tax heads.',
  DRC01:
    'This is a GST DRC-01 or DRC-01A — a Show Cause Notice issued under section 73 or 74 of the CGST Act. There is no final demand yet, only a proposed demand the taxpayer must respond to.',
  ASMT10:
    'This is a GST ASMT-10 — Notice for Intimation of Discrepancies in Return After Scrutiny, issued under section 61. There may or may not be a quantified demand yet.',
  GSTR3A:
    'This is a GSTR-3A — Notice to Return Defaulter under section 46, issued to a taxpayer who has not filed a GST return by the due date. Usually no demand quantified; the ask is to file the pending return.',
}

export function extractSystem(kind: NoticeKind): string {
  return [
    'You are an Indian GST compliance assistant extracting facts from a scanned/OCRd notice.',
    KIND_HINTS[kind],
    'Return ONLY a JSON object. No prose, no code fences.',
    EXTRACT_SCHEMA_DOC,
    'Rules:',
    '- Dates: convert "27/08/2024" / "27-08-24" / "27.Aug.2024" into "2024-08-27". Leave null if unsure.',
    '- Financial year: output as "YYYY-YYYY" (e.g. "2023-2024"). "FY 23-24" means "2023-2024".',
    '- total_demand: if a table shows Tax, Interest, Penalty, Fee, Others per head, sum them for the single total. Rupees as a plain number, no commas, no symbols.',
    '- OCR noise is common — prefer null to a guessed value.',
  ].join('\n\n')
}

export function extractUser(text: string): string {
  // Keep the prompt bounded — notices are rarely more than a few pages, but
  // OCR of multi-page scans can be long. 24k chars ≈ 6k tokens.
  const trimmed = text.length > 24_000 ? text.slice(0, 24_000) + '\n[…truncated]' : text
  return `Notice text:\n\n${trimmed}`
}

const COMMON_DRAFT_RULES = `
Write the reply as a formal letter in Markdown that an Indian GST practitioner would file at the department window or upload on the portal.

Required structure:
1. Letterhead block: "To, {{officer_designation}}, {{jurisdiction}}" (use the values from the notice).
2. Subject line: "Sub: Reply to [notice kind] bearing reference no. [reference_no] dated [notice_date] — [taxpayer name], GSTIN [taxpayer_gstin] — Reg."
3. Opening paragraph that references the notice and respectfully acknowledges receipt.
4. "Facts of the case" — numbered, in the practitioner's words (use the facts input).
5. "Submissions / Grounds" — numbered, each ground as its own paragraph. Cite the specific CGST section, rule, or notification where the practitioner has named one.
6. "Prayer" — a single final paragraph beginning "In view of the above, …" asking for the specific relief named in the inputs (drop the demand, reduce it, give a hearing, etc.).
7. Signature block: "For {{taxpayer_name}}," then a blank line, then "Authorised Signatory".

Style:
- Formal, measured, no superlatives, no emojis.
- Keep paragraphs short.
- Never invent a case citation. If a user ground mentions a case, repeat it verbatim; do not add new ones.
- Never promise an outcome.
- Where a specific fact (date, amount, section) is not in the inputs or the extracted notice, write "[TO BE FILLED]" rather than guess.
`.trim()

export function draftSystem(kind: NoticeKind): string {
  const kindLine =
    kind === 'DRC07'
      ? 'This is a reply to a DRC-07 Summary of the Order under section 73/74 — frame it as a representation seeking review/appeal, not as a dispute of a show-cause.'
      : kind === 'DRC01'
        ? 'This is a reply to a DRC-01/DRC-01A Show Cause Notice — frame it as a response seeking that the proposed demand be dropped.'
        : kind === 'ASMT10'
          ? 'This is a reply to an ASMT-10 scrutiny notice under section 61 — address each discrepancy point raised, with reconciliations where applicable.'
          : 'This is a reply to a GSTR-3A notice to a return defaulter — acknowledge, state when the return will be/was filed, and explain any delay.'
  return [
    'You are an Indian GST practitioner drafting a reply to a departmental notice.',
    kindLine,
    COMMON_DRAFT_RULES,
  ].join('\n\n')
}

// ── Client-facing letter ──────────────────────────────────────────────────
//
// This is NOT the reply to the department. It is a short note the firm sends
// to its own client (the taxpayer) when a notice arrives — acknowledging
// receipt, explaining in plain English what the department is asking, and
// listing the next steps the firm proposes. Auto-drafted on upload because
// it does not depend on any client-side facts the practitioner would need
// to type in — the notice itself is enough.

const CLIENT_LETTER_RULES = `
Write a short, plain-English letter from the firm to its client (the taxpayer), as Markdown.

Required structure:
1. Greeting: "Dear {{taxpayer_name}},"
2. Opening: one sentence acknowledging the notice reference and date.
3. "What the notice says" — 2-4 bullet points in plain English:
   - which department/officer issued it
   - what period / financial year it covers
   - what the department is claiming (if a demand) or asking (if a return default)
   - the amount involved, in INR with lakh/crore formatting where helpful
4. "What this means for you" — one short paragraph in non-technical language.
5. "What we will do" — a numbered list of 2-4 proposed next steps the firm will take (file a reply, request a personal hearing, etc.) with a plain-language time commitment ("within the next 10 days").
6. "What we need from you" — a numbered list of documents/info the client should share.
7. Sign-off: "Regards," then "Your Audit OS team".

Style:
- No GST jargon unless named in bullet form with a one-line explanation.
- No scare words ("urgent", "serious"), measured and matter-of-fact.
- Never promise an outcome.
- Where a specific amount or section is not in the extracted facts, write it as "[to confirm]" rather than guess.
`.trim()

export function clientLetterSystem(kind: NoticeKind): string {
  return [
    'You are an Indian GST practitioner writing to your own client (the taxpayer) to brief them on a notice the department has issued against them.',
    KIND_HINTS[kind],
    CLIENT_LETTER_RULES,
  ].join('\n\n')
}

export function clientLetterUser(args: { extracted: ExtractedFields; taxpayer: { name?: string; gstin?: string } }): string {
  return [
    'Notice facts (extracted and reviewed):',
    JSON.stringify(args.extracted, null, 2),
    '',
    'Taxpayer:',
    JSON.stringify(args.taxpayer, null, 2),
    '',
    'Write the client-facing letter now, in Markdown.',
  ].join('\n')
}

// ── Department reply (auto first-draft) ───────────────────────────────────

export function draftUser(args: {
  extracted: ExtractedFields
  reply: ReplyInputs
  noticeText: string
}): string {
  const { extracted, reply, noticeText } = args
  const trimmedNotice = noticeText.length > 12_000 ? noticeText.slice(0, 12_000) + '\n[…truncated]' : noticeText
  return [
    'Notice facts (reviewed by the practitioner — use these as authoritative):',
    JSON.stringify(extracted, null, 2),
    '',
    'Practitioner inputs:',
    JSON.stringify(reply, null, 2),
    '',
    'Full notice text for reference (may contain OCR noise):',
    trimmedNotice,
    '',
    'Write the reply letter now, in Markdown.',
  ].join('\n')
}
