/**
 * THE DOCUMENT ENGINE — the block model every Doc type is composed from.
 *
 * Thirteen statutory documents, one vocabulary. A document is an ordered list
 * of blocks; a template is a function that returns that list; the editor, the
 * A4 page and the server's PDF all walk the SAME list. That is what makes a
 * new document type a config file rather than a second editor.
 *
 * The prose primitives (Line, its alignment, indent and list kind, and the
 * inline-HTML rules) are the engagement letter's, imported rather than
 * re-declared: one caret behaviour, one paste behaviour, one PDF parser.
 */
import {
  DEFAULT_LAYOUT, type LayoutConfig,
} from '@/modules/workstation/quotations/document';
import {
  escapeHtml, lid, lineIsEmpty, newLine, type Align, type Line,
} from '@/modules/workstation/engagement/document';

export type { Align, Line };
export { lineIsEmpty, newLine, escapeHtml };

/**
 * The block kinds. Deliberately small: every one of the thirteen reference
 * documents is a sequence of these, and a kind that only one document would
 * ever use belongs in that document's template as data, not here as code.
 */
export type DBlockKey =
  /** A centred title, a subtitle, or a title over a rule. */
  | 'heading'
  /** The document's date line. */
  | 'date'
  /** To, / From, — an address, set tight. */
  | 'address'
  /** Sub: … */
  | 'subject'
  /** Untitled prose: one or more paragraphs, bullets or numbered clauses. */
  | 'paragraph'
  /** Titled prose — a clause group under its own heading. */
  | 'section'
  /** Label – value rows (details of the concern, particulars). */
  | 'keyvalue'
  /** Who signs, in one or two columns. */
  | 'signature'
  /** Two witnesses with Name / Address / Signature. */
  | 'witness'
  /** Date: … Place: … under a sign-off. */
  | 'placedate'
  | 'spacer'
  | 'pagebreak';

export interface KVRow { id: string; label: string; value: string }
export interface Person {
  id: string;
  name: string;
  role: string;
  din: string;
  note: string;
  /**
   * An uploaded signature, as a data URL. Stored WITH the document so the
   * page, the print and the PDF all show the same mark, and so a document
   * that was signed stays signed without depending on a file elsewhere.
   */
  sign?: string;
  /** A line to sign on, drawn between the company line and the name. */
  rule?: boolean;
}

export interface DBlock {
  id: string;
  key: DBlockKey;
  enabled: boolean;
  /** Heading text, section title, address label, subject line, place. */
  title?: string;
  align?: Align;
  /**
   * heading: 'title' | 'subtitle' | 'rule'.
   * signature: 'stacked' — Signature / Name / Date / Place, one signatory
   * under the next, as the no-objection certificates are signed.
   */
  variant?: 'title' | 'subtitle' | 'rule' | 'stacked' | 'upload' | 'named';
  /** Prose blocks (paragraph, section, address). */
  lines?: Line[];
  /** keyvalue only. */
  rows?: KVRow[];
  /** signature and witness only. */
  people?: Person[];
  /** signature only: 1 or 2 columns. */
  columns?: number;
  /** spacer only. */
  heightPx?: number;
  /** Shown in the EDITOR only, never printed. */
  hint?: string;
}

export const BLOCK_LABEL: Record<DBlockKey, string> = {
  heading: 'Heading',
  date: 'Date',
  address: 'Address',
  subject: 'Subject',
  paragraph: 'Paragraph',
  section: 'Section',
  keyvalue: 'Details',
  signature: 'Signature',
  witness: 'Witnesses',
  placedate: 'Date & place',
  spacer: 'Space',
  pagebreak: 'Page break',
};

/** The blocks that carry prose, and so are edited line by line. */
export const PROSE: ReadonlySet<DBlockKey> = new Set(['paragraph', 'section', 'address']);

/** The blocks a user may add or delete freely. The rest belong to the template. */
export const ADDABLE: DBlockKey[] = ['paragraph', 'section', 'keyvalue', 'signature', 'witness', 'spacer', 'pagebreak'];

let seq = 0;
export const bid = () => `d${Date.now().toString(36)}${(seq++).toString(36)}`;
export const rid = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`;

export const newRow = (over: Partial<KVRow> = {}): KVRow => ({ id: rid(), label: '', value: '', ...over });
export const newPerson = (over: Partial<Person> = {}): Person =>
  ({ id: rid(), name: '', role: '', din: '', note: '', ...over });

/**
 * Plain text into lines — blank lines separate paragraphs, so a template can
 * be written the way the document reads.
 */
export function linesOf(body: string, kind: Line['kind'] = 'p', align: Align = 'justify'): Line[] {
  const t = body.trim();
  if (!t) return [newLine({ align })];
  if (kind === 'p') {
    return t.split(/\n\s*\n/).map((p) =>
      newLine({ align, html: escapeHtml(p.trim()).replace(/\n/g, '<br>') }));
  }
  return t.split('\n').map((x) => x.trim()).filter(Boolean)
    .map((x) => newLine({ kind, align: 'left', html: escapeHtml(x) }));
}

/** Template sugar: one block, with its prose written as text. */
export const blk = (key: DBlockKey, extra: Partial<DBlock> = {}): DBlock =>
  ({ id: bid(), key, enabled: true, ...extra });

export const para = (body: string, align: Align = 'justify'): DBlock =>
  blk('paragraph', { lines: linesOf(body, 'p', align) });

export const clauses = (body: string, kind: Line['kind'] = 'number'): DBlock =>
  blk('paragraph', { lines: linesOf(body, kind) });

export const heading = (title: string, variant: DBlock['variant'] = 'title', align: Align = 'center'): DBlock =>
  blk('heading', { title, variant, align });

export const section = (title: string, body = '', hint?: string): DBlock =>
  blk('section', { title, lines: linesOf(body), hint });

export const space = (heightPx = 24): DBlock => blk('spacer', { heightPx });

/**
 * Bring any saved block list up to the current shape. A prose block always
 * has at least one line, so there is somewhere on the page to click and type.
 */
export function normalizeDocBlocks(blocks: DBlock[]): DBlock[] {
  return blocks.map((b) => {
    if (!PROSE.has(b.key)) return b;
    let lines = b.lines;
    if (!lines?.length) lines = [newLine({ id: lid() })];
    return { ...b, lines };
  });
}

// ── Layout ────────────────────────────────────────────────────────────────

/**
 * How a statutory document looks: plain paper, no letterhead rule and no page
 * numbers unless the template asks for them. These documents are filed with a
 * registrar, not mailed on a letterhead.
 */
export const DOC_LAYOUT: LayoutConfig = {
  ...DEFAULT_LAYOUT,
  font: 'sans',
  fontSize: 11,
  lineHeight: 'normal',
  headingSize: 'normal',
  headerStyle: 'plain',
  footerStyle: 'none',
  logoPosition: 'center',
};

// ── Company header (optional, per document) ─────────────────────────────

export type HeaderField = 'name' | 'address' | 'email' | 'phone' | 'gstin';

/**
 * An optional centred company header at the top of the document — the
 * CLIENT's letterhead (these documents are issued on the client's
 * letterhead, not the firm's). Stored in the document's own layout_config
 * (`companyHeader`), so it is per document, saved and reopened with it, and
 * absent — OFF — on every document created before it existed. Values are
 * filled from the linked client and may be edited for this one document
 * without touching the client record.
 */
export interface CompanyHeader {
  enabled: boolean;
  name: string;
  address: string;
  email: string;
  phone: string;
  gstin: string;
  show: Record<HeaderField, boolean>;
}

/** The client particulars the header is filled from (a Workstation client). */
export interface HeaderSource {
  company_name: string;
  legal_name?: string | null;
  address?: string | null;
  email?: string | null;
  contact_number?: string | null;
  gstin?: string | null;
}

/** An empty header — what a document with no linked client starts from. */
export function emptyHeader(): CompanyHeader {
  return {
    enabled: true, name: '', address: '', email: '', phone: '', gstin: '',
    show: { name: true, address: true, email: true, phone: true, gstin: true },
  };
}

/** The header filled from a client's record (legal name preferred). */
export function clientHeader(c: HeaderSource | null | undefined): CompanyHeader {
  if (!c) return emptyHeader();
  const gstin = (c.gstin ?? '').trim();
  return {
    enabled: true,
    name: (c.legal_name?.trim() || c.company_name || '').toUpperCase(),
    address: (c.address ?? '').trim(),
    email: (c.email ?? '').trim(),
    phone: (c.contact_number ?? '').trim(),
    gstin,
    show: { name: true, address: true, email: true, phone: true, gstin: Boolean(gstin) },
  };
}

/** The saved header, or null when the document has none or it is switched off. */
export function companyHeaderOf(layout: unknown): CompanyHeader | null {
  const h = (layout as { companyHeader?: Partial<CompanyHeader> } | null)?.companyHeader;
  if (!h || !h.enabled) return null;
  const base = emptyHeader();
  return { ...base, ...h, show: { ...base.show, ...(h.show ?? {}) } } as CompanyHeader;
}

/**
 * The lines the header actually prints, top to bottom. A field that is
 * switched off or empty contributes nothing — no blank line, no bare label.
 * The server's PDF (server/src/modules/docs/pdf.ts) applies the same rule.
 */
export function companyHeaderLines(h: CompanyHeader): { name: string | null; lines: string[] } {
  const on = (k: HeaderField, v: string) => h.show[k] && v.trim() ? v.trim() : '';
  const lines = [
    ...on('address', h.address).split('\n').map((l) => l.trim()).filter(Boolean),
    ...(on('email', h.email) ? [`Mail – ${h.email.trim()}`] : []),
    ...(on('phone', h.phone) ? [`Phone – ${h.phone.trim()}`] : []),
    ...(on('gstin', h.gstin) ? [`GSTIN – ${h.gstin.trim()}`] : []),
  ];
  return { name: on('name', h.name) || null, lines };
}

/** A saved layout_config back to a full layout. */
export function layoutOf(cfg: Record<string, unknown> | null | undefined): LayoutConfig {
  return { ...DOC_LAYOUT, ...((cfg ?? {}) as Partial<LayoutConfig>) };
}

export const fmtLong = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
};

/**
 * Substitute {{placeholders}} from the template's fields. An unknown or
 * still-empty name is LEFT AS TYPED, so a missing value shows up on the page
 * instead of vanishing into a sentence that silently reads wrong.
 */
export function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (vars[k] ? vars[k] : m));
}

// ── Raw templates ─────────────────────────────────────────────────────────

/** A block as a template declares it: no ids, because ids are per-document. */
export type RawLine = Partial<Omit<Line, 'html'>> & { html: string };
export type RawBlock = Omit<DBlock, 'id' | 'enabled' | 'lines' | 'rows' | 'people'> & {
  enabled?: boolean;
  lines?: RawLine[];
  rows?: Omit<KVRow, 'id'>[];
  people?: Omit<Person, 'id'>[];
};

/**
 * A template's blocks into a live document. Ids are minted here, per
 * document, so two documents of the same type never share a block id.
 */
export function hydrate(raw: RawBlock[]): DBlock[] {
  return raw.map((b): DBlock => ({
    ...b,
    lines: undefined,
    rows: undefined,
    people: undefined,
    id: bid(),
    enabled: b.enabled !== false,
    ...(b.lines ? { lines: b.lines.map((l): Line => ({ kind: 'p', align: 'justify', indent: 0, ...l, id: lid() })) } : {}),
    ...(b.rows ? { rows: b.rows.map((r) => ({ ...r, id: rid() })) } : {}),
    ...(b.people ? { people: b.people.map((p) => ({ ...p, id: rid() })) } : {}),
  }));
}
