import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown, ArrowUp, FileText, Minus, MoveVertical, Pencil, Plus, Printer, Redo2, Save, Trash2, Undo2,
} from 'lucide-react';
import { inputClass } from '@/modules/workstation/components';
import { workstationApi } from '@/modules/workstation/api';
import {
  SPACE_MAX_PX, SPACE_MIN_PX, SPACE_STEP_PX, clampSpace, pageGeometry,
  type CompanyInfo, type LayoutConfig,
} from '@/modules/workstation/quotations/document';
import { engagementApi, type EngagementInput, type EngagementLetter } from '@/modules/workstation/engagement/api';
import {
  BLOCK_LABEL, DEFAULT_FEES, EMPTY_RECIPIENT, ENGAGEMENT_COMPANY, ENGAGEMENT_LAYOUT, FEE_FREQUENCIES,
  PLACEHOLDERS, PROSE, bid, defaultBlocks, layoutOf, lineIsEmpty, newFee, newLine, normalizeBlocks,
  type EBlock, type FeeLine, type Line, type Recipient,
} from '@/modules/workstation/engagement/document';
import { caretOffset, serializeInline, splitAtCaret, textToInline, unitsIn } from '@/modules/workstation/engagement/richtext';
import {
  EngagementDocument, LineView, numbering, varsOf, type EditApi, type EngagementDoc, type FieldKey,
} from './EngagementDocument';
import { EngagementActions } from './EngagementActions';
import { FormatToolbar } from './FormatToolbar';
import { focusSibling, forceSync, requestFocus } from './Editable';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';

/**
 * THE ENGAGEMENT LETTER BUILDER — /workstation/engagement/new and /:id/edit.
 *
 * ONE state object (`LetterState`). The left panel and the page on the right
 * are two views of it: both read it and both write it through the same
 * operations, so there is no "left copy" and "right copy" to drift apart —
 * and the PDF is generated from what is saved from it.
 *
 * Every change goes through `update`, which also keeps an undo history.
 * Typing coalesces into one step per pause; structural edits (split, merge,
 * move, delete) are always their own step.
 */

export interface LetterState {
  partyKind: 'client' | 'lead';
  partyId: string;
  subject: string;
  letterDate: string;
  effectiveFrom: string;
  effectiveUntil: string;
  financialYear: string;
  recipient: Recipient;
  company: CompanyInfo;
  blocks: EBlock[];
  fees: FeeLine[];
  signatoryName: string;
  signatoryDesignation: string;
  clientSignatoryName: string;
  clientSignatoryDesignation: string;
  /** Page, type, header and footer — the Layout tab. */
  layout: LayoutConfig;
}

const today = () => new Date().toISOString().slice(0, 10);

const initialState = (): LetterState => ({
  partyKind: 'client',
  partyId: '',
  subject: 'Engagement letter for accounting and compliance services',
  letterDate: today(),
  effectiveFrom: '',
  effectiveUntil: '',
  financialYear: '',
  recipient: EMPTY_RECIPIENT,
  company: ENGAGEMENT_COMPANY,
  blocks: defaultBlocks(),
  fees: DEFAULT_FEES(),
  signatoryName: 'Nandhini .N',
  signatoryDesignation: 'Proprietor',
  clientSignatoryName: '',
  clientSignatoryDesignation: '',
  layout: ENGAGEMENT_LAYOUT,
});

function stateFromApi(l: EngagementLetter): LetterState {
  const rs = (l.recipient_snapshot ?? {}) as Partial<Recipient>;
  const cfg = (l.layout_config ?? {}) as { company?: Partial<CompanyInfo> };
  return {
    partyKind: l.client_id ? 'client' : 'lead',
    partyId: l.client_id ?? l.lead_id ?? '',
    subject: l.subject,
    letterDate: l.letter_date,
    effectiveFrom: l.effective_from ?? '',
    effectiveUntil: l.effective_until ?? '',
    financialYear: l.financial_year ?? '',
    recipient: { ...EMPTY_RECIPIENT, ...rs },
    company: { ...ENGAGEMENT_COMPANY, ...(cfg.company ?? {}) },
    blocks: normalizeBlocks((l.block_config as unknown as EBlock[] | null) ?? defaultBlocks()),
    fees: l.fee_items.map((f) => newFee({
      service: f.service, description: f.description ?? '', frequency: f.frequency ?? '',
      amountText: (f.amount_paise / 100).toLocaleString('en-IN'),
      billingBasis: f.billing_basis ?? '', notes: f.notes ?? '',
    })),
    signatoryName: l.signatory_name ?? '',
    signatoryDesignation: l.signatory_designation ?? '',
    clientSignatoryName: l.client_signatory_name ?? '',
    clientSignatoryDesignation: l.client_signatory_designation ?? '',
    layout: layoutOf(l.layout_config),
  };
}

/** Rupees as typed → paise. Commas and a half-typed figure never become NaN. */
const toPaise = (t: string) => {
  const n = Number(t.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

// ── One state, with history ───────────────────────────────────────────────

const COALESCE_MS = 700;
const HISTORY_MAX = 120;

function useLetterState() {
  const [state, setState] = useState<LetterState>(initialState);
  const ref = useRef(state);
  const hist = useRef({ past: [] as LetterState[], future: [] as LetterState[], last: 0 });
  const [, rerender] = useState(0);

  /**
   * The ONLY writer. `step` forces a separate undo step; otherwise edits
   * within a short pause fold into one, as typing does in any editor.
   */
  const update = useCallback((fn: (s: LetterState) => LetterState, step = false) => {
    const prev = ref.current;
    const next = fn(prev);
    if (next === prev) return;
    const h = hist.current;
    const now = Date.now();
    if (step || now - h.last > COALESCE_MS) {
      h.past.push(prev);
      if (h.past.length > HISTORY_MAX) h.past.shift();
    }
    h.future = [];
    h.last = step ? 0 : now;
    ref.current = next;
    setState(next);
  }, []);

  /** Replace wholesale — loading a saved letter; not an undoable edit. */
  const reset = useCallback((s: LetterState) => {
    hist.current = { past: [], future: [], last: 0 };
    ref.current = s;
    forceSync();
    setState(s);
  }, []);

  const travel = useCallback((dir: 'undo' | 'redo') => {
    const h = hist.current;
    const from = dir === 'undo' ? h.past : h.future;
    const to = dir === 'undo' ? h.future : h.past;
    const target = from.pop();
    if (!target) return;
    to.push(ref.current);
    h.last = 0;
    ref.current = target;
    forceSync(); // the text under the caret changes: let it be rewritten
    setState(target);
    rerender((n) => n + 1);
  }, []);

  return {
    state, ref, update, reset,
    undo: () => travel('undo'),
    redo: () => travel('redo'),
    canUndo: hist.current.past.length > 0,
    canRedo: hist.current.future.length > 0,
  };
}

// ── Pure helpers over blocks and lines ────────────────────────────────────

const mapBlock = (s: LetterState, id: string, fn: (b: EBlock) => EBlock): LetterState =>
  ({ ...s, blocks: s.blocks.map((b) => (b.id === id ? fn(b) : b)) });

const mapLines = (s: LetterState, blockId: string, fn: (ls: Line[]) => Line[]): LetterState =>
  mapBlock(s, blockId, (b) => ({ ...b, lines: fn(b.lines ?? []) }));

const swap = <T,>(arr: T[], i: number, j: number): T[] => {
  if (i < 0 || j < 0 || i >= arr.length || j >= arr.length) return arr;
  const next = [...arr];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
};

const editEl = (surface: string, id: string) =>
  document.querySelector<HTMLElement>(`[data-edit-id="${CSS.escape(`${surface}:${id}`)}"]`);

// ── The page ──────────────────────────────────────────────────────────────

const btn = 'h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50 disabled:opacity-50';
const btnPrimary = 'h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-50';
const smallBtn = 'h-7 w-7 inline-flex items-center justify-center rounded border border-neutral-300 bg-white hover:bg-neutral-50 text-neutral-500 disabled:opacity-40';

export function EngagementBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'workstation.engagement.manage', 'self');
  const [searchParams] = useSearchParams();
  const prefillClientId = searchParams.get('client_id');
  const prefilled = useRef(false);

  const existingQ = useQuery({ queryKey: ['engagement.get', id], queryFn: () => engagementApi.get(id!), enabled: isEdit });
  const clientsQ = useQuery({ queryKey: ['quotations.clients'], queryFn: () => workstationApi.listClients() });
  const leadsQ = useQuery({ queryKey: ['quotations.leads'], queryFn: () => workstationApi.listLeads() });

  const { state: s, ref: sRef, update, reset, undo, redo, canUndo, canRedo } = useLetterState();
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<'edit' | 'preview'>('edit');
  const [tab, setTab] = useState<'details' | 'layout' | 'blocks'>('details');
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Hydrate once per letter (a duplicate navigates to a new id → hydrate again).
  useEffect(() => {
    if (isEdit && existingQ.data && loadedId !== existingQ.data.id) {
      reset(stateFromApi(existingQ.data));
      setLoadedId(existingQ.data.id);
    }
  }, [isEdit, existingQ.data, loadedId, reset]);

  const set = <K extends keyof LetterState>(k: K, v: LetterState[K]) => update((x) => ({ ...x, [k]: v }));

  /** Picking a party fills the recipient the way a person would, once. */
  function chooseParty(kind: 'client' | 'lead', chosen: string) {
    update((x) => {
      const next = { ...x, partyKind: kind, partyId: chosen };
      if (kind === 'client') {
        const c = (clientsQ.data?.items ?? []).find((y) => y.id === chosen);
        if (c) {
          next.recipient = {
            ...x.recipient,
            companyName: c.company_name,
            name: x.recipient.name || c.contact_person || '',
            address: x.recipient.address || c.address || '',
            email: x.recipient.email || c.email || '',
            phone: x.recipient.phone || c.contact_number || '',
          };
        }
      } else {
        const l = (leadsQ.data?.items ?? []).find((y) => y.id === chosen);
        if (l) next.recipient = { ...x.recipient, companyName: x.recipient.companyName || l.name, email: x.recipient.email || l.email || '' };
      }
      return next;
    }, true);
  }

  useEffect(() => {
    if (id || prefilled.current || !prefillClientId || !clientsQ.data) return;
    if (!clientsQ.data.items.some((c) => c.id === prefillClientId)) return;
    prefilled.current = true;
    chooseParty('client', prefillClientId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, prefillClientId, clientsQ.data]);

  // ── The editing operations: shared by the page and the left panel ──────
  const edit: EditApi = useMemo(() => {
    const line = (blockId: string, lineId: string, patch: Partial<Line>, step = false) =>
      update((x) => mapLines(x, blockId, (ls) => ls.map((l) => (l.id === lineId ? { ...l, ...patch } : l))), step);

    return {
      field: (k: FieldKey, v: string) => update((x) => ({ ...x, [k]: v })),
      recipient: (k, v) => update((x) => ({ ...x, recipient: { ...x.recipient, [k]: v } })),
      company: (k, v) => update((x) => ({ ...x, company: { ...x.company, [k]: v } })),
      block: (bId, patch) => update((x) => mapBlock(x, bId, (b) => ({ ...b, ...patch })), 'heightPx' in patch || 'enabled' in patch),
      // Kind/alignment/indent are formatting steps; text is typing.
      line: (bId, lId, patch) => line(bId, lId, patch, !('html' in patch)),

      lineKey: (e: KeyboardEvent<HTMLElement>, el: HTMLElement, bId: string, l: Line, surface: string) => {
        const sel = window.getSelection();
        const collapsed = !sel || sel.isCollapsed;

        if (e.key === 'Tab') {
          e.preventDefault();
          line(bId, l.id, { indent: Math.max(0, Math.min(4, l.indent + (e.shiftKey ? -1 : 1))) }, true);
          return;
        }
        if (e.key === 'Enter' && e.shiftKey) {
          e.preventDefault();
          document.execCommand('insertLineBreak');
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          // Enter on an empty list item leaves the list, as in Word and Docs.
          if (l.kind !== 'p' && !serializeInline(el)) {
            line(bId, l.id, { kind: 'p', align: 'justify' }, true);
            return;
          }
          const [before, after] = splitAtCaret(el);
          const nl = newLine({ kind: l.kind, align: l.align, indent: l.indent, html: after });
          update((x) => mapLines(x, bId, (ls) => ls.flatMap((y) => (y.id === l.id ? [{ ...y, html: before }, nl] : [y]))), true);
          forceSync([l.id]);
          requestFocus(`${surface}:${nl.id}`, 0);
          return;
        }
        if (e.key === 'Backspace' && collapsed && caretOffset(el) === 0) {
          e.preventDefault();
          // Undo the paragraph's structure before merging it away.
          if (l.kind !== 'p') { line(bId, l.id, { kind: 'p', align: 'justify' }, true); return; }
          if (l.indent > 0) { line(bId, l.id, { indent: l.indent - 1 }, true); return; }
          const lines = sRef.current.blocks.find((b) => b.id === bId)?.lines ?? [];
          const i = lines.findIndex((y) => y.id === l.id);
          if (i <= 0) { focusSibling(el, -1); return; }
          const prev = lines[i - 1];
          const prevEl = editEl(surface, prev.id);
          const at = prevEl ? unitsIn(prevEl) : Number.MAX_SAFE_INTEGER;
          const cur = serializeInline(el);
          update((x) => mapLines(x, bId, (ls) => ls
            .filter((y) => y.id !== l.id)
            .map((y) => (y.id === prev.id ? { ...y, html: y.html + cur } : y))), true);
          forceSync([prev.id]);
          requestFocus(`${surface}:${prev.id}`, at);
          return;
        }
        if (e.key === 'Delete' && collapsed && caretOffset(el) === unitsIn(el)) {
          const lines = sRef.current.blocks.find((b) => b.id === bId)?.lines ?? [];
          const i = lines.findIndex((y) => y.id === l.id);
          const next = lines[i + 1];
          if (!next) return;
          e.preventDefault();
          const at = unitsIn(el);
          const cur = serializeInline(el);
          update((x) => mapLines(x, bId, (ls) => ls
            .filter((y) => y.id !== next.id)
            .map((y) => (y.id === l.id ? { ...y, html: cur + next.html } : y))), true);
          forceSync([l.id]);
          requestFocus(`${surface}:${l.id}`, at);
        }
      },

      pasteLines: (text, el, bId, lId, surface) => {
        const chunks = text.replace(/\r/g, '').split('\n');
        const [before, after] = splitAtCaret(el);
        const l = sRef.current.blocks.find((b) => b.id === bId)?.lines?.find((y) => y.id === lId);
        if (!l) return;
        const made = chunks.slice(1).map((c, i, arr) => newLine({
          kind: l.kind, align: l.align, indent: l.indent,
          html: textToInline(c) + (i === arr.length - 1 ? after : ''),
        }));
        update((x) => mapLines(x, bId, (ls) => ls.flatMap((y) => (y.id === lId
          ? [{ ...y, html: before + textToInline(chunks[0]) }, ...made]
          : [y]))), true);
        forceSync([lId]);
        const last = made[made.length - 1];
        if (last) requestFocus(`${surface}:${last.id}`, chunks[chunks.length - 1].length);
      },

      moveBlock: (bId, by) => update((x) => {
        const i = x.blocks.findIndex((b) => b.id === bId);
        return { ...x, blocks: swap(x.blocks, i, i + by) };
      }, true),
      removeBlock: (bId) => update((x) => ({ ...x, blocks: x.blocks.filter((b) => b.id !== bId) }), true),
      addBlockAfter: (bId, kind, surface) => {
        const nb: EBlock = kind === 'spacer'
          ? { id: bid(), key: 'spacer', enabled: true, heightPx: 24 }
          : { id: bid(), key: 'section', enabled: true, title: '', lines: [newLine()] };
        update((x) => {
          const i = x.blocks.findIndex((b) => b.id === bId);
          return { ...x, blocks: [...x.blocks.slice(0, i + 1), nb, ...x.blocks.slice(i + 1)] };
        }, true);
        if (kind === 'section') requestFocus(`${surface}:title:${nb.id}`, 0);
      },

      fee: (key, patch) => update((x) => ({ ...x, fees: x.fees.map((f) => (f.key === key ? { ...f, ...patch } : f)) })),
      feeOp: (key, op) => update((x) => {
        const i = x.fees.findIndex((f) => f.key === key);
        if (op === 'up') return { ...x, fees: swap(x.fees, i, i - 1) };
        if (op === 'down') return { ...x, fees: swap(x.fees, i, i + 1) };
        if (op === 'dup') return { ...x, fees: [...x.fees.slice(0, i + 1), newFee({ ...x.fees[i] }), ...x.fees.slice(i + 1)] };
        return { ...x, fees: x.fees.filter((f) => f.key !== key) };
      }, true),
      addFee: (surface) => {
        const nf = newFee();
        update((x) => ({ ...x, fees: [...x.fees, nf] }), true);
        requestFocus(`${surface}:fee:${nf.key}:service`, 0);
      },
    };
  }, [update, sRef]);

  // Undo / redo: Ctrl/Cmd+Z and Shift+Z (or Ctrl+Y) anywhere in the document
  // editors. Plain form inputs keep the browser's own per-field undo.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (t && t !== document.body && !rootRef.current?.contains(t)) return;
      e.preventDefault();
      if (k === 'y' || e.shiftKey) redo(); else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const doc: EngagementDoc = useMemo(() => ({
    letterDate: s.letterDate, subject: s.subject, financialYear: s.financialYear,
    effectiveFrom: s.effectiveFrom, effectiveUntil: s.effectiveUntil,
    company: s.company, recipient: s.recipient, blocks: s.blocks,
    fees: s.fees.map((f) => ({
      key: f.key, service: f.service, description: f.description, frequency: f.frequency,
      amountPaise: toPaise(f.amountText), amountText: f.amountText, billingBasis: f.billingBasis, notes: f.notes,
    })),
    signatoryName: s.signatoryName, signatoryDesignation: s.signatoryDesignation,
    clientSignatoryName: s.clientSignatoryName, clientSignatoryDesignation: s.clientSignatoryDesignation,
    layout: s.layout,
  }), [s]);

  const input = (): EngagementInput => ({
    client_id: s.partyKind === 'client' ? s.partyId || null : null,
    lead_id: s.partyKind === 'lead' ? s.partyId || null : null,
    subject: s.subject,
    letter_date: s.letterDate,
    effective_from: s.effectiveFrom || null,
    effective_until: s.effectiveUntil || null,
    financial_year: s.financialYear || null,
    recipient_snapshot: s.recipient as unknown as Record<string, unknown>,
    template_id: 'jns-accounting',
    // Empty paragraphs are editing scaffolding, not content.
    block_config: s.blocks.map((b) => (PROSE.has(b.key)
      ? { ...b, lines: (b.lines ?? []).filter((l) => !lineIsEmpty(l)) }
      : b)) as unknown as Record<string, unknown>[],
    layout_config: { ...s.layout, company: s.company },
    signatory_name: s.signatoryName || null,
    signatory_designation: s.signatoryDesignation || null,
    client_signatory_name: s.clientSignatoryName || null,
    client_signatory_designation: s.clientSignatoryDesignation || null,
    fee_items: s.fees.filter((f) => f.service.trim()).map((f) => ({
      service: f.service, description: f.description || null, frequency: f.frequency || null,
      amount_paise: toPaise(f.amountText), billing_basis: f.billingBasis || null, notes: f.notes || null,
    })),
  });

  const save = useMutation({
    mutationFn: () => (isEdit ? engagementApi.update(id!, input()) : engagementApi.create(input())),
    onSuccess: (l) => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['engagement.list'] });
      queryClient.setQueryData(['engagement.get', l.id], l);
      // Saving does not reload the editor: what is on screen IS what was saved.
      setLoadedId(l.id);
      if (!isEdit) navigate(`/workstation/engagement/${l.id}/edit`, { replace: true });
    },
    onError: (e) => setError((e as { message?: string })?.message ?? 'That could not be saved.'),
  });

  /** Sent → draft, then reload the letter into the editor unlocked. */
  const reopen = useMutation({
    mutationFn: () => engagementApi.reopen(id!),
    onSuccess: (l) => {
      setError(null);
      queryClient.setQueryData(['engagement.get', l.id], l);
      queryClient.invalidateQueries({ queryKey: ['engagement.list'] });
      reset(stateFromApi(l));
    },
    onError: (e) => setError((e as { message?: string })?.message ?? 'The letter could not be reopened.'),
  });

  function submit() {
    if (!s.partyId) { setError('Choose the client or lead this letter is for.'); return; }
    if (!s.subject.trim()) { setError('Give the letter a subject.'); return; }
    save.mutate();
  }

  function printDocument() {
    document.documentElement.classList.add('qdoc-printing');
    const done = () => {
      document.documentElement.classList.remove('qdoc-printing');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
  }

  const status = existingQ.data?.status ?? 'draft';
  const frozen = isEdit && existingQ.data ? !existingQ.data.is_editable : false;
  const liveEdit = frozen ? undefined : edit;
  const vars = varsOf(doc);

  return (
    <div className="qb-root" ref={rootRef}>
      <header className="flex items-start gap-3 flex-wrap mb-4 qdoc-screen-only">
        <div className="min-w-0">
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Workstation · Engagement</div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-0.5">Engagement Letter Builder</h1>
          <p className="text-13 text-neutral-500 mt-1">
            {isEdit ? existingQ.data?.letter_code ?? '' : 'The reference number is allocated when you save.'}
            {isEdit ? <> · <span className="capitalize">{status}</span></> : null}
          </p>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={undo} disabled={!canUndo || frozen} className={btn} title="Undo (Ctrl+Z)"><Undo2 size={14} /></button>
          <button type="button" onClick={redo} disabled={!canRedo || frozen} className={btn} title="Redo (Ctrl+Shift+Z)"><Redo2 size={14} /></button>
          {isEdit ? (
            <Link to={`/workstation/engagement/${id}/preview`} className={btn}><FileText size={14} /> Preview</Link>
          ) : null}
          <button type="button" onClick={printDocument} className={btn}><Printer size={14} /> Print</button>
          {isEdit && existingQ.data ? (
            <EngagementActions
              letter={existingQ.data}
              canManage={canManage}
              onError={setError}
              onChanged={(l) => { if (l.id !== existingQ.data?.id) setLoadedId(null); else reset(stateFromApi(l)); }}
            />
          ) : null}
          <button type="button" onClick={submit} disabled={save.isPending || frozen} className={btnPrimary}
            title={frozen ? 'A sent letter is frozen — duplicate it to change the terms' : undefined}>
            <Save size={14} /> {save.isPending ? 'Saving…' : isEdit ? 'Update letter' : 'Save draft'}
          </button>
        </div>
      </header>

      <div className="md:hidden flex gap-2 mb-3 qdoc-screen-only">
        {(['edit', 'preview'] as const).map((v) => (
          <button key={v} type="button" onClick={() => setMobileView(v)}
            className={`h-8 px-4 text-13 rounded border ${mobileView === v ? 'bg-neutral-900 text-white border-neutral-900' : 'bg-white border-neutral-300'}`}>
            {v === 'edit' ? 'Edit' : 'Document'}
          </button>
        ))}
      </div>

      {error ? <div className="border-l-2 border-red pl-3 text-13 mb-3 qdoc-screen-only">{error}</div> : null}
      {frozen ? (
        <div className="flex items-center gap-3 flex-wrap border border-amber-300 bg-amber-50 rounded px-3 py-2 text-13 mb-3 text-neutral-800 qdoc-screen-only">
          <span className="flex-1 min-w-0">
            <strong>This letter is {status}, so it is locked</strong> — neither side can be edited.{' '}
            {status === 'sent'
              ? 'Reopen it to make changes, then send it again.'
              : 'Accepted terms are final; use Actions → Duplicate letter to prepare new ones.'}
          </span>
          {status === 'sent' && canManage ? (
            <button type="button" className={btnPrimary} disabled={reopen.isPending} onClick={() => reopen.mutate()}>
              <Pencil size={14} /> {reopen.isPending ? 'Reopening…' : 'Reopen for editing'}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
        {/* ── LEFT: structured editing ─────────────────────────────────── */}
        <div data-edit-surface="left"
          className={`el-editing qdoc-screen-only space-y-3 md:max-h-[calc(100dvh-190px)] md:overflow-auto md:pr-1 ${mobileView === 'preview' ? 'hidden md:block' : ''}`}>
          {/* The quotation's three tabs: what the letter SAYS, how it LOOKS,
              and which parts it HAS. */}
          <nav className="flex gap-x-4 border-b border-neutral-200 mb-3">
            {(['details', 'layout', 'blocks'] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)}
                className={'h-8 flex items-center text-13 uppercase tracking-[0.06em] border-b-2 -mb-px '
                  + (tab === t ? 'border-gold text-neutral-900 font-medium' : 'border-transparent text-neutral-500 hover:text-neutral-900')}>
                {t}
              </button>
            ))}
          </nav>
          <fieldset disabled={frozen} className="space-y-3 min-w-0">
            {tab === 'layout' ? <LayoutTab layout={s.layout} setLayout={(patch) => update((x) => ({ ...x, layout: { ...x.layout, ...patch } }), true)} /> : null}
            {tab === 'blocks' ? <BlocksTab s={s} edit={edit} update={update} /> : null}
            {tab === 'details' ? (<>
            {/* Who it is for, and what it is about — the two things every letter needs. */}
            <section className="bg-white border border-neutral-200 rounded p-3 space-y-2">
              <div className="grid grid-cols-[110px_1fr] gap-2">
                <select value={s.partyKind} aria-label="Recipient type"
                  onChange={(e) => update((x) => ({ ...x, partyKind: e.target.value as 'client' | 'lead', partyId: '' }), true)}
                  className={inputClass}>
                  <option value="client">Client</option>
                  <option value="lead">Lead</option>
                </select>
                <select value={s.partyId} aria-label={s.partyKind === 'client' ? 'Client' : 'Lead'}
                  onChange={(e) => chooseParty(s.partyKind, e.target.value)} className={inputClass}>
                  <option value="">{s.partyKind === 'client' ? 'Choose a client…' : 'Choose a lead…'}</option>
                  {s.partyKind === 'client'
                    ? (clientsQ.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.company_name}</option>)
                    : (leadsQ.data?.items ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
              <input value={s.subject} onChange={(e) => set('subject', e.target.value)} placeholder="Subject" aria-label="Subject" className={inputClass} />
            </section>

            {/* The words of the letter, in order — nothing else. */}
            <section className="bg-white border border-neutral-200 rounded p-3">
              <SimpleText s={s} edit={edit} update={update} vars={vars} />
            </section>

            {/* Everything that is set once and rarely touched, folded away. */}
            <details className="bg-white border border-neutral-200 rounded group/details">
              <summary className="px-3 py-2.5 cursor-pointer select-none text-13 text-neutral-700 hover:bg-neutral-50">
                <span className="font-medium">Details</span>
                <span className="text-neutral-500"> — dates, recipient address, letterhead, signature</span>
              </summary>
              <DetailsPanel s={s} edit={edit} set={set} vars={vars} letterCode={existingQ.data?.letter_code} />
            </details>
            </>) : null}
          </fieldset>
        </div>

        {/* ── RIGHT: the letter itself, editable in place ──────────────── */}
        <div className={mobileView === 'edit' ? 'hidden md:block' : ''}>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2 qdoc-screen-only">
            {frozen ? 'Document (read-only)' : 'Document — click any text to edit it'}
          </div>
          <DocumentPane doc={doc} edit={liveEdit} />
        </div>
      </div>

      {liveEdit ? (
        <FormatToolbar
          getLine={(bId, lId) => s.blocks.find((b) => b.id === bId)?.lines?.find((l) => l.id === lId)}
          setLine={(bId, lId, patch) => liveEdit.line(bId, lId, patch)}
        />
      ) : null}
    </div>
  );
}

/** The paper, scaled to the pane's width. */
function DocumentPane({ doc, edit }: { doc: EngagementDoc; edit?: EditApi }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const pageWidth = pageGeometry(doc.layout).widthPx;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setScale(Math.min(1, (el.clientWidth - 8) / pageWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pageWidth]);

  return (
    <div ref={ref} className="qb-preview">
      <EngagementDocument doc={doc} scale={scale} edit={edit} />
    </div>
  );
}

// ── Left panel: the block list ────────────────────────────────────────────

const REMOVABLE = new Set(['paragraph', 'section', 'spacer']);
/** The blocks that hold the letter's words — the only ones listed on the left. */
const TEXT_KEYS = new Set(['salutation', 'paragraph', 'section', 'fees', 'closing', 'spacer']);

const hoverBtn = 'h-6 w-6 inline-flex items-center justify-center rounded text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 disabled:opacity-30';

/**
 * The letter's words, in print order, as plain text boxes — the simple view.
 *
 * Only blocks that carry text are listed; the letterhead, date, recipient
 * address and signature live under Details. Move and delete appear on hover
 * so the list reads as the letter, not as a form.
 */
function SimpleText({ s, edit, update, vars }: {
  s: LetterState;
  edit: EditApi;
  update: (fn: (s: LetterState) => LetterState, step?: boolean) => void;
  vars: Record<string, string>;
}) {
  const shown = s.blocks.filter((b) => b.enabled && TEXT_KEYS.has(b.key));
  const append = (b: EBlock) => update((x) => {
    const at = x.blocks.findIndex((y) => y.key === 'closing' || y.key === 'signature');
    return { ...x, blocks: at < 0 ? [...x.blocks, b] : [...x.blocks.slice(0, at), b, ...x.blocks.slice(at)] };
  }, true);

  return (
    <div className="space-y-3 pl-7">
      {shown.map((b, i) => (
        <div key={b.id} className="group/blk relative">
          {/* Controls live in a margin to the LEFT of the text, shown on
              hover — never on top of the words, where a click meant for the
              end of a line could land on Delete. */}
          <div className="absolute -left-7 top-0 flex flex-col gap-0.5 opacity-0 group-hover/blk:opacity-100 focus-within:opacity-100 transition-opacity">
            <button type="button" className={hoverBtn} title="Move up" disabled={i === 0} onClick={() => edit.moveBlock(b.id, -1)}><ArrowUp size={13} /></button>
            <button type="button" className={hoverBtn} title="Move down" disabled={i === shown.length - 1} onClick={() => edit.moveBlock(b.id, 1)}><ArrowDown size={13} /></button>
            {REMOVABLE.has(b.key) ? (
              <button type="button" className={hoverBtn} title="Delete" onClick={() => edit.removeBlock(b.id)}><Trash2 size={13} /></button>
            ) : null}
          </div>
          <SimpleBlock b={b} s={s} edit={edit} vars={vars} />
        </div>
      ))}

      <div className="flex flex-wrap gap-2 pt-1">
        <button type="button" className={btn}
          onClick={() => append({ id: bid(), key: 'paragraph', enabled: true, lines: [newLine()] })}>
          <Plus size={14} /> Add paragraph
        </button>
        <button type="button" className={btn}
          onClick={() => { const nb: EBlock = { id: bid(), key: 'section', enabled: true, title: '', lines: [newLine()] }; append(nb); requestFocus(`left:title:${nb.id}`, 0); }}>
          <Plus size={14} /> Add section
        </button>
        <button type="button" className={btn}
          onClick={() => append({ id: bid(), key: 'spacer', enabled: true, heightPx: 24 })}>
          <Plus size={14} /> Add space
        </button>
      </div>
    </div>
  );
}

const plainInput = 'w-full bg-transparent border-0 border-b border-transparent hover:border-neutral-300 focus:border-neutral-500 focus:outline-none px-0 py-0.5';

function SimpleBlock({ b, s, edit, vars }: { b: EBlock; s: LetterState; edit: EditApi; vars: Record<string, string> }) {
  switch (b.key) {
    case 'salutation':
      return (
        <input value={b.body ?? ''} onChange={(e) => edit.block(b.id, { body: e.target.value })}
          placeholder="Dear Sir," aria-label="Greeting" className={`${plainInput} text-13`} />
      );
    case 'paragraph':
    case 'closing':
      return <LeftLines b={b} edit={edit} vars={vars} />;
    case 'section':
      return (
        <div>
          <input value={b.title ?? ''} onChange={(e) => edit.block(b.id, { title: e.target.value })}
            placeholder="Heading" aria-label="Section heading" data-edit-id={`left:title:${b.id}`}
            className={`${plainInput} text-13 font-semibold`} />
          <LeftLines b={b} edit={edit} vars={vars} />
        </div>
      );
    case 'fees':
      return (
        <div>
          <input value={b.title ?? ''} onChange={(e) => edit.block(b.id, { title: e.target.value })}
            placeholder="Fees:" aria-label="Fees heading" className={`${plainInput} text-13 font-semibold`} />
          <SimpleFees fees={s.fees} edit={edit} />
          <LeftLines b={b} edit={edit} vars={vars} />
        </div>
      );
    case 'spacer':
      return (
        <div className="flex items-center gap-2 text-11 text-neutral-400">
          <span className="flex-1 border-t border-dashed border-neutral-300" />
          <span className="inline-flex items-center gap-1"><MoveVertical size={12} /> space</span>
          <SpaceHeight value={b.heightPx ?? 24} onChange={(px) => edit.block(b.id, { heightPx: px })} />
          <span className="flex-1 border-t border-dashed border-neutral-300" />
        </div>
      );
    default:
      return null;
  }
}

/** One row per fee: what, how much, how often. The rest is one click away. */
function SimpleFees({ fees, edit }: { fees: FeeLine[]; edit: EditApi }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="mt-1.5 space-y-1">
      <datalist id="el-frequencies">{FEE_FREQUENCIES.map((f) => <option key={f} value={f} />)}</datalist>
      {fees.map((f, i) => (
        <div key={f.key} className="group/fee">
          <div className="grid grid-cols-[1fr_90px_110px_auto] gap-1.5 items-center">
            <input value={f.service} onChange={(e) => edit.fee(f.key, { service: e.target.value })} placeholder="Service" aria-label="Service" className={inputClass} />
            <input value={f.amountText} onChange={(e) => edit.fee(f.key, { amountText: e.target.value })} placeholder="₹ Amount" aria-label="Amount" inputMode="decimal" className={inputClass} />
            <input value={f.frequency} onChange={(e) => edit.fee(f.key, { frequency: e.target.value })} list="el-frequencies" placeholder="per month" aria-label="Frequency" className={inputClass} />
            <span className="flex gap-0.5 opacity-0 group-hover/fee:opacity-100 focus-within:opacity-100">
              <button type="button" className={hoverBtn} title="More (description, basis, notes)" onClick={() => setOpen(open === f.key ? null : f.key)}>⋯</button>
              <button type="button" className={hoverBtn} title="Move up" disabled={i === 0} onClick={() => edit.feeOp(f.key, 'up')}><ArrowUp size={12} /></button>
              <button type="button" className={hoverBtn} title="Delete fee" onClick={() => edit.feeOp(f.key, 'del')}><Trash2 size={12} /></button>
            </span>
          </div>
          {open === f.key ? (
            <div className="grid grid-cols-3 gap-1.5 mt-1 mb-2">
              <input value={f.description} onChange={(e) => edit.fee(f.key, { description: e.target.value })} placeholder="Description" className={inputClass} />
              <input value={f.billingBasis} onChange={(e) => edit.fee(f.key, { billingBasis: e.target.value })} placeholder="Billing basis" className={inputClass} />
              <input value={f.notes} onChange={(e) => edit.fee(f.key, { notes: e.target.value })} placeholder="Notes" className={inputClass} />
            </div>
          ) : null}
        </div>
      ))}
      <button type="button" className="text-12 text-primary hover:underline" onClick={() => edit.addFee('left')}>+ Add fee</button>
    </div>
  );
}

/** Set-once details, grouped plainly. Everything the simple view leaves out. */
function DetailsPanel({ s, edit, set, vars, letterCode }: {
  s: LetterState;
  edit: EditApi;
  set: <K extends keyof LetterState>(k: K, v: LetterState[K]) => void;
  vars: Record<string, string>;
  letterCode?: string;
}) {
  const H = ({ children }: { children: ReactNode }) => (
    <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1.5">{children}</div>
  );
  const lbl = (key: string, dflt: string) => {
    const b = s.blocks.find((x) => x.key === key);
    return b ? (
      <CardField label={`"${dflt}" label`}>
        <input value={b.body ?? ''} onChange={(e) => edit.block(b.id, { body: e.target.value })} placeholder={dflt} className={inputClass} />
      </CardField>
    ) : null;
  };
  return (
    <div className="px-3 pb-3 space-y-4">
      <div>
        <H>Letter</H>
        <div className="grid grid-cols-2 gap-2">
          <CardField label="Reference">
            <input value={letterCode ?? 'Allocated on save'} readOnly title="Numbered by the system so every reference is unique"
              className={`${inputClass} bg-neutral-50 text-neutral-500`} />
          </CardField>
          <CardField label="Date"><input type="date" value={s.letterDate} onChange={(e) => set('letterDate', e.target.value)} className={inputClass} /></CardField>
          <CardField label="Effective from"><input type="date" value={s.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} className={inputClass} /></CardField>
          <CardField label="Effective until"><input type="date" value={s.effectiveUntil} onChange={(e) => set('effectiveUntil', e.target.value)} className={inputClass} /></CardField>
          <CardField label="Financial year"><input value={s.financialYear} onChange={(e) => set('financialYear', e.target.value)} placeholder="2024-25" className={inputClass} /></CardField>
        </div>
      </div>

      <div>
        <H>Recipient</H>
        <div className="grid grid-cols-2 gap-2">
          {([
            ['name', 'Contact person'], ['designation', 'Designation'], ['companyName', 'Company name'], ['email', 'Email'],
            ['phone', 'Phone'], ['city', 'City'], ['state', 'State'], ['pincode', 'PIN code'],
          ] as [keyof Recipient, string][]).map(([k, l]) => (
            <CardField key={k} label={l}><input value={s.recipient[k]} onChange={(e) => edit.recipient(k, e.target.value)} className={inputClass} /></CardField>
          ))}
          <CardField label="Address" wide>
            <textarea rows={2} value={s.recipient.address} onChange={(e) => edit.recipient('address', e.target.value)} className={`${inputClass} h-auto py-1.5`} />
          </CardField>
          {lbl('recipient', 'To')}
          {lbl('subject', 'Sub:')}
        </div>
      </div>

      <div>
        <H>Letterhead</H>
        <div className="grid grid-cols-2 gap-2">
          {([
            ['name', 'Firm name'], ['phone', 'Phone'], ['addressLine1', 'Address line 1'], ['addressLine2', 'Address line 2'],
            ['city', 'City'], ['state', 'State'], ['pin', 'PIN'], ['email', 'Email'],
          ] as [keyof CompanyInfo, string][]).map(([k, l]) => (
            <CardField key={k} label={l}><input value={s.company[k]} onChange={(e) => edit.company(k, e.target.value)} className={inputClass} /></CardField>
          ))}
        </div>
      </div>

      <div>
        <H>Signature and client confirmation</H>
        <div className="grid grid-cols-2 gap-2">
          {lbl('signature', 'Yours truly,')}
          <CardField label="Signatory"><input value={s.signatoryName} onChange={(e) => set('signatoryName', e.target.value)} className={inputClass} /></CardField>
          <CardField label="Signatory designation"><input value={s.signatoryDesignation} onChange={(e) => set('signatoryDesignation', e.target.value)} className={inputClass} /></CardField>
          {(() => {
            const b = s.blocks.find((x) => x.key === 'confirmation');
            return b ? (
              <CardField label="Confirmation text" wide>
                <input value={b.body ?? ''} onChange={(e) => edit.block(b.id, { body: e.target.value })}
                  placeholder="The above terms and conditions are agreed and confirmed by;" className={inputClass} />
              </CardField>
            ) : null;
          })()}
          <CardField label="Client signatory"><input value={s.clientSignatoryName} onChange={(e) => set('clientSignatoryName', e.target.value)} placeholder={s.recipient.name || 'Contact person'} className={inputClass} /></CardField>
          <CardField label="Client designation"><input value={s.clientSignatoryDesignation} onChange={(e) => set('clientSignatoryDesignation', e.target.value)} placeholder={s.recipient.designation || 'Designation'} className={inputClass} /></CardField>
        </div>
      </div>

      <div>
        <H>Insert a field into the text</H>
        <PlaceholderChips vars={vars} />
      </div>

    </div>
  );
}

/** How the letter looks — the quotation's Layout tab, for a letter. */
function LayoutTab({ layout, setLayout }: { layout: LayoutConfig; setLayout: (patch: Partial<LayoutConfig>) => void }) {
  const pick = <K extends keyof LayoutConfig>(label: string, k: K, options: [LayoutConfig[K], string][]) => (
    <CardField label={label}>
      <select value={String(layout[k])} className={inputClass}
        onChange={(e) => setLayout({ [k]: (typeof layout[k] === 'number' ? Number(e.target.value) : e.target.value) } as Partial<LayoutConfig>)}>
        {options.map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>)}
      </select>
    </CardField>
  );
  const box = 'bg-white border border-neutral-200 rounded p-3';
  const head = (t: string) => <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">{t}</div>;
  return (
    <div className="space-y-3">
      <section className={box}>
        {head('Page')}
        <div className="grid grid-cols-2 gap-2">
          {pick('Page size', 'pageSize', [['A4', 'A4'], ['Letter', 'Letter']])}
          {pick('Orientation', 'orientation', [['portrait', 'Portrait'], ['landscape', 'Landscape']])}
          {pick('Margins', 'margin', [['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide']])}
          {pick('Letterhead position', 'logoPosition', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']])}
        </div>
      </section>
      <section className={box}>
        {head('Type')}
        <div className="grid grid-cols-2 gap-2">
          {pick('Font', 'font', [['sans', 'Sans (Arial)'], ['serif', 'Serif (Times)']])}
          <CardField label="Font size (pt)">
            <input type="number" step="0.5" min="8" max="14" value={layout.fontSize} className={inputClass}
              onChange={(e) => setLayout({ fontSize: Math.min(14, Math.max(8, Number(e.target.value) || 10.5)) })} />
          </CardField>
          {pick('Heading size', 'headingSize', [['compact', 'Compact'], ['normal', 'Normal'], ['large', 'Large']])}
          {pick('Line spacing', 'lineHeight', [['tight', 'Tight'], ['normal', 'Normal'], ['relaxed', 'Relaxed']])}
        </div>
      </section>
      <section className={box}>
        {head('Style')}
        <div className="grid grid-cols-2 gap-2">
          {pick('Line under letterhead', 'headerStyle', [['rule', 'Thin line'], ['bar', 'Thick bar'], ['plain', 'None']])}
          {pick('Footer', 'footerStyle', [['page-numbers', 'Page numbers'], ['company', 'Firm name'], ['none', 'None']])}
        </div>
      </section>
      <p className="text-11 text-neutral-500">Applies to the page, Print and the PDF alike.</p>
    </div>
  );
}

/** Which parts the letter has, and in what order — the quotation's Blocks tab. */
function BlocksTab({ s, edit, update }: {
  s: LetterState;
  edit: EditApi;
  update: (fn: (s: LetterState) => LetterState, step?: boolean) => void;
}) {
  const append = (b: EBlock) => update((x) => {
    const at = x.blocks.findIndex((y) => y.key === 'closing' || y.key === 'signature');
    return { ...x, blocks: at < 0 ? [...x.blocks, b] : [...x.blocks.slice(0, at), b, ...x.blocks.slice(at)] };
  }, true);
  return (
    <section className="bg-white border border-neutral-200 rounded p-3">
      <p className="text-11 text-neutral-500 mb-2">Untick to leave a part out; the arrows change where it sits on the page.</p>
      <ul className="space-y-1">
        {s.blocks.map((b, i) => (
          <li key={b.id} className={`flex items-center gap-2 border rounded px-2 py-1.5 ${b.enabled ? 'border-neutral-200' : 'border-dashed border-neutral-300 bg-neutral-50'}`}>
            <input type="checkbox" className="h-4 w-4" checked={b.enabled} title={b.enabled ? 'Shown on the letter' : 'Left out of the letter'}
              onChange={(e) => edit.block(b.id, { enabled: e.target.checked })} />
            <span className="flex-1 min-w-0 truncate text-13">
              {b.key === 'spacer'
                ? <span className="inline-flex items-center gap-1 text-neutral-500"><MoveVertical size={13} /> Space</span>
                : b.key === 'section' ? (b.title?.trim() || 'Section') : BLOCK_LABEL[b.key]}
            </span>
            {b.key === 'spacer' ? <SpaceHeight value={b.heightPx ?? 24} onChange={(px) => edit.block(b.id, { heightPx: px })} /> : null}
            <button type="button" className={smallBtn} title="Move up" disabled={i === 0} onClick={() => edit.moveBlock(b.id, -1)}><ArrowUp size={13} /></button>
            <button type="button" className={smallBtn} title="Move down" disabled={i === s.blocks.length - 1} onClick={() => edit.moveBlock(b.id, 1)}><ArrowDown size={13} /></button>
            {b.key !== 'spacer' ? (
              <button type="button" className={smallBtn} title="Add space below" onClick={() => edit.addBlockAfter(b.id, 'spacer', 'left')}><MoveVertical size={13} /></button>
            ) : null}
            {REMOVABLE.has(b.key) ? (
              <button type="button" className={smallBtn} title="Delete" onClick={() => edit.removeBlock(b.id)}><Trash2 size={13} /></button>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2 mt-3">
        <button type="button" className={btn} onClick={() => append({ id: bid(), key: 'section', enabled: true, title: '', lines: [newLine()] })}><Plus size={14} /> Add section</button>
        <button type="button" className={btn} onClick={() => append({ id: bid(), key: 'paragraph', enabled: true, lines: [newLine()] })}><Plus size={14} /> Add paragraph</button>
        <button type="button" className={btn} onClick={() => append({ id: bid(), key: 'spacer', enabled: true, heightPx: 24 })}><Plus size={14} /> Add space</button>
      </div>
    </section>
  );
}

function CardField({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`block ${wide ? 'col-span-2' : ''}`}>
      <span className="block text-11 text-neutral-500 mb-0.5">{label}</span>
      {children}
    </label>
  );
}

/** The same lines the page shows, edited in a form-shaped box. */
function LeftLines({ b, edit, vars }: { b: EBlock; edit: EditApi; vars: Record<string, string> }) {
  const lines = b.lines ?? [];
  const nums = numbering(lines);
  return (
    <div className="mt-2 border border-neutral-300 rounded px-2.5 py-2 bg-white text-13 leading-relaxed focus-within:border-neutral-500">
      {lines.map((l, i) => (
        <LineView key={l.id} b={b} l={l} n={nums.get(l.id) ?? 0} vars={vars} edit={edit} live surface="left"
          placeholder={i === 0 ? (b.hint ?? 'Type here…') : undefined} />
      ))}
    </div>
  );
}

/**
 * Placeholder buttons: click one while typing in a paragraph and it drops in
 * at the caret, filled with the current value. Mouse-down is swallowed so the
 * paragraph keeps its caret while the button is pressed.
 */
function PlaceholderChips({ vars }: { vars: Record<string, string> }) {
  const [hint, setHint] = useState<string | null>(null);
  const insert = (token: string) => {
    const a = document.activeElement as HTMLElement | null;
    if (a?.dataset.rich !== '1') { setHint('Click into a paragraph first, then choose a placeholder.'); return; }
    setHint(null);
    const k = token.replace(/[{}]/g, '');
    const v = vars[k];
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    document.execCommand('insertHTML', false,
      `<span data-ph="${k}" contenteditable="false" class="el-ph${v ? '' : ' el-ph-missing'}">${esc(v || token)}</span>&nbsp;`);
  };
  return (
    <div className="mb-3">
      <div className="flex flex-wrap gap-1">
        {PLACEHOLDERS.map((p) => (
          <button key={p.token} type="button" title={`Insert ${p.label} at the cursor`}
            onMouseDown={(e) => e.preventDefault()} onClick={() => insert(p.token)}
            className="text-11 px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-700 hover:bg-neutral-200 font-mono">
            {p.token}
          </button>
        ))}
      </div>
      {hint ? <p className="text-11 text-amber-700 mt-1">{hint}</p> : null}
    </div>
  );
}

function SpaceHeight({ value, onChange }: { value: number; onChange: (px: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (raw: string) => {
    const n = Number(raw);
    onChange(raw.trim() && Number.isFinite(n) ? clampSpace(n) : value);
    setDraft(null);
  };
  return (
    <span className="inline-flex items-center gap-1 mr-1">
      <button type="button" className={smallBtn} disabled={value <= SPACE_MIN_PX} title="Decrease height"
        onClick={() => onChange(clampSpace(value - SPACE_STEP_PX))}><Minus size={13} /></button>
      <input value={draft ?? String(Math.round(value))}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
        inputMode="numeric" aria-label={`Space height in pixels (${SPACE_MIN_PX}–${SPACE_MAX_PX})`}
        className="h-7 w-11 px-1 text-12 text-center border border-neutral-300 rounded bg-white" />
      <span className="text-11 text-neutral-400">px</span>
      <button type="button" className={smallBtn} disabled={value >= SPACE_MAX_PX} title="Increase height"
        onClick={() => onChange(clampSpace(value + SPACE_STEP_PX))}><Plus size={13} /></button>
    </span>
  );
}
