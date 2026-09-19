import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown, ArrowUp, Copy, Download, Eye, GripVertical, Minus, MoveVertical, Plus, Printer, Redo2, Save,
  Send, Trash2, Undo2, X,
} from 'lucide-react';
import { fieldErrors, inputClass, textareaClass } from '@/modules/workstation/components';
import { workstationApi } from '@/modules/workstation/api';
import type { ClientListItem, Lead } from '@/modules/workstation/types';
import {
  quotationsApi, previewTotals, rupeesToPaise,
  type QuotationInput, type QuotationItemInput,
} from '@/modules/workstation/quotations/api';
import {
  BLOCK_LABEL, COMPLIANCE_STARTER, DEFAULT_COMPANY, DEFAULT_LAYOUT, FREQUENCY_OPTIONS,
  SPACE_MAX_PX, SPACE_MIN_PX, SPACE_STEP_PX, clampSpace, defaultBlocks, makeSpace, pageGeometry,
  spaceHeightPx,
  type BlockSpec, type ClientSnapshot, type CompanyInfo, type LayoutConfig, type TemplateId,
  type WorkSection,
} from '@/modules/workstation/quotations/document';
import { QuotationDocument, type DocumentModel, type QuoteEditApi, type QuoteField } from './QuotationDocument';
import { forceSync } from '@/pages/workstation/engagement/Editable';

/**
 * THE QUOTATION BUILDER — /workstation/quotations/new and /:id/edit.
 *
 * Editor on the left, the real document on the right. The two are the SAME
 * state object: there is no save-then-refresh step, because the preview is
 * rendered from what you are typing, by the same component that prints.
 *
 * Three tabs, per the reference editor: DETAILS is the quotation's content,
 * LAYOUT is how the paper looks, BLOCKS is which sections appear and in what
 * order. All three are stored ON the quotation, so reopening a draft restores
 * the document exactly — not merely its data.
 */

let seq = 0;
const key = () => `k${seq++}`;

interface Line {
  key: string;
  description: string;
  detail: string;
  frequency: string;
  category: string;
  /** Rupees as typed, so a half-finished number does not become 0. */
  feeText: string;
  /** GST template only. */
  qtyText: string;
  gstRatePercent: number;
  discountPercent: number;
}

const newLine = (frequency = 'Monthly'): Line => ({
  key: key(), description: '', detail: '', frequency, category: '',
  feeText: '', qtyText: '1', gstRatePercent: 18, discountPercent: 0,
});

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export function QuotationBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const prefillClientId = searchParams.get('client_id');
  const prefilled = useRef(false);
  const queryClient = useQueryClient();

  const existingQ = useQuery({
    queryKey: ['quotations.get', id], queryFn: () => quotationsApi.get(id!), enabled: isEdit,
  });
  const clientsQ = useQuery({ queryKey: ['quotations.clients'], queryFn: () => workstationApi.listClients() });
  const leadsQ = useQuery({ queryKey: ['quotations.leads'], queryFn: () => workstationApi.listLeads() });
  const templatesQ = useQuery({ queryKey: ['quotations.templates'], queryFn: () => quotationsApi.templates() });

  // ── One state object. Everything the document shows lives here. ────────
  const [templateId, setTemplateId] = useState<TemplateId>('jns-compliance');
  const [partyKind, setPartyKind] = useState<'client' | 'lead'>('client');
  const [partyId, setPartyId] = useState('');
  const [subject, setSubject] = useState('');
  const [quoteDate, setQuoteDate] = useState(today());
  const [validUntil, setValidUntil] = useState(inDays(30));
  const [placeOfSupply, setPlaceOfSupply] = useState('');
  const [isInterState, setIsInterState] = useState(false);
  const [discountText, setDiscountText] = useState('');
  const [company, setCompany] = useState<CompanyInfo>(DEFAULT_COMPANY);
  const [client, setClient] = useState<ClientSnapshot>({
    name: '', client_type: '', industry: '', location: '', transactions: '',
  });
  const [introduction, setIntroduction] = useState(COMPLIANCE_STARTER.introduction);
  const [closingText, setClosingText] = useState(COMPLIANCE_STARTER.closingText);
  const [preparedByName, setPreparedByName] = useState('');
  const [preparedByDesignation, setPreparedByDesignation] = useState('');
  const [notes, setNotes] = useState('');
  const [terms, setTerms] = useState('');
  const [paymentDetails, setPaymentDetails] = useState('');
  const [layout, setLayout] = useState<LayoutConfig>(DEFAULT_LAYOUT);
  const [blocks, setBlocks] = useState<BlockSpec[]>(defaultBlocks('jns-compliance'));
  const [lines, setLines] = useState<Line[]>(
    COMPLIANCE_STARTER.services.map((s) => ({ ...newLine(s.frequency), description: s.description, gstRatePercent: 0 })),
  );
  const [sections, setSections] = useState<WorkSection[]>(
    COMPLIANCE_STARTER.workSections.map((w) => ({ ...w, key: key() })),
  );

  const [tab, setTab] = useState<'details' | 'layout' | 'blocks'>('details');
  const [mobileView, setMobileView] = useState<'edit' | 'preview'>('edit');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  // Hydrate once when editing — a second pass would stamp on typing.
  if (isEdit && existingQ.data && !loaded) {
    const q = existingQ.data;
    const tpl = (q.template_id as TemplateId) ?? 'gst-line-item';
    const cfg = (q.layout_config ?? {}) as Partial<LayoutConfig> & { company?: Partial<CompanyInfo> };
    const snap = (q.client_snapshot ?? {}) as Partial<ClientSnapshot>;
    setTemplateId(tpl);
    setPartyKind(q.client_id ? 'client' : 'lead');
    setPartyId(q.client_id ?? q.lead_id ?? '');
    setSubject(q.subject);
    setQuoteDate(q.quote_date);
    setValidUntil(q.valid_until);
    setPlaceOfSupply(q.place_of_supply ?? '');
    setIsInterState(q.is_inter_state);
    setDiscountText(q.discount_paise ? String(q.discount_paise / 100) : '');
    setCompany({ ...DEFAULT_COMPANY, ...(cfg.company ?? {}) });
    setClient({
      name: snap.name ?? q.party_name ?? '',
      client_type: snap.client_type ?? '',
      industry: snap.industry ?? '',
      location: snap.location ?? '',
      transactions: snap.transactions ?? '',
    });
    setIntroduction(q.introduction ?? '');
    setClosingText(q.closing_text ?? '');
    setPreparedByName(q.prepared_by_name ?? q.prepared_by?.full_name ?? '');
    setPreparedByDesignation(q.prepared_by_designation ?? '');
    setNotes(q.notes ?? '');
    setTerms(q.terms ?? '');
    setLayout({ ...DEFAULT_LAYOUT, ...cfg });
    setBlocks((q.block_config as BlockSpec[] | null) ?? defaultBlocks(tpl));
    setLines(q.items.map((i) => ({
      key: key(),
      description: i.description,
      detail: i.detail ?? '',
      frequency: i.frequency ?? '',
      category: i.category ?? '',
      feeText: String(i.unit_rate_paise / 100),
      qtyText: String(i.quantity_centi / 100),
      gstRatePercent: i.gst_rate_percent,
      discountPercent: i.discount_percent,
    })));
    setSections((q.work_sections ?? []).map((w) => ({
      key: key(), title: w.title, description: w.description ?? '', items: w.items.map((it) => it.content),
    })));
    setLoaded(true);
  }

  const compliance = templateId === 'jns-compliance';

  /** Lines in the shape the totals engine and the API both want. */
  const itemInputs: QuotationItemInput[] = useMemo(() => lines.map((l) => ({
    description: l.description.trim() || 'Untitled line',
    quantity_centi: compliance ? 100 : Math.max(1, Math.round(Number(l.qtyText || '1') * 100)),
    unit_rate_paise: rupeesToPaise(l.feeText),
    discount_percent: compliance ? 0 : l.discountPercent,
    gst_rate_percent: compliance ? 0 : l.gstRatePercent,
    frequency: l.frequency || null,
    category: l.category || null,
    detail: l.detail || null,
  })), [lines, compliance]);

  const discountPaise = rupeesToPaise(discountText);
  const totals = useMemo(
    () => previewTotals(itemInputs, compliance ? 0 : discountPaise, isInterState),
    [itemInputs, discountPaise, isInterState, compliance],
  );

  // ── The document, rebuilt on every keystroke. This IS the preview. ─────
  const doc: DocumentModel = {
    templateId,
    quotationCode: existingQ.data?.quotation_code ?? 'QT-—',
    quoteDate, validUntil, subject, placeOfSupply,
    company, client,
    clientGstin: null, clientEmail: null, clientPhone: null, clientAddress: null,
    introduction, closingText, preparedByName, preparedByDesignation,
    notes, terms, paymentDetails,
    layout, blocks,
    items: lines.map((l, i) => ({
      key: l.key,
      description: l.description.trim() || '—',
      detail: l.detail || undefined,
      frequency: l.frequency || undefined,
      amountPaise: totals.lineAmounts[i] ?? 0,
      quantityCenti: itemInputs[i]?.quantity_centi,
      unitRatePaise: itemInputs[i]?.unit_rate_paise,
      gstRatePercent: itemInputs[i]?.gst_rate_percent,
      discountPercent: itemInputs[i]?.discount_percent,
      raw: { description: l.description, detail: l.detail, frequency: l.frequency, feeText: l.feeText, qtyText: l.qtyText },
    })),
    workSections: sections,
    totals: {
      subtotalPaise: totals.subtotal_paise,
      discountPaise: totals.discount_paise,
      taxablePaise: totals.taxable_paise,
      cgstPaise: totals.cgst_paise,
      sgstPaise: totals.sgst_paise,
      igstPaise: totals.igst_paise,
      totalPaise: totals.total_paise,
      isInterState,
    },
  };

  // ── Saving ─────────────────────────────────────────────────────────────
  const save = useMutation({
    mutationFn: (input: QuotationInput) => (isEdit ? quotationsApi.update(id!, input) : quotationsApi.create(input)),
    onSuccess: (q) => {
      queryClient.invalidateQueries({ queryKey: ['quotations.list'] });
      queryClient.invalidateQueries({ queryKey: ['quotations.summary'] });
      navigate(`/workstation/quotations/${q.id}`);
    },
  });
  const serverErrors = fieldErrors(save.error);
  const err = (k: string) => errors[k] ?? serverErrors[k];

  function submit() {
    const next: Record<string, string> = {};
    if (!partyId) next.party = `Choose the ${partyKind}.`;
    if (!quoteDate) next.quote_date = 'A quotation needs a date.';
    if (!subject.trim()) next.subject = 'Give the quotation a subject.';
    if (validUntil && validUntil < quoteDate) next.valid_until = 'Validity cannot end before the quotation date.';
    if (lines.filter((l) => l.description.trim()).length === 0) next.items = 'Add at least one service.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    save.mutate({
      client_id: partyKind === 'client' ? partyId : null,
      lead_id: partyKind === 'lead' ? partyId : null,
      subject: subject.trim(),
      quote_date: quoteDate,
      valid_until: validUntil,
      place_of_supply: placeOfSupply || null,
      is_inter_state: isInterState,
      discount_paise: compliance ? 0 : discountPaise,
      notes: notes || null,
      terms: terms || null,
      template_id: templateId,
      introduction: introduction || null,
      closing_text: closingText || null,
      prepared_by_name: preparedByName || null,
      prepared_by_designation: preparedByDesignation || null,
      // The company block travels with the layout: it is how this document
      // was headed when it went out, not a live pointer at settings.
      layout_config: { ...layout, company } as unknown as Record<string, unknown>,
      block_config: blocks as unknown as Record<string, unknown>[],
      client_snapshot: client as unknown as Record<string, unknown>,
      work_sections: sections
        .filter((s) => s.title.trim())
        .map((s) => ({
          title: s.title.trim(),
          description: s.description || null,
          items: s.items.filter((i) => i.trim()),
        })),
      items: lines.filter((l) => l.description.trim()).map((l, i) => itemInputs[lines.indexOf(l)] ?? itemInputs[i]),
    });
  }

  /** §28 — print the document, never the application around it. */
  function printDocument() {
    document.documentElement.classList.add('qdoc-printing');
    const done = () => {
      document.documentElement.classList.remove('qdoc-printing');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
  }

  // ── Client auto-fill (§31). Quotation-only fields stay editable. ───────
  function chooseParty(kind: 'client' | 'lead', chosenId: string) {
    setPartyKind(kind);
    setPartyId(chosenId);
    if (kind === 'client') {
      const c = (clientsQ.data?.items ?? []).find((x) => x.id === chosenId);
      if (c) {
        setClient((prev) => ({
          ...prev,
          name: c.company_name,
          client_type: prev.client_type || c.business_type || '',
          location: prev.location || c.address || '',
        }));
      }
    } else {
      const l = (leadsQ.data?.items ?? []).find((x) => x.id === chosenId);
      if (l) setClient((prev) => ({ ...prev, name: l.name }));
    }
  }

  /**
   * "New quotation" from a client workspace arrives as ?client_id=… — attach
   * it once the client list is in, so the party and its snapshot are filled
   * the same way a manual pick fills them. Once only, and never on an existing
   * quotation, so it cannot fight the user's own choice or the loaded record.
   */
  useEffect(() => {
    if (id || prefilled.current || !prefillClientId || !clientsQ.data) return;
    if (!clientsQ.data.items.some((c) => c.id === prefillClientId)) return;
    prefilled.current = true;
    chooseParty('client', prefillClientId);
  }, [id, prefillClientId, clientsQ.data]);

  function applyTemplate(next: TemplateId) {
    setTemplateId(next);
    setBlocks(defaultBlocks(next));
    if (next === 'gst-line-item') {
      setLines((ls) => ls.map((l) => ({ ...l, gstRatePercent: l.gstRatePercent || 18 })));
    }
  }

  // ── Direct editing on the page ─────────────────────────────────────────
  // The page writes through the same setters the form on the left uses, so
  // there is one quotation and two ways to edit it.
  const edit: QuoteEditApi = useMemo(() => {
    const fields: Record<QuoteField, (v: string) => void> = {
      subject: setSubject, quoteDate: setQuoteDate, validUntil: setValidUntil, placeOfSupply: setPlaceOfSupply,
      introduction: setIntroduction, closingText: setClosingText, preparedByName: setPreparedByName,
      preparedByDesignation: setPreparedByDesignation, notes: setNotes, terms: setTerms, paymentDetails: setPaymentDetails,
    };
    const move = <T,>(xs: T[], i: number, by: number): T[] => {
      const j = i + by;
      if (i < 0 || j < 0 || j >= xs.length) return xs;
      const n = [...xs];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    };
    return {
      field: (k, v) => fields[k](v),
      company: (k, v) => setCompany((c) => ({ ...c, [k]: v })),
      client: (k, v) => setClient((c) => ({ ...c, [k]: v })),
      block: (id, patch) => setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, ...patch } : b))),
      moveBlock: (id, by) => setBlocks((bs) => move(bs, bs.findIndex((b) => b.id === id), by)),
      removeBlock: (id) => setBlocks((bs) => bs.filter((b) => b.id !== id)),
      addSpaceAfter: (id) => setBlocks((bs) => {
        const i = bs.findIndex((b) => b.id === id);
        return [...bs.slice(0, i + 1), makeSpace(key()), ...bs.slice(i + 1)];
      }),
      item: (k, patch) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l))),
      itemOp: (k, op) => setLines((ls) => {
        const i = ls.findIndex((l) => l.key === k);
        if (op === 'up') return move(ls, i, -1);
        if (op === 'down') return move(ls, i, 1);
        if (op === 'dup') return [...ls.slice(0, i + 1), { ...ls[i], key: key() }, ...ls.slice(i + 1)];
        return ls.filter((l) => l.key !== k);
      }),
      addItem: () => {
        const nl = newLine();
        setLines((ls) => [...ls, nl]);
        return nl.key;
      },
      section: (k, patch) => setSections((ss) => ss.map((x) => (x.key === k ? { ...x, ...patch } : x))),
      sectionItems: (k, fn) => setSections((ss) => ss.map((x) => (x.key === k ? { ...x, items: fn(x.items) } : x))),
      sectionOp: (k, op) => setSections((ss) => {
        const i = ss.findIndex((x) => x.key === k);
        if (op === 'up') return move(ss, i, -1);
        if (op === 'down') return move(ss, i, 1);
        return ss.filter((x) => x.key !== k);
      }),
      addSection: () => {
        const ns: WorkSection = { key: key(), title: '', description: '', items: [''] };
        setSections((ss) => [...ss, ns]);
        return ns.key;
      },
    };
  }, []);

  // ── Undo / redo, over every edit from either side ──────────────────────
  // A snapshot of everything the quotation shows. Whichever side changed it,
  // the previous snapshot goes on the stack; typing within a short pause
  // folds into one step.
  const snap = useMemo(() => ({
    subject, quoteDate, validUntil, placeOfSupply, isInterState, discountText, company, client,
    introduction, closingText, preparedByName, preparedByDesignation, notes, terms, paymentDetails,
    layout, blocks, lines, sections,
  }), [subject, quoteDate, validUntil, placeOfSupply, isInterState, discountText, company, client,
    introduction, closingText, preparedByName, preparedByDesignation, notes, terms, paymentDetails,
    layout, blocks, lines, sections]);
  type Snap = typeof snap;
  const hist = useRef({ past: [] as Snap[], future: [] as Snap[], last: 0, prev: null as Snap | null, restoring: false });
  const [, histTick] = useState(0);

  useEffect(() => {
    const h = hist.current;
    if (h.restoring) { h.restoring = false; h.prev = snap; return; }
    if (h.prev && h.prev !== snap) {
      const now = Date.now();
      if (now - h.last > 700) {
        h.past.push(h.prev);
        if (h.past.length > 120) h.past.shift();
      }
      h.future = [];
      h.last = now;
      histTick((n) => n + 1);
    }
    h.prev = snap;
  }, [snap]);

  // Loading a saved quotation is not an edit: it starts a fresh history.
  useEffect(() => {
    if (!loaded) return;
    hist.current = { past: [], future: [], last: 0, prev: null, restoring: false };
    histTick((n) => n + 1);
  }, [loaded]);

  const restore = (x: Snap) => {
    hist.current.restoring = true;
    forceSync(); // the text under the caret changes: let it be rewritten
    setSubject(x.subject); setQuoteDate(x.quoteDate); setValidUntil(x.validUntil);
    setPlaceOfSupply(x.placeOfSupply); setIsInterState(x.isInterState); setDiscountText(x.discountText);
    setCompany(x.company); setClient(x.client); setIntroduction(x.introduction); setClosingText(x.closingText);
    setPreparedByName(x.preparedByName); setPreparedByDesignation(x.preparedByDesignation);
    setNotes(x.notes); setTerms(x.terms); setPaymentDetails(x.paymentDetails);
    setLayout(x.layout); setBlocks(x.blocks); setLines(x.lines); setSections(x.sections);
  };
  const travel = (dir: 'undo' | 'redo') => {
    const h = hist.current;
    const from = dir === 'undo' ? h.past : h.future;
    const to = dir === 'undo' ? h.future : h.past;
    const target = from.pop();
    if (!target) return;
    to.push(snap);
    h.last = 0;
    restore(target);
    histTick((n) => n + 1);
  };
  const travelRef = useRef(travel);
  travelRef.current = travel;

  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      const k = ev.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      const t = ev.target instanceof HTMLElement ? ev.target : null;
      // Form fields keep the browser's own per-field undo.
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (t && t !== document.body && !rootRef.current?.contains(t)) return;
      ev.preventDefault();
      travelRef.current(k === 'y' || ev.shiftKey ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A quotation that has gone out is frozen; its page is read-only.
  const liveEdit = existingQ.data && !existingQ.data.is_editable ? undefined : edit;

  const status = existingQ.data?.status ?? 'draft';

  return (
    <div className="qb-root" ref={rootRef}>
      <header className="flex items-start gap-3 flex-wrap mb-4 qdoc-screen-only">
        <div className="min-w-0">
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Workstation · Quotation</div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-0.5">Quotation Builder</h1>
          <p className="text-13 text-neutral-500 mt-1">
            {isEdit ? existingQ.data?.quotation_code ?? '' : 'The number is allocated when you save.'}
            {isEdit ? <> · <span className="capitalize">{status}</span></> : null}
          </p>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={() => travel('undo')} disabled={!hist.current.past.length || !liveEdit} className={btn} title="Undo (Ctrl+Z)"><Undo2 size={14} /></button>
          <button type="button" onClick={() => travel('redo')} disabled={!hist.current.future.length || !liveEdit} className={btn} title="Redo (Ctrl+Shift+Z)"><Redo2 size={14} /></button>
          <button type="button" onClick={printDocument} className={btn}><Printer size={14} /> Print</button>
          <button type="button" onClick={printDocument} className={btn}><Download size={14} /> Download PDF</button>
          {isEdit ? (
            <button type="button" onClick={() => navigate(`/workstation/quotations/${id}/preview`)} className={btn}>
              <Eye size={14} /> Preview
            </button>
          ) : null}
          {isEdit && status === 'draft' ? (
            <button
              type="button"
              onClick={() => quotationsApi.send(id!).then(() => navigate(`/workstation/quotations/${id}`))}
              className={btn}
            >
              <Send size={14} /> Mark sent
            </button>
          ) : null}
          <button type="button" onClick={submit} disabled={save.isPending} className={btnPrimary}>
            <Save size={14} /> {save.isPending ? 'Saving…' : 'Save draft'}
          </button>
        </div>
      </header>

      {/* Mobile: one at a time. §33 — an A4 page beside a form on a phone is
          neither an editor nor a document. */}
      <div className="md:hidden flex gap-2 mb-3 qdoc-screen-only">
        {(['edit', 'preview'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setMobileView(v)}
            className={`h-8 px-4 text-13 rounded border ${mobileView === v ? 'bg-neutral-900 text-white border-neutral-900' : 'bg-white border-neutral-300'}`}
          >
            {v === 'edit' ? 'Edit' : 'Preview'}
          </button>
        ))}
      </div>

      {save.isError && Object.keys(serverErrors).length === 0 ? (
        <div className="border-l-2 border-red pl-3 text-13 mb-3 qdoc-screen-only">
          {(save.error as { message?: string })?.message ?? 'That could not be saved.'}
        </div>
      ) : null}

      {/* Equal halves: the editor gets as much room as the document. The
          preview scales the A4 page to whatever width its half has. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
        {/* ── LEFT: the editor ─────────────────────────────────────────── */}
        <div className={`qdoc-screen-only ${mobileView === 'preview' ? 'hidden md:block' : ''}`}>
          <nav className="flex gap-x-4 border-b border-neutral-200 mb-3">
            {(['details', 'layout', 'blocks'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={
                  'h-8 flex items-center text-13 uppercase tracking-[0.06em] border-b-2 -mb-px ' +
                  (tab === t ? 'border-gold text-neutral-900 font-medium' : 'border-transparent text-neutral-500 hover:text-neutral-900')
                }
              >
                {t}
              </button>
            ))}
          </nav>

          {tab === 'details' ? (
            <DetailsTab
              {...{
                templateId, applyTemplate, templates: templatesQ.data?.items ?? [],
                partyKind, partyId, chooseParty,
                clients: clientsQ.data?.items ?? [], leads: leadsQ.data?.items ?? [],
                subject, setSubject, quoteDate, setQuoteDate, validUntil, setValidUntil,
                placeOfSupply, setPlaceOfSupply, isInterState, setIsInterState,
                discountText, setDiscountText,
                company, setCompany, client, setClient,
                introduction, setIntroduction, closingText, setClosingText,
                preparedByName, setPreparedByName, preparedByDesignation, setPreparedByDesignation,
                notes, setNotes, terms, setTerms, paymentDetails, setPaymentDetails,
                lines, setLines, sections, setSections, setBlocks, compliance, err,
              }}
            />
          ) : null}
          {tab === 'layout' ? <LayoutTab layout={layout} setLayout={setLayout} /> : null}
          {tab === 'blocks' ? <BlocksTab blocks={blocks} setBlocks={setBlocks} /> : null}
        </div>

        {/* ── RIGHT: the document ──────────────────────────────────────── */}
        <div className={mobileView === 'edit' ? 'hidden md:block' : ''}>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2 qdoc-screen-only">{liveEdit ? "Document — click any text to edit it" : "Document (read-only)"}</div>
          <PreviewPane doc={doc} edit={liveEdit} />
        </div>
      </div>
    </div>
  );
}

const btn = 'h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50';
const btnPrimary = 'h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-50';
const smallBtn = 'h-7 w-7 inline-flex items-center justify-center rounded border border-neutral-300 bg-white hover:bg-neutral-50 text-neutral-500';

/** The paper, scaled to whatever width the pane has. */
function PreviewPane({ doc, edit }: { doc: DocumentModel; edit?: QuoteEditApi }) {
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
      <QuotationDocument doc={doc} scale={scale} edit={edit} />
    </div>
  );
}

// ── DETAILS ───────────────────────────────────────────────────────────────

type DetailsProps = {
  templateId: TemplateId;
  applyTemplate: (t: TemplateId) => void;
  templates: { id: string; name: string; description: string | null }[];
  partyKind: 'client' | 'lead';
  partyId: string;
  chooseParty: (k: 'client' | 'lead', id: string) => void;
  clients: ClientListItem[];
  leads: Lead[];
  subject: string; setSubject: (v: string) => void;
  quoteDate: string; setQuoteDate: (v: string) => void;
  validUntil: string; setValidUntil: (v: string) => void;
  placeOfSupply: string; setPlaceOfSupply: (v: string) => void;
  isInterState: boolean; setIsInterState: (v: boolean) => void;
  discountText: string; setDiscountText: (v: string) => void;
  company: CompanyInfo; setCompany: (f: (c: CompanyInfo) => CompanyInfo) => void;
  client: ClientSnapshot; setClient: (f: (c: ClientSnapshot) => ClientSnapshot) => void;
  introduction: string; setIntroduction: (v: string) => void;
  closingText: string; setClosingText: (v: string) => void;
  preparedByName: string; setPreparedByName: (v: string) => void;
  preparedByDesignation: string; setPreparedByDesignation: (v: string) => void;
  notes: string; setNotes: (v: string) => void;
  terms: string; setTerms: (v: string) => void;
  paymentDetails: string; setPaymentDetails: (v: string) => void;
  lines: Line[]; setLines: (f: (l: Line[]) => Line[]) => void;
  sections: WorkSection[]; setSections: (f: (s: WorkSection[]) => WorkSection[]) => void;
  /** Space blocks are added from beside "Add service", so this tab needs them. */
  setBlocks: (f: (b: BlockSpec[]) => BlockSpec[]) => void;
  compliance: boolean;
  err: (k: string) => string | undefined;
};

function DetailsTab(p: DetailsProps) {
  return (
    <div className="space-y-3">
      <Group title="Template">
        <select
          value={p.templateId}
          onChange={(e) => p.applyTemplate(e.target.value as TemplateId)}
          className={inputClass}
        >
          {(p.templates.length ? p.templates : [{ id: 'jns-compliance', name: 'Compliance Quotation', description: null }])
            .map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <p className="text-11 text-neutral-500 mt-1">
          The template decides the document's shape. Switching it resets the block list, never your content.
        </p>
      </Group>

      <Group title="Quotation">
        <Row>
          <Field label="Client or lead" error={p.err('party')}>
            <div className="flex gap-2">
              <select
                value={p.partyKind}
                onChange={(e) => p.chooseParty(e.target.value as 'client' | 'lead', '')}
                className={`${inputClass} w-28`}
              >
                <option value="client">Client</option>
                <option value="lead">Lead</option>
              </select>
              <select
                value={p.partyId}
                onChange={(e) => p.chooseParty(p.partyKind, e.target.value)}
                className={inputClass}
              >
                <option value="">Select…</option>
                {p.partyKind === 'client'
                  ? p.clients.map((c) => <option key={c.id} value={c.id}>{c.company_name}</option>)
                  : p.leads.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          </Field>
        </Row>
        <Row>
          <Field label="Quotation date" error={p.err('quote_date')}>
            <input type="date" value={p.quoteDate} onChange={(e) => p.setQuoteDate(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Valid until" error={p.err('valid_until')}>
            <input type="date" value={p.validUntil} onChange={(e) => p.setValidUntil(e.target.value)} className={inputClass} />
          </Field>
        </Row>
        <Field label="Subject" error={p.err('subject')}>
          <input value={p.subject} onChange={(e) => p.setSubject(e.target.value)} className={inputClass}
            placeholder="Proposal for Compliance Services – Partnership Firm" />
        </Field>
      </Group>

      <Group title="Client information" hint="Shown on the document. Editing it here never touches the client's master profile.">
        <Row>
          <Field label="Name"><input value={p.client.name} onChange={(e) => p.setClient((c) => ({ ...c, name: e.target.value }))} className={inputClass} /></Field>
          <Field label="Client type"><input value={p.client.client_type} onChange={(e) => p.setClient((c) => ({ ...c, client_type: e.target.value }))} className={inputClass} placeholder="Partnership Firm" /></Field>
        </Row>
        <Row>
          <Field label="Industry"><input value={p.client.industry} onChange={(e) => p.setClient((c) => ({ ...c, industry: e.target.value }))} className={inputClass} /></Field>
          <Field label="Location"><input value={p.client.location} onChange={(e) => p.setClient((c) => ({ ...c, location: e.target.value }))} className={inputClass} /></Field>
        </Row>
        <Field label="Transactions / monthly volume">
          <input value={p.client.transactions} onChange={(e) => p.setClient((c) => ({ ...c, transactions: e.target.value }))} className={inputClass} placeholder="~150 per month" />
        </Field>
      </Group>

      <Group title="Introduction">
        <textarea rows={4} value={p.introduction} onChange={(e) => p.setIntroduction(e.target.value)} className={textareaClass} />
      </Group>

      <ServiceEditor {...p} />
      <WorkSectionEditor sections={p.sections} setSections={p.setSections} />

      {!p.compliance ? (
        <Group title="Tax">
          <Row>
            <Field label="Place of supply">
              <input value={p.placeOfSupply} onChange={(e) => p.setPlaceOfSupply(e.target.value)} className={inputClass} />
            </Field>
            <Field label="Discount (₹)">
              <input value={p.discountText} onChange={(e) => p.setDiscountText(e.target.value)} className={inputClass} inputMode="decimal" />
            </Field>
          </Row>
          <label className="flex items-center gap-2 text-13">
            <input type="checkbox" checked={p.isInterState} onChange={(e) => p.setIsInterState(e.target.checked)} className="h-4 w-4" />
            Inter-state supply (IGST)
          </label>
        </Group>
      ) : null}

      <Group title="Company header" hint="How the letterhead reads on this quotation.">
        <Field label="Company name"><input value={p.company.name} onChange={(e) => p.setCompany((c) => ({ ...c, name: e.target.value }))} className={inputClass} /></Field>
        <Row>
          <Field label="Address line 1"><input value={p.company.addressLine1} onChange={(e) => p.setCompany((c) => ({ ...c, addressLine1: e.target.value }))} className={inputClass} /></Field>
          <Field label="Address line 2"><input value={p.company.addressLine2} onChange={(e) => p.setCompany((c) => ({ ...c, addressLine2: e.target.value }))} className={inputClass} /></Field>
        </Row>
        <Row>
          <Field label="City"><input value={p.company.city} onChange={(e) => p.setCompany((c) => ({ ...c, city: e.target.value }))} className={inputClass} /></Field>
          <Field label="PIN"><input value={p.company.pin} onChange={(e) => p.setCompany((c) => ({ ...c, pin: e.target.value }))} className={inputClass} /></Field>
        </Row>
        <Row>
          <Field label="Email"><input value={p.company.email} onChange={(e) => p.setCompany((c) => ({ ...c, email: e.target.value }))} className={inputClass} /></Field>
          <Field label="Phone"><input value={p.company.phone} onChange={(e) => p.setCompany((c) => ({ ...c, phone: e.target.value }))} className={inputClass} /></Field>
        </Row>
        <Row>
          <Field label="GSTIN"><input value={p.company.gstin} onChange={(e) => p.setCompany((c) => ({ ...c, gstin: e.target.value }))} className={inputClass} /></Field>
          <Field label="Logo URL"><input value={p.company.logo} onChange={(e) => p.setCompany((c) => ({ ...c, logo: e.target.value }))} className={inputClass} /></Field>
        </Row>
      </Group>

      <Group title="Closing">
        <Field label="Closing text"><input value={p.closingText} onChange={(e) => p.setClosingText(e.target.value)} className={inputClass} /></Field>
        <Row>
          <Field label="Prepared by"><input value={p.preparedByName} onChange={(e) => p.setPreparedByName(e.target.value)} className={inputClass} /></Field>
          <Field label="Designation"><input value={p.preparedByDesignation} onChange={(e) => p.setPreparedByDesignation(e.target.value)} className={inputClass} /></Field>
        </Row>
      </Group>

      <Group title="Terms, payment and notes" hint="Each appears only if its block is enabled and it has text.">
        <Field label="Terms & conditions"><textarea rows={3} value={p.terms} onChange={(e) => p.setTerms(e.target.value)} className={textareaClass} /></Field>
        <Field label="Payment details"><textarea rows={2} value={p.paymentDetails} onChange={(e) => p.setPaymentDetails(e.target.value)} className={textareaClass} /></Field>
        <Field label="Notes"><textarea rows={2} value={p.notes} onChange={(e) => p.setNotes(e.target.value)} className={textareaClass} /></Field>
      </Group>
    </div>
  );
}

/** §10/§11 — the fee table, entirely dynamic. */
function ServiceEditor(p: DetailsProps) {
  const move = (i: number, by: number) => p.setLines((ls) => {
    const next = [...ls];
    const j = i + by;
    if (j < 0 || j >= next.length) return ls;
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  return (
    <Group title="Services" hint={p.err('items')} error={Boolean(p.err('items'))}>
      <div className="space-y-2">
        {p.lines.map((l, i) => (
          <div key={l.key} className="border border-neutral-200 rounded p-2">
            <div className="flex items-center gap-1 mb-2">
              <GripVertical size={14} className="text-neutral-400" />
              <span className="text-11 text-neutral-500">#{i + 1}</span>
              <div className="flex-1" />
              <button type="button" className={smallBtn} onClick={() => move(i, -1)} title="Move up"><ArrowUp size={13} /></button>
              <button type="button" className={smallBtn} onClick={() => move(i, 1)} title="Move down"><ArrowDown size={13} /></button>
              <button
                type="button" className={smallBtn} title="Duplicate"
                onClick={() => p.setLines((ls) => [...ls.slice(0, i + 1), { ...l, key: key() }, ...ls.slice(i + 1)])}
              >
                <Copy size={13} />
              </button>
              <button
                type="button" className={smallBtn} title="Delete"
                onClick={() => p.setLines((ls) => ls.filter((x) => x.key !== l.key))}
              >
                <Trash2 size={13} />
              </button>
            </div>
            <input
              value={l.description}
              onChange={(e) => p.setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, description: e.target.value } : x)))}
              placeholder="Particulars"
              className={inputClass}
            />
            <div className="grid grid-cols-2 gap-2 mt-2">
              <FreqInput
                value={l.frequency}
                onChange={(v) => p.setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, frequency: v } : x)))}
              />
              <input
                value={l.feeText}
                onChange={(e) => p.setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, feeText: e.target.value } : x)))}
                placeholder="Professional fee ₹"
                inputMode="decimal"
                className={inputClass}
              />
            </div>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <input
                value={l.detail}
                onChange={(e) => p.setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, detail: e.target.value } : x)))}
                placeholder="Description (optional)"
                className={inputClass}
              />
              <input
                value={l.category}
                onChange={(e) => p.setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, category: e.target.value } : x)))}
                placeholder="Category (optional)"
                className={inputClass}
              />
            </div>
            {!p.compliance ? (
              <div className="grid grid-cols-3 gap-2 mt-2">
                <input
                  value={l.qtyText}
                  onChange={(e) => p.setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, qtyText: e.target.value } : x)))}
                  placeholder="Qty" inputMode="decimal" className={inputClass}
                />
                <select
                  value={l.gstRatePercent}
                  onChange={(e) => p.setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, gstRatePercent: Number(e.target.value) } : x)))}
                  className={inputClass}
                >
                  {[0, 5, 12, 18, 28].map((r) => <option key={r} value={r}>{r}% GST</option>)}
                </select>
                <input
                  value={l.discountPercent || ''}
                  onChange={(e) => p.setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, discountPercent: Number(e.target.value) || 0 } : x)))}
                  placeholder="Disc %" inputMode="numeric" className={inputClass}
                />
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 mt-2">
        <button type="button" onClick={() => p.setLines((ls) => [...ls, newLine()])} className={btn}>
          <Plus size={14} /> Add service
        </button>
        {/*
          Space is a document block, not a table row, so it lands straight
          after the fee table rather than inside it — which is what puts the
          gap between the services and whatever follows them. Reorder and
          resize it under Blocks.
        */}
        <button
          type="button"
          className={btn}
          title="Insert blank space after the service table"
          onClick={() => p.setBlocks((bs) => {
            const at = bs.findIndex((b) => b.key === 'fee_table');
            return at < 0
              ? [...bs, makeSpace(key())]
              : [...bs.slice(0, at + 1), makeSpace(key()), ...bs.slice(at + 1)];
          })}
        >
          <Plus size={14} /> Add Space
        </button>
      </div>
    </Group>
  );
}

/** §12 — the common frequencies, and anything else the user types. */
function FreqInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list="qb-frequencies"
        placeholder="Frequency"
        className={inputClass}
      />
      <datalist id="qb-frequencies">
        {FREQUENCY_OPTIONS.map((f) => <option key={f} value={f} />)}
      </datalist>
    </>
  );
}

/** §15/§16 — Nature of Work: sections of bullets, all editable. */
function WorkSectionEditor({ sections, setSections }: {
  sections: WorkSection[];
  setSections: (f: (s: WorkSection[]) => WorkSection[]) => void;
}) {
  const patch = (k: string, p: Partial<WorkSection>) =>
    setSections((ss) => ss.map((s) => (s.key === k ? { ...s, ...p } : s)));
  const move = (i: number, by: number) => setSections((ss) => {
    const next = [...ss];
    const j = i + by;
    if (j < 0 || j >= next.length) return ss;
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  return (
    <Group title="Nature of work">
      <div className="space-y-2">
        {sections.map((s, i) => (
          <div key={s.key} className="border border-neutral-200 rounded p-2">
            <div className="flex items-center gap-1 mb-2">
              <GripVertical size={14} className="text-neutral-400" />
              <div className="flex-1" />
              <button type="button" className={smallBtn} onClick={() => move(i, -1)}><ArrowUp size={13} /></button>
              <button type="button" className={smallBtn} onClick={() => move(i, 1)}><ArrowDown size={13} /></button>
              <button type="button" className={smallBtn} onClick={() => setSections((ss) => ss.filter((x) => x.key !== s.key))}>
                <Trash2 size={13} />
              </button>
            </div>
            <input value={s.title} onChange={(e) => patch(s.key, { title: e.target.value })} placeholder="Section title" className={inputClass} />
            <div className="mt-2 space-y-1">
              {s.items.map((it, n) => (
                <div key={n} className="flex items-center gap-1">
                  <span className="text-neutral-400 text-13">•</span>
                  <input
                    value={it}
                    onChange={(e) => patch(s.key, { items: s.items.map((x, m) => (m === n ? e.target.value : x)) })}
                    className={inputClass}
                  />
                  <button
                    type="button" className={smallBtn}
                    onClick={() => patch(s.key, { items: s.items.filter((_, m) => m !== n) })}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => patch(s.key, { items: [...s.items, ''] })} className={`${btn} mt-2`}>
              <Plus size={13} /> Add point
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setSections((ss) => [...ss, { key: key(), title: '', description: '', items: [''] }])}
        className={`${btn} mt-2`}
      >
        <Plus size={14} /> Add work section
      </button>
    </Group>
  );
}

// ── LAYOUT ────────────────────────────────────────────────────────────────

function LayoutTab({ layout, setLayout }: { layout: LayoutConfig; setLayout: (f: (l: LayoutConfig) => LayoutConfig) => void }) {
  const set = <K extends keyof LayoutConfig>(k: K, v: LayoutConfig[K]) => setLayout((l) => ({ ...l, [k]: v }));
  const pick = <K extends keyof LayoutConfig>(label: string, k: K, options: [LayoutConfig[K], string][]) => (
    <Field label={label}>
      <select value={String(layout[k])} onChange={(e) => set(k, coerce(layout[k], e.target.value) as LayoutConfig[K])} className={inputClass}>
        {options.map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>)}
      </select>
    </Field>
  );

  return (
    <div className="space-y-3">
      <Group title="Page">
        <Row>
          {pick('Page size', 'pageSize', [['A4', 'A4'], ['Letter', 'Letter']])}
          {pick('Orientation', 'orientation', [['portrait', 'Portrait'], ['landscape', 'Landscape']])}
        </Row>
        <Row>
          {pick('Margins', 'margin', [['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide']])}
          {pick('Logo position', 'logoPosition', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']])}
        </Row>
      </Group>
      <Group title="Type">
        <Row>
          {pick('Font', 'font', [['sans', 'Sans'], ['serif', 'Serif']])}
          <Field label="Font size (pt)">
            <input
              type="number" step="0.5" min="8" max="14" value={layout.fontSize}
              onChange={(e) => set('fontSize', Number(e.target.value) || 10.5)}
              className={inputClass}
            />
          </Field>
        </Row>
        <Row>
          {pick('Heading size', 'headingSize', [['compact', 'Compact'], ['normal', 'Normal'], ['large', 'Large']])}
          {pick('Line spacing', 'lineHeight', [['tight', 'Tight'], ['normal', 'Normal'], ['relaxed', 'Relaxed']])}
        </Row>
      </Group>
      <Group title="Style">
        <Row>
          {pick('Table style', 'tableStyle', [['lined', 'Lined'], ['striped', 'Striped'], ['plain', 'Plain']])}
          {pick('Header style', 'headerStyle', [['rule', 'Rule'], ['bar', 'Bar'], ['plain', 'Plain']])}
        </Row>
        {pick('Footer', 'footerStyle', [['page-numbers', 'Page numbers'], ['company', 'Company name'], ['none', 'None']])}
      </Group>
    </div>
  );
}

const coerce = (current: unknown, next: string): unknown =>
  typeof current === 'number' ? Number(next) : next;

// ── BLOCKS ────────────────────────────────────────────────────────────────

/**
 * Height control for one space block: step down, type a figure, step up.
 *
 * Kept uncontrolled while the field has focus so a half-typed "1" on the way
 * to "120" is not clamped up to the 8px floor under the typist's fingers;
 * the value is clamped on blur and on every stepper press.
 */
function SpaceHeight({ value, onChange }: { value: number; onChange: (px: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(Math.round(value));
  const commit = (raw: string) => {
    const n = Number(raw);
    onChange(Number.isFinite(n) && raw.trim() !== '' ? clampSpace(n) : Math.round(value));
    setDraft(null);
  };

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button" className={smallBtn} title="Decrease height"
        disabled={value <= SPACE_MIN_PX}
        onClick={() => onChange(clampSpace(value - SPACE_STEP_PX))}
      >
        <Minus size={13} />
      </button>
      <input
        value={shown}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
        inputMode="numeric"
        aria-label={`Space height in pixels (${SPACE_MIN_PX}–${SPACE_MAX_PX})`}
        className="h-7 w-12 px-1 text-12 text-center border border-neutral-300 rounded bg-white"
      />
      <span className="text-11 text-neutral-400">px</span>
      <button
        type="button" className={smallBtn} title="Increase height"
        disabled={value >= SPACE_MAX_PX}
        onClick={() => onChange(clampSpace(value + SPACE_STEP_PX))}
      >
        <Plus size={13} />
      </button>
    </span>
  );
}

function BlocksTab({ blocks, setBlocks }: { blocks: BlockSpec[]; setBlocks: (f: (b: BlockSpec[]) => BlockSpec[]) => void }) {
  const move = (i: number, by: number) => setBlocks((bs) => {
    const next = [...bs];
    const j = i + by;
    if (j < 0 || j >= next.length) return bs;
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  /** Blank paper below a section — inserted as a block so it moves with it. */
  const addSpaceAfter = (i: number) => setBlocks((bs) => [
    ...bs.slice(0, i + 1),
    makeSpace(key()),
    ...bs.slice(i + 1),
  ]);

  return (
    <div className="space-y-3">
      <Group title="Document blocks" hint="Untick to drop a section; the arrows change where it sits on the page.">
        <ul className="space-y-1">
          {blocks.map((b, i) => (
            <li key={b.id} className="flex items-center gap-2 border border-neutral-200 rounded px-2 py-1.5">
              <input
                type="checkbox"
                checked={b.enabled}
                onChange={(e) => setBlocks((bs) => bs.map((x) => (x.id === b.id ? { ...x, enabled: e.target.checked } : x)))}
                className="h-4 w-4"
              />
              {b.key === 'spacer' ? (
                <span className="text-13 flex-1 min-w-0 flex items-center gap-2 text-neutral-500">
                  <MoveVertical size={13} /> Space
                  <SpaceHeight
                    value={spaceHeightPx(b)}
                    onChange={(px) => setBlocks((bs) => bs.map((x) => (x.id === b.id ? { ...x, heightPx: px, heightMm: undefined } : x)))}
                  />
                </span>
              ) : (
                <span className="text-13 flex-1 min-w-0">
                  {b.key === 'custom' ? (b.title || 'Custom block') : BLOCK_LABEL[b.key]}
                </span>
              )}
              <button type="button" className={smallBtn} onClick={() => move(i, -1)} title="Move up"><ArrowUp size={13} /></button>
              <button type="button" className={smallBtn} onClick={() => move(i, 1)} title="Move down"><ArrowDown size={13} /></button>
              {b.key !== 'spacer' ? (
                <button type="button" className={smallBtn} onClick={() => addSpaceAfter(i)} title="Add space below">
                  <MoveVertical size={13} />
                </button>
              ) : null}
              {b.key === 'custom' || b.key === 'spacer' ? (
                <button type="button" className={smallBtn} onClick={() => setBlocks((bs) => bs.filter((x) => x.id !== b.id))} title="Remove">
                  <Trash2 size={13} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2 mt-2">
          <button
            type="button"
            className={btn}
            onClick={() => setBlocks((bs) => [...bs, { key: 'custom', id: key(), enabled: true, title: '', body: '' }])}
          >
            <Plus size={14} /> Add custom block
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => setBlocks((bs) => [...bs, makeSpace(key())])}
          >
            <Plus size={14} /> Add Space
          </button>
        </div>
      </Group>

      {blocks.filter((b) => b.key === 'custom').map((b) => (
        <Group key={b.id} title={b.title || 'Custom block'}>
          <Field label="Heading">
            <input
              value={b.title ?? ''}
              onChange={(e) => setBlocks((bs) => bs.map((x) => (x.id === b.id ? { ...x, title: e.target.value } : x)))}
              className={inputClass}
            />
          </Field>
          <Field label="Body">
            <textarea
              rows={3}
              value={b.body ?? ''}
              onChange={(e) => setBlocks((bs) => bs.map((x) => (x.id === b.id ? { ...x, body: e.target.value } : x)))}
              className={textareaClass}
            />
          </Field>
        </Group>
      ))}
    </div>
  );
}

// ── Small pieces ──────────────────────────────────────────────────────────

function Group({ title, hint, error, children }: {
  title: string; hint?: string; error?: boolean; children: React.ReactNode;
}) {
  return (
    <section className={`bg-white border rounded ${error ? 'border-red' : 'border-neutral-200'}`}>
      <div className="h-9 px-3 flex items-center border-b border-neutral-200">
        <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">{title}</span>
      </div>
      <div className="p-3">
        {hint ? <p className={`text-11 mb-2 ${error ? 'text-red' : 'text-neutral-500'}`}>{hint}</p> : null}
        {children}
      </div>
    </section>
  );
}

const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="grid grid-cols-2 gap-2">{children}</div>
);

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="block mb-2 last:mb-0">
      <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">{label}</span>
      {children}
      {error ? <span className="block text-11 text-red mt-1">{error}</span> : null}
    </label>
  );
}
