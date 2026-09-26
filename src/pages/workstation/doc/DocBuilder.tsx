import {
  useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent,
} from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown, ArrowUp, Copy, Download, FileText, Lock, Pencil, Plus, Printer,
  Redo2, Save, Trash2, Undo2,
} from 'lucide-react';
import { inputClass } from '@/modules/workstation/components';
import { workstationApi } from '@/modules/workstation/api';
import { pageGeometry, type LayoutConfig } from '@/modules/workstation/quotations/document';
import { clientHeader, type CompanyHeader, type HeaderField, type HeaderSource } from '@/modules/workstation/docs/model';
import {
  caretOffset, serializeInline, splitAtCaret, textToInline, unitsIn,
} from '@/modules/workstation/engagement/richtext';
import { focusSibling, forceSync, requestFocus } from '@/pages/workstation/engagement/Editable';
import { FormatToolbar } from '@/pages/workstation/engagement/FormatToolbar';
import {
  BLOCK_LABEL, PROSE, bid, fmtLong, layoutOf, lineIsEmpty, newLine, newPerson, newRow,
  normalizeDocBlocks, rid, type DBlock, type KVRow, type Line, type Person,
} from '@/modules/workstation/docs/model';
import { docType, layoutFor, type DocAction, type DocTypeConfig } from '@/modules/workstation/docs/registry';
import { docsApi, type DocInput, type WorkstationDoc } from '@/modules/workstation/docs/api';
import { DocDocument, type DocEditApi, type DocModel } from './DocDocument';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';

/**
 * THE DOCUMENT BUILDER — /workstation/doc/:typeId/new and /workstation/doc/:id/edit.
 *
 * ONE state object. The controls on the left and the A4 page on the right are
 * two views of it: both read it, both write it through the same operations,
 * so there is no "editor copy" and "preview copy" to drift apart — and the
 * PDF is generated from exactly what is saved from it.
 *
 * Every change goes through `update`, which keeps an undo history. Typing
 * coalesces into one step per pause; structural edits are their own step.
 */

export interface DocState {
  typeId: string;
  title: string;
  docDate: string;
  partyKind: 'client' | 'lead' | 'none';
  partyId: string;
  /** The type's declared fields, by placeholder name. */
  fields: Record<string, string>;
  blocks: DBlock[];
  layout: LayoutConfig;
}

const COALESCE_MS = 700;
const HISTORY_MAX: number = 80;
const today = () => new Date().toISOString().slice(0, 10);

function initialState(t: DocTypeConfig): DocState {
  return {
    typeId: t.id,
    title: t.name,
    docDate: today(),
    partyKind: 'none',
    partyId: '',
    fields: Object.fromEntries(t.fields.map((f) => [f.key, ''])),
    blocks: t.blocks(),
    layout: layoutFor(t),
  };
}

function useDocState(t: DocTypeConfig) {
  const [state, setState] = useState<DocState>(() => initialState(t));
  const ref = useRef(state);
  const hist = useRef({ past: [] as DocState[], future: [] as DocState[], last: 0 });
  const [, rerender] = useState(0);

  const update = useCallback((fn: (s: DocState) => DocState, step = false) => {
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

  /** Replace wholesale — loading a saved document; not an undoable edit. */
  const reset = useCallback((s: DocState) => {
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
    forceSync();
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

// ── Pure helpers ──────────────────────────────────────────────────────────

const mapBlock = (s: DocState, id: string, fn: (b: DBlock) => DBlock): DocState =>
  ({ ...s, blocks: s.blocks.map((b) => (b.id === id ? fn(b) : b)) });

const mapLines = (s: DocState, blockId: string, fn: (ls: Line[]) => Line[]): DocState =>
  mapBlock(s, blockId, (b) => ({ ...b, lines: fn(b.lines ?? []) }));

const swap = <T,>(arr: T[], i: number, j: number): T[] => {
  if (i < 0 || j < 0 || i >= arr.length || j >= arr.length) return arr;
  const next = [...arr];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
};

/**
 * How much the A4 page must shrink to fit the column it is shown in.
 * Measured, not guessed: the column is a grid track whose width depends on
 * the window, the sidebar and the zoom level. 1 means no scaling at all.
 */
function useFitToWidth(pageWidthPx: number) {
  const paneRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const read = () => {
      // A little room for the page shadow and the block controls in the gutter.
      const avail = el.clientWidth - 24;
      setFit((f) => {
        const next = Math.min(1, Math.max(0.45, avail / pageWidthPx));
        return Math.abs(next - f) < 0.005 ? f : next;
      });
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pageWidthPx]);
  return { paneRef, fit };
}

const editEl = (surface: string, id: string) =>
  document.querySelector<HTMLElement>(`[data-edit-id="${CSS.escape(`${surface}:${id}`)}"]`);

/** A date-shaped value also reads as a date on the page. */
const varsOf = (s: DocState): Record<string, string> => {
  const out: Record<string, string> = { doc_date: fmtLong(s.docDate) };
  for (const [k, v] of Object.entries(s.fields)) {
    out[k] = /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtLong(v) : v;
  }
  return out;
};

const NEW_BLOCK: Record<DocAction, () => DBlock> = {
  addParagraph: () => ({ id: bid(), key: 'paragraph', enabled: true, lines: [newLine()] }),
  addSection: () => ({ id: bid(), key: 'section', enabled: true, title: '', lines: [newLine()] }),
  addDetails: () => ({ id: bid(), key: 'keyvalue', enabled: true, title: 'Details', rows: [newRow(), newRow()] }),
  addSignature: () => ({ id: bid(), key: 'signature', enabled: true, title: '', columns: 1, people: [newPerson()] }),
  addWitness: () => ({ id: bid(), key: 'witness', enabled: true, people: [newPerson({ note: 'Witness 1:' }), newPerson({ note: 'Witness 2:' })] }),
  addSpace: () => ({ id: bid(), key: 'spacer', enabled: true, heightPx: 24 }),
  addPageBreak: () => ({ id: bid(), key: 'pagebreak', enabled: true }),
};

const ACTION_LABEL: Record<DocAction, string> = {
  addParagraph: 'Paragraph', addSection: 'Section', addDetails: 'Details',
  addSignature: 'Signature', addWitness: 'Witnesses', addSpace: 'Space', addPageBreak: 'Page break',
};

const btn = 'h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50 disabled:opacity-50';
const btnPrimary = 'h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-50';
const smallBtn = 'h-7 w-7 inline-flex items-center justify-center rounded border border-neutral-300 bg-white hover:bg-neutral-50 text-neutral-500 disabled:opacity-40';

export function DocBuilderPage() {
  const { typeId, id } = useParams<{ typeId?: string; id?: string }>();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'workstation.doc.manage', 'self');
  const [searchParams] = useSearchParams();
  const prefillClientId = searchParams.get('client_id');
  const prefilled = useRef(false);

  const existingQ = useQuery({ queryKey: ['docs.get', id], queryFn: () => docsApi.get(id!), enabled: isEdit });
  const clientsQ = useQuery({ queryKey: ['quotations.clients'], queryFn: () => workstationApi.listClients() });

  const type = docType(isEdit ? existingQ.data?.doc_type : typeId);
  const fallback = docType('consent-letter')!;
  const t = type ?? fallback;

  const { state: s, ref: sRef, update, reset, undo, redo, canUndo, canRedo } = useDocState(t);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<'edit' | 'preview'>('edit');
  const [tab, setTab] = useState<'details' | 'blocks' | 'layout'>('details');
  const [error, setError] = useState<string | null>(null);

  // A new document of a type starts from that type's template.
  useEffect(() => {
    if (isEdit || !type) return;
    if (sRef.current.typeId === type.id && sRef.current.blocks.length) return;
    reset(initialState(type));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, type?.id]);

  // Hydrate once per document (a duplicate navigates to a new id → again).
  useEffect(() => {
    if (isEdit && existingQ.data && type && loadedId !== existingQ.data.id) {
      reset(stateFromApi(existingQ.data, type));
      setLoadedId(existingQ.data.id);
    }
  }, [isEdit, existingQ.data, type, loadedId, reset]);

  /** Picking a client fills the fields that declare where they come from. */
  const chooseClient = useCallback((chosen: string) => {
    update((x) => {
      const c = (clientsQ.data?.items ?? []).find((y) => y.id === chosen);
      const next: DocState = { ...x, partyKind: chosen ? 'client' : 'none', partyId: chosen, fields: { ...x.fields } };
      if (c) {
        const from: Record<string, string> = {
          companyName: c.company_name ?? '',
          address: c.address ?? '',
          email: c.email ?? '',
          phone: c.contact_number ?? '',
          contactPerson: c.contact_person ?? '',
        };
        for (const f of t.fields) {
          // Never overwrite what someone has already typed.
          if (f.from && !next.fields[f.key]) next.fields[f.key] = from[f.from] ?? '';
        }
      }
      // The header is the client's letterhead: a different client means a
      // different letterhead. Keep the on/off state and field ticks.
      const hdr = (x.layout as LayoutConfig & { companyHeader?: CompanyHeader }).companyHeader;
      if (hdr) {
        const fresh = clientHeader(c ?? null);
        next.layout = { ...x.layout, companyHeader: { ...fresh, enabled: hdr.enabled, show: { ...hdr.show, gstin: fresh.show.gstin } } } as LayoutConfig;
      }
      return next;
    }, true);
  }, [clientsQ.data, t, update]);

  /**
   * The header always mirrors the linked client's record. Re-applied when the
   * document opens or the client list loads, so a later change to the client
   * (a new address, a GSTIN) reaches the letter; only writes when a value
   * actually differs, and keeps the user's on/off and line choices.
   */
  const linkedClient = s.partyKind === 'client' ? (clientsQ.data?.items ?? []).find((c) => c.id === s.partyId) ?? null : null;
  const headerSaved = (s.layout as LayoutConfig & { companyHeader?: CompanyHeader }).companyHeader;
  useEffect(() => {
    if (!headerSaved || !linkedClient) return;
    const fresh = clientHeader(linkedClient);
    const keys = ['name', 'address', 'email', 'phone', 'gstin'] as const;
    if (keys.every((k) => (headerSaved[k] ?? '') === fresh[k])) return;
    update((x) => ({
      ...x,
      layout: { ...x.layout, companyHeader: { ...fresh, enabled: headerSaved.enabled, show: { ...fresh.show, ...headerSaved.show, gstin: headerSaved.gstin ? (headerSaved.show?.gstin ?? true) && fresh.show.gstin : fresh.show.gstin } } } as LayoutConfig,
    }));
  }, [linkedClient, headerSaved, update]);

  useEffect(() => {
    if (isEdit || prefilled.current || !prefillClientId || !clientsQ.data) return;
    if (!clientsQ.data.items.some((c) => c.id === prefillClientId)) return;
    prefilled.current = true;
    chooseClient(prefillClientId);
  }, [isEdit, prefillClientId, clientsQ.data, chooseClient]);

  // ── The editing operations: shared by the page and the left panel ──────
  const edit: DocEditApi = useMemo(() => {
    const line = (blockId: string, lineId: string, patch: Partial<Line>, step = false) =>
      update((x) => mapLines(x, blockId, (ls) => ls.map((l) => (l.id === lineId ? { ...l, ...patch } : l))), step);

    return {
      block: (bId, patch) => update((x) => mapBlock(x, bId, (b) => ({ ...b, ...patch })), 'heightPx' in patch || 'enabled' in patch),
      line: (bId, lId, patch) => line(bId, lId, patch, !('html' in patch)),
      row: (bId, rowId, patch) => update((x) => mapBlock(x, bId, (b) =>
        ({ ...b, rows: (b.rows ?? []).map((r) => (r.id === rowId ? { ...r, ...patch } : r)) }))),
      person: (bId, pId, patch) => update((x) => mapBlock(x, bId, (b) =>
        ({ ...b, people: (b.people ?? []).map((p) => (p.id === pId ? { ...p, ...patch } : p)) }))),
      docDate: (iso) => update((x) => ({ ...x, docDate: iso }), true),

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
        const nb = kind === 'spacer' ? NEW_BLOCK.addSpace() : NEW_BLOCK.addParagraph();
        update((x) => {
          const i = x.blocks.findIndex((b) => b.id === bId);
          return { ...x, blocks: [...x.blocks.slice(0, i + 1), nb, ...x.blocks.slice(i + 1)] };
        }, true);
        if (kind === 'paragraph') requestFocus(`${surface}:${nb.lines![0].id}`, 0);
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update]);

  // Ctrl+Z / Ctrl+Shift+Z anywhere in the workspace.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const doc: DocModel = { docDate: s.docDate, vars: varsOf(s), blocks: s.blocks, layout: s.layout };
  // The page is a fixed 210mm wide; the column it sits in is not. Scale it
  // DOWN to fit (never up), so the document is whole on any width instead of
  // having its right edge cut off.
  const { paneRef, fit } = useFitToWidth(pageGeometry(s.layout).widthPx);

  const input = (): DocInput => ({
    doc_type: s.typeId,
    title: s.title.trim() || t.name,
    client_id: s.partyKind === 'client' && s.partyId ? s.partyId : null,
    lead_id: s.partyKind === 'lead' && s.partyId ? s.partyId : null,
    doc_date: s.docDate,
    field_values: s.fields,
    // Empty lines are editing scaffolding, not content.
    block_config: s.blocks.map((b) => (PROSE.has(b.key)
      ? { ...b, lines: (b.lines ?? []).filter((l) => !lineIsEmpty(l)) }
      : b)) as unknown as Record<string, unknown>[],
    layout_config: s.layout as unknown as Record<string, unknown>,
  });

  const save = useMutation({
    mutationFn: () => (isEdit ? docsApi.update(id!, input()) : docsApi.create(input())),
    onSuccess: (d) => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['docs.list'] });
      queryClient.invalidateQueries({ queryKey: ['docs.counts'] });
      queryClient.setQueryData(['docs.get', d.id], d);
      // Saving does not reload the editor: what is on screen IS what was saved.
      setLoadedId(d.id);
      if (!isEdit) navigate(`/workstation/doc/${d.id}/edit`, { replace: true });
    },
    onError: (e) => setError((e as { message?: string })?.message ?? 'That could not be saved.'),
  });

  const act = (fn: () => Promise<WorkstationDoc>, after?: (d: WorkstationDoc) => void) => async () => {
    try {
      const d = await fn();
      setError(null);
      queryClient.setQueryData(['docs.get', d.id], d);
      queryClient.invalidateQueries({ queryKey: ['docs.list'] });
      if (after) after(d);
      else if (type) reset(stateFromApi(d, type));
    } catch (e) {
      setError((e as { message?: string })?.message ?? 'That did not work.');
    }
  };

  async function downloadPdf() {
    if (!id) return;
    try {
      const { url } = await docsApi.pdfUrl(id);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setError((e as { message?: string })?.message ?? 'The PDF could not be prepared.');
    }
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

  if (!type && !isEdit) {
    return <div className="text-13 text-neutral-600">That document type does not exist. <Link className="underline" to="/workstation/doc">Back to Doc</Link>.</div>;
  }

  return (
    <div className="qb-root">
      <header className="flex items-start gap-3 flex-wrap mb-4 qdoc-screen-only">
        <div className="min-w-0">
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Workstation · Doc</div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-0.5">{t.name}</h1>
          <p className="text-13 text-neutral-500 mt-1">
            {isEdit ? existingQ.data?.doc_code ?? '' : 'The reference number is allocated when you save.'}
            {isEdit ? <> · <span className="capitalize">{status}</span></> : null}
          </p>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={undo} disabled={!canUndo || frozen} className={btn} title="Undo (Ctrl+Z)"><Undo2 size={14} /></button>
          <button type="button" onClick={redo} disabled={!canRedo || frozen} className={btn} title="Redo (Ctrl+Shift+Z)"><Redo2 size={14} /></button>
          {isEdit ? <Link to={`/workstation/doc/${id}/preview`} className={btn}><FileText size={14} /> Preview</Link> : null}
          <button type="button" onClick={printDocument} className={btn}><Printer size={14} /> Print</button>
          {isEdit ? <button type="button" onClick={downloadPdf} className={btn}><Download size={14} /> PDF</button> : null}
          {isEdit && canManage ? (
            <>
              <button type="button" className={btn} onClick={act(() => docsApi.duplicate(id!), (d) => navigate(`/workstation/doc/${d.id}/edit`))}>
                <Copy size={14} /> Duplicate
              </button>
              {status === 'draft' ? (
                <button type="button" className={btn} onClick={act(() => docsApi.finalise(id!))}><Lock size={14} /> Mark final</button>
              ) : (
                <button type="button" className={btn} onClick={act(() => docsApi.reopen(id!))}><Pencil size={14} /> Reopen</button>
              )}
              <button
                type="button"
                className={btn}
                onClick={async () => {
                  if (!window.confirm('Delete this document? This cannot be undone.')) return;
                  await docsApi.remove(id!);
                  queryClient.invalidateQueries({ queryKey: ['docs.list'] });
                  queryClient.invalidateQueries({ queryKey: ['docs.counts'] });
                  navigate(`/workstation/doc/t/${s.typeId}`);
                }}
              >
                <Trash2 size={14} /> Delete
              </button>
            </>
          ) : null}
          <button type="button" onClick={() => save.mutate()} disabled={save.isPending || frozen || !canManage} className={btnPrimary}>
            <Save size={14} /> {save.isPending ? 'Saving…' : isEdit ? 'Update' : 'Save draft'}
          </button>
        </div>
      </header>

      <div className="md:hidden flex gap-2 mb-3 qdoc-screen-only">
        {(['edit', 'preview'] as const).map((v) => (
          <button key={v} type="button" onClick={() => setMobileView(v)}
            className={`h-8 px-4 text-13 rounded border ${mobileView === v ? 'bg-neutral-900 text-white border-neutral-900' : 'bg-white border-neutral-300'}`}>
            {v === 'edit' ? 'Controls' : 'Document'}
          </button>
        ))}
      </div>

      {error ? <div className="border-l-2 border-red pl-3 text-13 mb-3 qdoc-screen-only">{error}</div> : null}
      {frozen ? (
        <div className="flex items-center gap-3 flex-wrap border border-amber-300 bg-amber-50 rounded px-3 py-2 text-13 mb-3 text-neutral-800 qdoc-screen-only">
          <span className="flex-1 min-w-0">
            <strong>This document is {status}, so it is locked.</strong> Reopen it to make changes.
          </span>
        </div>
      ) : null}

      {/* The controls take a fixed, readable column; the document takes the
          rest and is scaled to fit it, so a 210mm page is never clipped by a
          left panel that grew. Both columns scroll independently. */}
      <div className="grid grid-cols-1 md:grid-cols-[minmax(300px,360px)_minmax(0,1fr)] xl:grid-cols-[minmax(320px,400px)_minmax(0,1fr)] gap-4 items-start">
        {/* ── LEFT: the controls ───────────────────────────────────────── */}
        <div
          data-edit-surface="left"
          className={`el-editing qdoc-screen-only space-y-3 min-w-0 md:max-h-[calc(100dvh-190px)] md:overflow-y-auto md:overflow-x-hidden md:pr-1 ${mobileView === 'preview' ? 'hidden md:block' : ''}`}
        >
          <nav className="flex gap-x-4 border-b border-neutral-200 mb-3">
            {(['details', 'blocks', 'layout'] as const).map((x) => (
              <button key={x} type="button" onClick={() => setTab(x)}
                className={'h-8 flex items-center text-13 uppercase tracking-[0.06em] border-b-2 -mb-px '
                  + (tab === x ? 'border-gold text-neutral-900 font-medium' : 'border-transparent text-neutral-500 hover:text-neutral-900')}>
                {x}
              </button>
            ))}
          </nav>

          <fieldset disabled={frozen} className="space-y-3 min-w-0">
            {tab === 'details' ? (
              <DetailsTab
                t={t} s={s} update={update}
                clients={clientsQ.data?.items ?? []}
                chooseClient={chooseClient}
              />
            ) : null}
            {tab === 'blocks' ? <BlocksTab t={t} s={s} edit={edit} update={update} /> : null}
            {tab === 'layout' ? (
              <LayoutTab layout={s.layout} setLayout={(patch) => update((x) => ({ ...x, layout: { ...x.layout, ...patch } }), true)} />
            ) : null}
          </fieldset>
        </div>

        {/* ── RIGHT: the document itself, directly editable ─────────────── */}
        <div className={`${mobileView === 'edit' ? 'hidden md:block' : ''} min-w-0 md:sticky md:top-4`}>
          <div ref={paneRef} className="md:max-h-[calc(100dvh-190px)] overflow-y-auto overflow-x-hidden qdoc-viewport">
            <DocDocument doc={doc} edit={liveEdit} scale={fit} />
          </div>
          {!frozen ? (
            <FormatToolbar
              getLine={(bId, lId) => sRef.current.blocks.find((b) => b.id === bId)?.lines?.find((l) => l.id === lId)}
              setLine={(bId, lId, patch) => edit.line(bId, lId, patch)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── Left panel: the facts ─────────────────────────────────────────────────

function DetailsTab({ t, s, update, clients, chooseClient }: {
  t: DocTypeConfig;
  s: DocState;
  update: (fn: (s: DocState) => DocState, step?: boolean) => void;
  clients: ({ id: string } & HeaderSource)[];
  chooseClient: (id: string) => void;
}) {
  const groups = [...new Set(t.fields.map((f) => f.group ?? 'Particulars'))];
  const setField = (k: string, v: string) =>
    update((x) => ({ ...x, fields: { ...x.fields, [k]: v } }));

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Document</Label>
        <input className={inputClass} value={s.title} placeholder={t.name}
          onChange={(e) => update((x) => ({ ...x, title: e.target.value }))} />
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-12 text-neutral-500">Date</span>
            <input type="date" className={inputClass} value={s.docDate}
              onChange={(e) => update((x) => ({ ...x, docDate: e.target.value }), true)} />
          </label>
          <label className="block">
            <span className="text-12 text-neutral-500">Client (optional)</span>
            <select className={inputClass} value={s.partyKind === 'client' ? s.partyId : ''}
              onChange={(e) => chooseClient(e.target.value)}>
              <option value="">Not linked</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.company_name}</option>)}
            </select>
          </label>
        </div>
      </div>

      <CompanyHeaderSection s={s} update={update}
        client={s.partyKind === 'client' ? clients.find((c) => c.id === s.partyId) ?? null : null} />

      {groups.map((g) => (
        <div key={g} className="space-y-2">
          <Label>{g}</Label>
          {t.fields.filter((f) => (f.group ?? 'Particulars') === g).map((f) => (
            <label key={f.key} className="block">
              <span className="text-12 text-neutral-500">{f.label}</span>
              {f.type === 'textarea' ? (
                <textarea rows={2} className={inputClass} value={s.fields[f.key] ?? ''} placeholder={f.placeholder}
                  onChange={(e) => setField(f.key, e.target.value)} />
              ) : (
                <input type={f.type === 'date' ? 'date' : f.type === 'time' ? 'time' : 'text'}
                  className={inputClass} value={s.fields[f.key] ?? ''} placeholder={f.placeholder}
                  onChange={(e) => setField(f.key, e.target.value)} />
              )}
            </label>
          ))}
        </div>
      ))}
      <p className="text-12 text-neutral-500">
        These fill the {'{{'}placeholders{'}}'} in the document. Every value can also be typed
        straight onto the page — doing so makes that spot literal text, so it stops following
        the field.
      </p>
    </div>
  );
}

/**
 * Company header controls (Details tab). Values start from the company
 * profile and are stored on THIS document only (layout_config.companyHeader);
 * turning the header off keeps the values, so turning it back on restores
 * them.
 */
const HEADER_FIELDS: { key: HeaderField; label: string }[] = [
  { key: 'name', label: 'Company Name' },
  { key: 'address', label: 'Address' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'gstin', label: 'GSTIN' },
];

function CompanyHeaderSection({ s, update, client }: {
  s: DocState;
  update: (fn: (s: DocState) => DocState, step?: boolean) => void;
  /** The client linked to this document, whose letterhead the header is. */
  client: HeaderSource | null;
}) {
  const saved = (s.layout as LayoutConfig & { companyHeader?: CompanyHeader }).companyHeader;
  // Values always come from the linked client; only on/off and which lines
  // show are the user's choice.
  const fromClient = clientHeader(client);
  const enabled = Boolean(saved?.enabled);
  const show = { ...fromClient.show, ...(saved?.show ?? {}) };
  const write = (next: Pick<CompanyHeader, 'enabled' | 'show'>) =>
    update((x) => ({ ...x, layout: { ...x.layout, companyHeader: { ...clientHeader(client), ...next } } as LayoutConfig }), true);

  return (
    <div className="space-y-2">
      <Label>Company header</Label>
      <label className="flex items-center justify-between gap-3 text-13 text-neutral-800">
        <span>Show the client's header at the top</span>
        <button
          type="button" role="switch" aria-checked={enabled}
          onClick={() => write({ enabled: !enabled, show: saved?.show ?? fromClient.show })}
          className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${enabled ? 'bg-primary' : 'bg-neutral-300'}`}
        >
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
          <span className="sr-only">{enabled ? 'On' : 'Off'}</span>
        </button>
      </label>
      {enabled ? (
        <div className="space-y-1.5 border border-neutral-200 rounded p-2">
          {!client ? (
            <p className="text-12 text-amber">Link a client above — the header is filled from the client record.</p>
          ) : null}
          {HEADER_FIELDS.map((f) => {
            const value = fromClient[f.key];
            return (
              <label key={f.key} className="flex items-start gap-2 text-12 text-neutral-700">
                <input type="checkbox" className="mt-0.5" checked={show[f.key]} disabled={!value}
                  onChange={(e) => write({ enabled: true, show: { ...show, [f.key]: e.target.checked } })} />
                <span className="w-24 shrink-0">{f.label}</span>
                <span className={`min-w-0 break-words whitespace-pre-line ${value ? 'text-neutral-900' : 'text-neutral-400 italic'}`}>
                  {value || (client ? 'Not on the client record' : '—')}
                </span>
              </label>
            );
          })}
          {client ? <p className="text-11 text-neutral-500 pt-1">From the client record. To change a value, update the client.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Left panel: the structure ─────────────────────────────────────────────

function BlocksTab({ t, s, edit, update }: {
  t: DocTypeConfig;
  s: DocState;
  edit: DocEditApi;
  update: (fn: (s: DocState) => DocState, step?: boolean) => void;
}) {
  const add = (a: DocAction) =>
    update((x) => ({ ...x, blocks: [...x.blocks, NEW_BLOCK[a]()] }), true);

  return (
    <div className="space-y-3">
      <Label>Add to this document</Label>
      <div className="flex flex-wrap gap-2">
        {t.actions.map((a) => (
          <button key={a} type="button" className={btn} onClick={() => add(a)}>
            <Plus size={13} /> {ACTION_LABEL[a]}
          </button>
        ))}
      </div>

      <Label>Sections</Label>
      <ul className="border border-neutral-200 rounded divide-y divide-neutral-200">
        {s.blocks.map((b, i) => (
          <li key={b.id} className="flex items-center gap-2 px-2 py-1.5">
            <span className="text-12 text-neutral-400 w-5 tabular-nums">{i + 1}</span>
            <span className="flex-1 min-w-0 text-13 truncate">
              <span className="text-neutral-900">{b.title?.trim() || BLOCK_LABEL[b.key]}</span>
              {b.title?.trim() ? <span className="text-neutral-400"> · {BLOCK_LABEL[b.key]}</span> : null}
            </span>
            <button type="button" className={smallBtn} title="Move up" disabled={i === 0} onClick={() => edit.moveBlock(b.id, -1)}><ArrowUp size={12} /></button>
            <button type="button" className={smallBtn} title="Move down" disabled={i === s.blocks.length - 1} onClick={() => edit.moveBlock(b.id, 1)}><ArrowDown size={12} /></button>
            <button type="button" className={smallBtn} title={b.enabled ? 'Hide from the document' : 'Show in the document'}
              onClick={() => edit.block(b.id, { enabled: !b.enabled })}>
              {b.enabled ? '●' : '○'}
            </button>
            <button type="button" className={smallBtn} title="Delete" onClick={() => edit.removeBlock(b.id)}><Trash2 size={12} /></button>
          </li>
        ))}
      </ul>

      <RowsAndPeople s={s} edit={edit} update={update} />
    </div>
  );
}

/** Rows and signatories are lists, so they get add/remove here as well. */
function RowsAndPeople({ s, edit, update }: {
  s: DocState;
  edit: DocEditApi;
  update: (fn: (s: DocState) => DocState, step?: boolean) => void;
}) {
  const lists = s.blocks.filter((b) => b.key === 'keyvalue' || b.key === 'signature' || b.key === 'witness');
  if (!lists.length) return null;
  const addRow = (b: DBlock) => update((x) => mapBlock(x, b.id, (y) => ({ ...y, rows: [...(y.rows ?? []), newRow()] })), true);
  const addPerson = (b: DBlock) => update((x) => mapBlock(x, b.id, (y) => ({ ...y, people: [...(y.people ?? []), newPerson()] })), true);
  const dropRow = (b: DBlock, r: KVRow) => update((x) => mapBlock(x, b.id, (y) => ({ ...y, rows: (y.rows ?? []).filter((z) => z.id !== r.id) })), true);
  const dropPerson = (b: DBlock, p: Person) => update((x) => mapBlock(x, b.id, (y) => ({ ...y, people: (y.people ?? []).filter((z) => z.id !== p.id) })), true);

  return (
    <div className="space-y-3">
      {lists.map((b) => (
        <div key={b.id} className="space-y-1.5">
          <Label>{b.title?.trim() || BLOCK_LABEL[b.key]}</Label>
          {b.key === 'keyvalue' ? (
            <>
              {(b.rows ?? []).map((r) => (
                <div key={r.id} className="flex items-center gap-1.5">
                  <input className={inputClass} value={r.label} placeholder="Label" onChange={(e) => edit.row(b.id, r.id, { label: e.target.value })} />
                  <input className={inputClass} value={r.value} placeholder="Value" onChange={(e) => edit.row(b.id, r.id, { value: e.target.value })} />
                  <button type="button" className={smallBtn} title="Remove" onClick={() => dropRow(b, r)}><Trash2 size={12} /></button>
                </div>
              ))}
              <button type="button" className={btn} onClick={() => addRow(b)}><Plus size={13} /> Row</button>
            </>
          ) : (
            <>
              {(b.people ?? []).map((p) => (
                <div key={p.id} className="flex items-center gap-1.5">
                  <input className={inputClass} value={p.name} placeholder="Name" onChange={(e) => edit.person(b.id, p.id, { name: e.target.value })} />
                  <input className={inputClass} value={p.role} placeholder={b.key === 'witness' ? 'Address' : 'Designation'}
                    onChange={(e) => edit.person(b.id, p.id, { role: e.target.value })} />
                  {b.key === 'signature' ? (
                    <input className={inputClass} value={p.din} placeholder="DIN" onChange={(e) => edit.person(b.id, p.id, { din: e.target.value })} />
                  ) : null}
                  <button type="button" className={smallBtn} title="Remove" onClick={() => dropPerson(b, p)}><Trash2 size={12} /></button>
                </div>
              ))}
              <div className="flex gap-2">
                <button type="button" className={btn} onClick={() => addPerson(b)}><Plus size={13} /> Signatory</button>
                {b.key === 'signature' ? (
                  <button type="button" className={btn} onClick={() => edit.block(b.id, { columns: (b.columns ?? 1) === 1 ? 2 : 1 })}>
                    {(b.columns ?? 1) === 1 ? 'Two columns' : 'One column'}
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Left panel: the page ──────────────────────────────────────────────────

function LayoutTab({ layout, setLayout }: { layout: LayoutConfig; setLayout: (p: Partial<LayoutConfig>) => void }) {
  const row = (label: string, node: React.ReactNode) => (
    <label className="block"><span className="text-12 text-neutral-500">{label}</span>{node}</label>
  );
  return (
    <div className="grid grid-cols-2 gap-2">
      {row('Margins', (
        <select className={inputClass} value={layout.margin} onChange={(e) => setLayout({ margin: e.target.value as LayoutConfig['margin'] })}>
          <option value="narrow">Narrow</option><option value="normal">Normal</option><option value="wide">Wide</option>
        </select>
      ))}
      {row('Typeface', (
        <select className={inputClass} value={layout.font} onChange={(e) => setLayout({ font: e.target.value as LayoutConfig['font'] })}>
          <option value="sans">Sans</option><option value="serif">Serif</option>
        </select>
      ))}
      {row('Body size', (
        <input type="number" min={8} max={14} step={0.5} className={inputClass} value={layout.fontSize}
          onChange={(e) => setLayout({ fontSize: Number(e.target.value) || 11 })} />
      ))}
      {row('Line spacing', (
        <select className={inputClass} value={layout.lineHeight} onChange={(e) => setLayout({ lineHeight: e.target.value as LayoutConfig['lineHeight'] })}>
          <option value="tight">Tight</option><option value="normal">Normal</option><option value="relaxed">Relaxed</option>
        </select>
      ))}
      {row('Footer', (
        <select className={inputClass} value={layout.footerStyle} onChange={(e) => setLayout({ footerStyle: e.target.value as LayoutConfig['footerStyle'] })}>
          <option value="none">None</option><option value="page-numbers">Page numbers</option><option value="company">Company name</option>
        </select>
      ))}
      {row('Page', (
        <select className={inputClass} value={layout.pageSize} onChange={(e) => setLayout({ pageSize: e.target.value as LayoutConfig['pageSize'] })}>
          <option value="A4">A4</option><option value="Letter">Letter</option>
        </select>
      ))}
    </div>
  );
}

const Label = ({ children }: { children: React.ReactNode }) => (
  <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{children}</div>
);

// ── Loading a saved document ──────────────────────────────────────────────

export function stateFromApi(d: WorkstationDoc, t: DocTypeConfig): DocState {
  const saved = (d.block_config as unknown as DBlock[] | null) ?? [];
  return {
    typeId: d.doc_type,
    title: d.title,
    docDate: d.doc_date,
    partyKind: d.client_id ? 'client' : d.lead_id ? 'lead' : 'none',
    partyId: d.client_id ?? d.lead_id ?? '',
    fields: { ...Object.fromEntries(t.fields.map((f) => [f.key, ''])), ...(d.field_values ?? {}) },
    // A document saved before a template changed keeps ITS OWN blocks: the
    // paper that was composed is the paper that is reopened.
    blocks: normalizeDocBlocks(saved.length ? saved : t.blocks()),
    layout: layoutOf(d.layout_config),
  };
}

export { rid };
