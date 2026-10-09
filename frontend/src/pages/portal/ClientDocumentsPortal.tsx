import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type React from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowDown, ArrowUp, CalendarDays, CheckCircle2, ChevronRight, ClipboardList, Download, ExternalLink,
  FileArchive, FileImage, FileSignature, FileSpreadsheet, FileText, FolderClosed, Inbox,
  Landmark, Layers, Loader2, Lock, Menu, Receipt, ReceiptText, Search, ScrollText, Truck, X,
} from 'lucide-react';
import { workstationApi } from '@/modules/workstation/api';
import type { ClientPortalDocuments } from '@/modules/workstation/types';
import type { ApiError } from '@/services/api';
import { fmtDate, fmtTime, inr } from '@/lib/format';
import { PORTAL_EXTRAS_CSS, PortalJobStatusSection, PortalRequestsSection } from './PortalRequests';

/**
 * The client's own Documents page, opened from the link the firm sends.
 * No login: the token in the URL is the authorization, and the firm can turn
 * it off. It re-reads the documents every 30 seconds and on focus, so it is
 * always the live view — never a file that goes stale.
 *
 * This page is the firm's face to its client, so it carries its own scoped
 * stylesheet (`xp-` classes, below) instead of the app's Tailwind theme,
 * which replaces spacing, radii and colours for the staff UI. Always light:
 * each folder kind keeps one colour (HUES) wherever it appears.
 */

type Data = ClientPortalDocuments;
type PortalFolder = Data['folders'][number];
type PortalItem = PortalFolder['items'][number];
type Row = { folder: PortalFolder; item: PortalItem };
type SortKey = 'title' | 'folder' | 'date' | 'amount' | 'status';
type Avail = 'all' | 'ready' | 'awaiting';

const GROUPS: { key: PortalFolder['group']; label: string }[] = [
  { key: 'compliance', label: 'Compliance' },
  { key: 'billing', label: 'Billing & letters' },
  { key: 'uploads', label: 'Your documents' },
  { key: 'imports', label: 'Imported files' },
];

const LIVE_REFRESH_MS = 30_000;

const hasFile = (i: PortalItem) => i.openable === 'pdf' || i.openable === 'file';
const awaiting = (i: PortalItem) => !hasFile(i) && ['requested', 'pending', 'rejected', 'expired'].includes(i.status ?? '');
const initials = (s: string) => s.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '·';
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const human = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Indian financial year of an ISO date: Apr–Mar. */
function fyOf(iso: string | null): string | null {
  if (!iso) return null;
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  if (!y || !m) return null;
  const start = m >= 4 ? y : y - 1;
  return `FY ${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Each folder kind has its own colour, used everywhere that folder appears. */
const HUES: Record<string, [string, string]> = {
  eway: ['#0284c7', '#e0f2fe'],
  einvoice: ['#7c3aed', '#ede9fe'],
  gst_returns: ['#059669', '#d1fae5'],
  invoices: ['#d97706', '#fef3c7'],
  quotations: ['#db2777', '#fce7f3'],
  engagement_letters: ['#4f46e5', '#e0e7ff'],
  letters_agreements: ['#0d9488', '#ccfbf1'],
};
const UPLOAD_HUES: [string, string][] = [['#ea580c', '#ffedd5'], ['#e11d48', '#ffe4e6'], ['#2563eb', '#dbeafe'], ['#65a30d', '#ecfccb'], ['#c026d3', '#fae8ff'], ['#0891b2', '#cffafe']];
function hue(key: string): React.CSSProperties {
  let pair = HUES[key];
  if (!pair) {
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    pair = UPLOAD_HUES[h % UPLOAD_HUES.length];
  }
  return { '--c': pair[0], '--cb': pair[1] } as React.CSSProperties;
}

function folderIcon(key: string, size = 15) {
  const p = { size, strokeWidth: 1.75 };
  switch (key) {
    case 'eway': return <Truck {...p} />;
    case 'einvoice': return <ReceiptText {...p} />;
    case 'gst_returns': return <Landmark {...p} />;
    case 'invoices': return <Receipt {...p} />;
    case 'quotations': return <ClipboardList {...p} />;
    case 'engagement_letters': return <FileSignature {...p} />;
    case 'letters_agreements': return <ScrollText {...p} />;
    default: return <FolderClosed {...p} />;
  }
}

function extOf(i: PortalItem): string {
  if (i.openable === 'pdf') return 'pdf';
  const name = (i.file_name ?? i.title).toLowerCase();
  return name.includes('.') ? name.split('.').pop()! : '';
}
function fileKind(i: PortalItem): { cls: string; icon: ReactNode; label: string } {
  const ext = extOf(i);
  if (ext === 'pdf') return { cls: 'k-pdf', icon: <FileText size={14} strokeWidth={1.75} />, label: 'PDF' };
  if (['xls', 'xlsx', 'csv'].includes(ext)) return { cls: 'k-sheet', icon: <FileSpreadsheet size={14} strokeWidth={1.75} />, label: ext.toUpperCase() };
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return { cls: 'k-img', icon: <FileImage size={14} strokeWidth={1.75} />, label: ext.toUpperCase() };
  if (ext === 'zip') return { cls: 'k-zip', icon: <FileArchive size={14} strokeWidth={1.75} />, label: 'ZIP' };
  return { cls: 'k-doc', icon: <FileText size={14} strokeWidth={1.75} />, label: ext ? ext.toUpperCase() : 'DOC' };
}

function tone(s: string): 'ok' | 'warn' | 'bad' | 'info' | 'mute' {
  if (['verified', 'filed', 'paid', 'accepted', 'signed', 'active', 'reported', 'generated', 'approved', 'completed'].includes(s)) return 'ok';
  if (['requested', 'pending', 'under_review', 'sent', 'partially_paid', 'data_preparation', 'in_progress'].includes(s)) return 'warn';
  if (['rejected', 'cancelled', 'expired', 'overdue', 'void', 'declined'].includes(s)) return 'bad';
  if (['uploaded', 'issued'].includes(s)) return 'info';
  return 'mute';
}

/** Save a URL's response as a file, with progress state and a real error. */
async function saveFrom(url: string, fallbackName: string) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) {
    const j = await res.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(j?.error?.message ?? `Download failed (HTTP ${res.status}).`);
  }
  const cd = res.headers.get('Content-Disposition') ?? '';
  const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(cd)?.[1] ?? '') || /filename="([^"]+)"/.exec(cd)?.[1] || fallbackName;
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}

export function ClientDocumentsPortalPage() {
  const { token = '' } = useParams();
  // Only the first load counts as a visit; the polls after it do not.
  const visited = useRef(false);
  const query = useQuery({
    queryKey: ['client-portal', token],
    queryFn: () => {
      const first = !visited.current;
      visited.current = true;
      return workstationApi.clientPortal(token, first);
    },
    refetchInterval: LIVE_REFRESH_MS,
    refetchOnWindowFocus: true,
    retry: (n, e) => ((e as ApiError).status ?? 0) >= 500 && n < 2,
  });
  const [view, setView] = useState<string>('all');
  const [q, setQ] = useState('');
  const [preview, setPreview] = useState<Row | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (query.data) document.title = `${query.data.client.name} · Documents`;
  }, [query.data]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const fileUrl = useCallback((i: PortalItem, download = false) => workstationApi.clientPortalFileUrl(token, i.source, i.id, download), [token]);

  if (query.isError && !query.data) {
    const err = query.error as ApiError;
    const dead = err.status === 410 || err.status === 404;
    return (
      <Frame>
        <div className="xp-center">
          <div className="xp-state">
            <div className="xp-state-icon"><Lock size={18} /></div>
            <h1>{err.code === 'link_paused' ? 'This link is turned off for now' : err.code === 'link_revoked' ? 'This link has been replaced' : err.status === 404 ? 'This link is not valid' : 'Could not load your documents'}</h1>
            <p>{err.code === 'link_paused' ? 'Ask your accountant to turn it back on — this same link will work again.' : dead ? 'Ask your accountant to send you the new link.' : 'Check your connection and try again.'}</p>
            {!dead ? <button type="button" className="xp-btn is-solid" onClick={() => void query.refetch()}>Try again</button> : null}
          </div>
        </div>
      </Frame>
    );
  }
  if (!query.data) return <Frame><Skeleton /></Frame>;

  const data = query.data;
  const folder = data.folders.find((f) => f.key === view) ?? null;
  const go = (key: string) => { setView(key); setQ(''); setNavOpen(false); window.scrollTo({ top: 0 }); };
  const firm = data.firm ?? 'Your accountant';
  const readyHere = (folder ? folder.items : data.folders.flatMap((f) => f.items)).filter(hasFile).length;

  async function zip() {
    setZipping(true);
    try {
      await saveFrom(workstationApi.clientPortalZipUrl(token, folder?.key), 'documents.zip');
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setZipping(false);
    }
  }

  return (
    <Frame>
      <div className="xp-app">
        {navOpen ? <div className="xp-scrim" onClick={() => setNavOpen(false)} aria-hidden /> : null}

        {/* ── Sidebar ─────────────────────────────────────────── */}
        <aside className={`xp-side ${navOpen ? 'is-open' : ''}`}>
          <div className="xp-org">
            <div className="xp-org-mark">{initials(firm)}</div>
            <div className="xp-org-text">
              <div className="xp-org-name">{firm}</div>
              <div className="xp-org-sub">Client portal</div>
            </div>
            <button type="button" className="xp-icon-btn xp-side-close" aria-label="Close menu" onClick={() => setNavOpen(false)}><X size={16} /></button>
          </div>

          <div className="xp-acct">
            <div className="xp-acct-av">{initials(data.client.name)}</div>
            <div className="xp-acct-text">
              <div className="xp-acct-name">{data.client.name}</div>
              <div className="xp-acct-sub">{data.client.code}</div>
            </div>
          </div>

          <nav className="xp-nav">
            <NavItem active={view === 'all'} onClick={() => go('all')} icon={<Layers size={15} strokeWidth={1.75} />} label="All documents" count={data.total} />
            {GROUPS.map((g) => {
              const fs = data.folders.filter((f) => f.group === g.key);
              if (fs.length === 0) return null;
              return (
                <div key={g.key} className="xp-nav-group">
                  <div className="xp-nav-label">{g.label}</div>
                  {fs.map((f) => (
                    <NavItem key={f.key} active={view === f.key} onClick={() => go(f.key)} icon={folderIcon(f.key)} label={f.label} count={f.count} colorKey={f.key} />
                  ))}
                </div>
              );
            })}
          </nav>

          <div className="xp-side-foot">
            <Lock size={12} strokeWidth={2} />
            <span>Private link from {firm}</span>
          </div>
        </aside>

        {/* ── Main ────────────────────────────────────────────── */}
        <div className="xp-main">
          <header className="xp-top">
            <button type="button" className="xp-icon-btn xp-menu" aria-label="Open menu" onClick={() => setNavOpen(true)}><Menu size={17} /></button>
            <div className="xp-crumbs">
              <button type="button" onClick={() => go('all')}>Documents</button>
              {folder ? <><ChevronRight size={13} /><span>{folder.label}</span></> : null}
            </div>
            <div className="xp-top-right">
              <label className="xp-search">
                <Search size={14} />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search documents" />
                {q ? <button type="button" aria-label="Clear search" onClick={() => setQ('')}><X size={13} /></button> : <kbd>/</kbd>}
              </label>
              <button type="button" className="xp-live" onClick={() => void query.refetch()} title="Updates automatically. Click to refresh now.">
                <span className={`xp-live-dot ${query.isFetching ? 'is-busy' : ''}`} />
                <span className="xp-hide-s">Synced {fmtTime(data.generated_at)}</span>
              </button>
            </div>
          </header>

          <main className="xp-content">
            <PageHeader
              data={data}
              folder={folder}
              firm={firm}
              action={readyHere > 0 ? (
                <button type="button" className="xp-btn is-solid" onClick={() => void zip()} disabled={zipping}>
                  {zipping ? <Loader2 size={14} className="xp-spin" /> : <Download size={14} />}
                  {zipping ? 'Preparing…' : folder ? 'Download folder' : 'Download all'}
                </button>
              ) : null}
            />

            {!folder ? <Stats data={data} /> : null}
            {/* What the firm is waiting for — the client uploads straight into each request. */}
            {!folder ? <PortalRequestsSection token={token} onUploaded={() => void query.refetch()} onMessage={setToast} /> : null}
            {!folder ? <PortalJobStatusSection token={token} /> : null}

            <DocTable
              key={view}
              rows={(folder ? [folder] : data.folders).flatMap((f) => f.items.map((item) => ({ folder: f, item })))}
              showFolder={!folder}
              q={q}
              fileUrl={fileUrl}
              onOpen={setPreview}
            />
          </main>

          <footer className="xp-foot">
            <span>Shared by {firm}</span>
            <span>Live view · refreshes every 30 seconds</span>
          </footer>
        </div>

        {preview ? <PreviewPanel row={preview} fileUrl={fileUrl} onClose={() => setPreview(null)} onError={setToast} /> : null}
        {toast ? <div className="xp-toast" role="status"><AlertTriangle size={14} />{toast}</div> : null}
      </div>
    </Frame>
  );
}

// ── Header & summary ─────────────────────────────────────────────────────
function PageHeader({ data, folder, firm, action }: { data: Data; folder: PortalFolder | null; firm: string; action: ReactNode }) {
  return (
    <div className={`xp-head ${folder ? '' : 'is-hero'}`} style={folder ? hue(folder.key) : undefined}>
      <div className="xp-head-text">
        {folder ? (
          <div className="xp-head-title">
            <span className="xp-head-icon" style={hue(folder.key)}>{folderIcon(folder.key, 18)}</span>
            <h1>{folder.label}</h1>
          </div>
        ) : (
          <div className="xp-head-title">
            <span className="xp-head-av">{initials(data.client.name)}</span>
            <h1>{data.client.name}</h1>
          </div>
        )}
        <div className="xp-meta">
          {folder ? (
            <>
              <span>{plural(folder.count, 'document')}</span>
              <span>{GROUPS.find((g) => g.key === folder.group)?.label}</span>
            </>
          ) : (
            <>
              <span><em>Client</em>{data.client.code}</span>
              {data.client.gstin ? <span><em>GSTIN</em><code>{data.client.gstin}</code></span> : null}
              <span><em>Prepared by</em>{firm}</span>
            </>
          )}
        </div>
      </div>
      {action}
    </div>
  );
}

function Stats({ data }: { data: Data }) {
  const all = data.folders.flatMap((f) => f.items);
  const ready = all.filter(hasFile).length;
  const waiting = all.filter(awaiting).length;
  const latest = all.map((i) => i.date).filter(Boolean).sort().pop() ?? null;
  const pct = data.total ? Math.round((ready / data.total) * 100) : 0;
  return (
    <div className="xp-stats">
      <Stat c="indigo" icon={<Layers size={16} />} label="Documents" value={String(data.total)} sub={plural(data.folders.length, 'folder')} />
      <Stat c="green" icon={<CheckCircle2 size={16} />} label="Available to download" value={String(ready)} sub={<span className="xp-meter"><span className="xp-meter-track"><i style={{ width: `${pct}%` }} /></span>{pct}%</span>} />
      <Stat c="amber" icon={<AlertTriangle size={16} />} label="Needed from you" value={String(waiting)} sub={waiting ? 'Action required' : 'Nothing outstanding'} />
      <Stat c="pink" icon={<CalendarDays size={16} />} label="Most recent" value={latest ? fmtDate(latest) : '—'} sub={latest ? fyOf(latest) ?? '' : 'No dated documents'} />
    </div>
  );
}

function Stat({ c, icon, label, value, sub }: { c: 'indigo' | 'green' | 'amber' | 'pink'; icon: ReactNode; label: string; value: string; sub: ReactNode }) {
  return (
    <div className={`xp-stat s-${c}`}>
      <div className="xp-stat-top"><span className="xp-stat-icon">{icon}</span><span className="xp-stat-label">{label}</span></div>
      <div className="xp-stat-value">{value}</div>
      <div className="xp-stat-sub">{sub}</div>
    </div>
  );
}

// ── The table ────────────────────────────────────────────────────────────
function DocTable({
  rows, showFolder, q, fileUrl, onOpen,
}: {
  rows: Row[];
  showFolder: boolean;
  q: string;
  fileUrl: (i: PortalItem, download?: boolean) => string;
  onOpen: (r: Row) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'date', dir: -1 });
  const [fy, setFy] = useState<string>('all');
  const [avail, setAvail] = useState<Avail>('all');

  const years = useMemo(() => [...new Set(rows.map((r) => fyOf(r.item.date)).filter(Boolean) as string[])].sort().reverse(), [rows]);
  const counts = useMemo(() => ({
    all: rows.length, ready: rows.filter((r) => hasFile(r.item)).length, awaiting: rows.filter((r) => awaiting(r.item)).length,
  }), [rows]);

  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => {
    const val = (r: Row): string | number => {
      switch (sort.key) {
        case 'title': return r.item.title.toLowerCase();
        case 'folder': return r.folder.label.toLowerCase();
        case 'amount': return r.item.amount_paise ?? -1;
        case 'status': return r.item.status ?? '';
        default: return r.item.date ?? '';
      }
    };
    return rows
      .filter((r) => !needle || matches(r, needle))
      .filter((r) => fy === 'all' || fyOf(r.item.date) === fy)
      .filter((r) => avail === 'all' || (avail === 'ready' ? hasFile(r.item) : awaiting(r.item)))
      .sort((a, b) => { const x = val(a); const y = val(b); return x < y ? -sort.dir : x > y ? sort.dir : 0; });
  }, [rows, needle, fy, avail, sort]);

  const th = (key: SortKey, label: string, cls = '') => (
    <button
      type="button"
      className={`xp-th ${cls} ${sort.key === key ? 'is-sorted' : ''}`}
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'date' || key === 'amount' ? -1 : 1 }))}
    >
      {label}
      {sort.key === key ? (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />) : null}
    </button>
  );

  return (
    <section className="xp-card">
      <div className="xp-toolbar">
        <div className="xp-seg" role="tablist">
          {(['all', 'ready', 'awaiting'] as Avail[]).map((a) => (
            <button key={a} type="button" role="tab" aria-selected={avail === a} className={`seg-${a} ${avail === a ? 'is-on' : ''}`} onClick={() => setAvail(a)}>
              {a === 'all' ? 'All' : a === 'ready' ? 'Available' : 'Needed'}<span>{counts[a]}</span>
            </button>
          ))}
        </div>
        <div className="xp-toolbar-right">
          {needle ? <span className="xp-result">{plural(shown.length, 'result')}</span> : null}
          {years.length > 1 ? (
            <label className="xp-select">
              <select value={fy} onChange={(e) => setFy(e.target.value)} aria-label="Financial year">
                <option value="all">All years</option>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </label>
          ) : null}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="xp-empty">
          <Inbox size={20} strokeWidth={1.5} />
          <b>{needle ? 'No matching documents' : rows.length === 0 ? 'No documents yet' : 'Nothing here'}</b>
          <span>{needle ? 'Try a document number, a party or a month.' : rows.length === 0 ? 'Documents appear here as soon as they are added.' : 'Try a different filter.'}</span>
        </div>
      ) : (
        <div className={`xp-table ${showFolder ? 'has-folder' : ''}`} role="table">
          <div className="xp-tr xp-thead" role="row">
            {th('title', 'Name')}
            {showFolder ? th('folder', 'Folder', 'xp-hide-m') : null}
            {th('date', 'Date', 'xp-hide-m')}
            {th('amount', 'Amount', 'is-num xp-hide-m')}
            {th('status', 'Status', 'xp-hide-s')}
            <span />
          </div>
          {shown.map((r) => {
            const { item, folder } = r;
            const k = fileKind(item);
            return (
              <div
                key={`${item.source}:${item.id}`}
                role="row"
                tabIndex={0}
                className="xp-tr"
                onClick={() => onOpen(r)}
                onKeyDown={(e) => { if (e.key === 'Enter') onOpen(r); }}
              >
                <div className="xp-name">
                  <span className={`xp-kind ${k.cls}`} title={k.label}>{k.icon}</span>
                  <div className="xp-name-text">
                    <div className="xp-name-title">{item.title}</div>
                    <div className="xp-name-sub">
                      <span className="xp-hide-m">{[item.subtitle, item.file_name].filter(Boolean).join(' · ') || ' '}</span>
                      <span className="xp-only-m">
                        {[showFolder ? folder.label : null, item.date ? fmtDate(item.date) : null,
                          item.amount_paise != null ? inr(item.amount_paise) : null].filter(Boolean).join(' · ') || item.subtitle}
                      </span>
                    </div>
                  </div>
                </div>
                {showFolder ? <div className="xp-td xp-hide-m"><span className="xp-ftag" style={hue(folder.key)}>{folderIcon(folder.key, 12)}{folder.label}</span></div> : null}
                <div className="xp-td xp-hide-m xp-dim xp-num-font">{item.date ? fmtDate(item.date) : '—'}</div>
                <div className="xp-td xp-hide-m is-num xp-num-font">{item.amount_paise != null ? inr(item.amount_paise) : <span className="xp-dim">—</span>}</div>
                <div className="xp-td xp-hide-s"><Pill status={item.status} /></div>
                <div className="xp-td xp-row-actions" onClick={(e) => e.stopPropagation()}>
                  {hasFile(item) ? (
                    <>
                      <a className="xp-icon-btn" href={fileUrl(item)} target="_blank" rel="noopener" title="Open in new tab" aria-label={`Open ${item.title}`}><ExternalLink size={14} /></a>
                      <a className="xp-icon-btn is-strong" href={fileUrl(item, true)} title="Download" aria-label={`Download ${item.title}`}><Download size={14} /></a>
                    </>
                  ) : awaiting(item) ? <span className="xp-needed">Needed</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── Preview panel ────────────────────────────────────────────────────────
function PreviewPanel({ row, fileUrl, onClose, onError }: { row: Row; fileUrl: (i: PortalItem, download?: boolean) => string; onClose: () => void; onError: (m: string) => void }) {
  const { item, folder } = row;
  const ext = extOf(item);
  const k = fileKind(item);
  const canFrame = hasFile(item) && ext === 'pdf';
  const isImg = hasFile(item) && ['png', 'jpg', 'jpeg', 'webp'].includes(ext);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  async function download() {
    setSaving(true);
    try { await saveFrom(fileUrl(item, true), item.file_name ?? `${item.title}.${ext || 'pdf'}`); }
    catch (e) { onError((e as Error).message); }
    finally { setSaving(false); }
  }

  const facts: [string, ReactNode][] = [
    ['Folder', folder.label],
    ...(item.date ? [['Date', fmtDate(item.date)] as [string, ReactNode]] : []),
    ...(item.amount_paise != null ? [['Amount', inr(item.amount_paise)] as [string, ReactNode]] : []),
    ...(item.status ? [['Status', <Pill key="s" status={item.status} />] as [string, ReactNode]] : []),
    ...(item.file_name ? [['File', item.file_name] as [string, ReactNode]] : []),
    ...((item.fields ?? []).filter(([l]) => l !== 'Status').map(([l, v]) => [l, v] as [string, ReactNode])),
  ];

  return (
    <div className="xp-panel-wrap" role="dialog" aria-modal="true" aria-label={item.title}>
      <div className="xp-scrim is-panel" onClick={onClose} aria-hidden />
      <aside className="xp-panel">
        <div className="xp-panel-head">
          <span className={`xp-kind is-lg ${k.cls}`}>{k.icon}</span>
          <div className="xp-panel-title">
            <h2>{item.title}</h2>
            <p>{[item.subtitle, folder.label].filter(Boolean).join(' · ')}</p>
          </div>
          <button type="button" className="xp-icon-btn" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </div>

        {hasFile(item) ? (
          <div className="xp-panel-actions">
            <button type="button" className="xp-btn is-solid" onClick={() => void download()} disabled={saving}>
              {saving ? <Loader2 size={14} className="xp-spin" /> : <Download size={14} />}Download
            </button>
            <a className="xp-btn" href={fileUrl(item)} target="_blank" rel="noopener"><ExternalLink size={14} />Open in new tab</a>
          </div>
        ) : null}

        <div className="xp-panel-body">
          {canFrame ? (
            <div className="xp-viewer"><iframe title={item.title} src={`${fileUrl(item)}#view=FitH&toolbar=0`} /></div>
          ) : isImg ? (
            <div className="xp-viewer is-img"><img src={fileUrl(item)} alt={item.title} /></div>
          ) : hasFile(item) ? (
            <div className="xp-noview">
              <span className={`xp-kind is-xl ${k.cls}`}>{k.icon}</span>
              <b>{k.label} file</b>
              <span>This file type cannot be previewed here. Download it to open it.</span>
            </div>
          ) : (
            <div className={`xp-noview ${awaiting(item) ? 'is-warn' : ''}`}>
              <AlertTriangle size={20} strokeWidth={1.75} />
              <b>{awaiting(item) ? 'Needed from you' : 'Not available online'}</b>
              <span>{awaiting(item) ? 'Your accountant has asked for this document. Please send it to them.' : 'Ask your accountant for a copy of this document.'}</span>
            </div>
          )}

          <dl className="xp-facts">
            {facts.map(([l, v]) => <div key={l}><dt>{l}</dt><dd>{v}</dd></div>)}
          </dl>
        </div>
      </aside>
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────
function Pill({ status }: { status: string | null }) {
  if (!status) return <span className="xp-dim">—</span>;
  return <span className={`xp-pill t-${tone(status)}`}><i />{human(status)}</span>;
}

function NavItem({ active, onClick, icon, label, count, colorKey }: { active: boolean; onClick: () => void; icon: ReactNode; label: string; count: number; colorKey?: string }) {
  return (
    <button type="button" onClick={onClick} style={colorKey ? hue(colorKey) : undefined} className={`xp-nav-item ${active ? 'is-active' : ''}`} title={label} aria-current={active ? 'page' : undefined}>
      <span className="xp-nav-icon">{icon}</span>
      <span className="xp-nav-text">{label}</span>
      <span className="xp-nav-count">{count}</span>
    </button>
  );
}

function Skeleton() {
  return (
    <div className="xp-app">
      <aside className="xp-side xp-hide-nav"><div className="xp-org"><div className="xp-org-mark xp-shimmer" /></div></aside>
      <div className="xp-main">
        <main className="xp-content">
          <div className="xp-shimmer" style={{ height: 28, width: 280, borderRadius: 6, marginBottom: 10 }} />
          <div className="xp-shimmer" style={{ height: 14, width: 360, borderRadius: 6, marginBottom: 28 }} />
          <div className="xp-shimmer" style={{ height: 96, borderRadius: 12, marginBottom: 20 }} />
          <div className="xp-shimmer" style={{ height: 420, borderRadius: 12 }} />
        </main>
      </div>
    </div>
  );
}

function matches(r: Row, needle: string): boolean {
  const i = r.item;
  return [i.title, i.subtitle, i.file_name, i.status, r.folder.label, ...(i.fields?.map((f) => f[1]) ?? [])]
    .some((v) => v?.toLowerCase().includes(needle));
}

/** Root wrapper: carries the scoped stylesheet and the "/" search shortcut. */
function Frame({ children }: { children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || (e.target as HTMLElement).closest('input, textarea, select')) return;
      const input = document.querySelector<HTMLInputElement>('.xp-search input');
      if (input) { e.preventDefault(); input.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="xp-root">
      <style>{CSS + PORTAL_EXTRAS_CSS}</style>
      {children}
    </div>
  );
}

const CSS = `
.xp-root{
  --bg:#f6f7fb;--surface:#fff;--surface-2:#f6f6f7;--hover:#f4f4f5;--line:#e9e9ec;--line-2:#f1f1f3;
  --ink:#0b0b0f;--ink-2:#3f3f46;--mute:#71717a;--faint:#a1a1aa;
  --accent:#4f46e5;--accent-bg:#eef2ff;--accent-ring:rgba(79,70,229,.18);--grad:linear-gradient(135deg,#4f46e5 0%,#7c3aed 55%,#db2777 100%);
  --ok:#047857;--ok-bg:#ecfdf5;--ok-line:#a7f3d0;--warn:#b45309;--warn-bg:#fffbeb;--warn-line:#fde68a;
  --bad:#b91c1c;--bad-bg:#fef2f2;--bad-line:#fecaca;--info:#1d4ed8;--info-bg:#eff6ff;--info-line:#bfdbfe;
  --side:#fff;--shadow:0 1px 2px rgba(0,0,0,.04);--shadow-pop:0 16px 48px -12px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.04);
  --solid:#18181b;--solid-ink:#fff;
  font-family:'Inter Variable',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:13px;line-height:1.5;
  color:var(--ink);background:var(--bg);min-height:100vh;font-feature-settings:'cv11','ss01';-webkit-font-smoothing:antialiased;color-scheme:light}
:where(.xp-root) *{box-sizing:border-box}
:where(.xp-root) :where(h1,h2,h3){margin:0;font-weight:600;letter-spacing:-.02em}
:where(.xp-root) :where(p,dl,dd){margin:0}
:where(.xp-root) button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;padding:0}
:where(.xp-root) a{color:inherit;text-decoration:none}
:where(.xp-root) code{font-family:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.xp-num-font{font-variant-numeric:tabular-nums}
.xp-dim{color:var(--mute)}
.xp-root :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}

.xp-app{display:flex;min-height:100vh}
.xp-main{flex:1;min-width:0;display:flex;flex-direction:column}
.xp-content{flex:1;width:100%;max-width:1200px;margin:0 auto;padding:32px 40px 40px}

/* Sidebar */
.xp-side{width:256px;flex-shrink:0;position:sticky;top:0;height:100vh;display:flex;flex-direction:column;background:var(--side);border-right:1px solid var(--line);overflow-y:auto;z-index:40;scrollbar-width:thin}
.xp-org{display:flex;align-items:center;gap:10px;padding:16px 16px 12px}
.xp-org-mark{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;flex-shrink:0;background:var(--grad);color:#fff;box-shadow:0 6px 14px -6px rgba(124,58,237,.6);font-size:11px;font-weight:700;letter-spacing:.02em}
.xp-org-text{min-width:0;flex:1}
.xp-org-name{font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xp-org-sub{font-size:11.5px;color:var(--mute)}
.xp-icon-btn.xp-side-close{display:none}
.xp-acct{display:flex;align-items:center;gap:10px;margin:4px 12px 8px;padding:10px;border:1px solid #e0e7ff;border-radius:12px;background:linear-gradient(135deg,#eef2ff,#fdf2f8)}
.xp-acct-av{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;flex-shrink:0;background:var(--grad);color:#fff;font-size:11px;font-weight:600}
.xp-acct-text{min-width:0}
.xp-acct-name{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xp-acct-sub{font-size:11.5px;color:var(--mute)}
.xp-nav{flex:1;padding:6px 8px 12px}
.xp-nav-group{margin-top:14px}
.xp-nav-label{padding:0 10px 4px;font-size:11px;font-weight:500;color:var(--faint)}
.xp-nav-item{display:flex;align-items:center;gap:10px;width:100%;height:36px;padding:0 10px;border-radius:7px;color:var(--ink-2);text-align:left;transition:background .1s,color .1s}
.xp-nav-item:hover{background:var(--hover);color:var(--ink)}
.xp-nav-item.is-active{background:var(--cb,var(--accent-bg));color:var(--c,var(--accent));font-weight:600;box-shadow:inset 3px 0 0 var(--c,var(--accent))}
.xp-nav-item.is-active .xp-nav-count{color:var(--c,var(--accent));background:#fff;border-radius:99px;padding:0 7px}
.xp-nav-icon{width:24px;height:24px;border-radius:7px;display:grid;place-items:center;flex-shrink:0;color:var(--c,var(--accent));background:var(--cb,var(--accent-bg))}
.xp-nav-text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xp-nav-count{font-size:11.5px;color:var(--faint);font-variant-numeric:tabular-nums}
.xp-side-foot{display:flex;align-items:center;gap:7px;padding:12px 18px;border-top:1px solid var(--line);font-size:11.5px;color:var(--mute)}

/* Top bar */
.xp-top{position:sticky;top:0;z-index:20;height:52px;display:flex;align-items:center;gap:12px;padding:0 24px;border-bottom:1px solid var(--line);
  background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:saturate(180%) blur(12px);-webkit-backdrop-filter:saturate(180%) blur(12px)}
.xp-icon-btn.xp-menu{display:none}
.xp-crumbs{display:flex;align-items:center;gap:6px;color:var(--mute);min-width:0;white-space:nowrap}
.xp-crumbs button:hover{color:var(--ink)}
.xp-crumbs span{color:var(--ink);font-weight:500;overflow:hidden;text-overflow:ellipsis}
.xp-crumbs svg{color:var(--faint);flex-shrink:0}
.xp-top-right{margin-left:auto;display:flex;align-items:center;gap:8px}
.xp-search{display:flex;align-items:center;gap:8px;height:32px;width:260px;padding:0 8px 0 10px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--faint);transition:border-color .12s,box-shadow .12s}
.xp-search:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-ring)}
.xp-search input{flex:1;min-width:0;height:100%;border:0!important;outline:0!important;box-shadow:none!important;background:transparent!important;font:inherit;color:var(--ink);padding:0}
.xp-search input::placeholder{color:var(--faint)}
.xp-search kbd{font:500 11px/1 'Inter Variable',sans-serif;color:var(--mute);border:1px solid var(--line);border-radius:4px;padding:2px 5px;background:var(--surface-2)}
.xp-search button{color:var(--mute);display:grid;place-items:center}
.xp-live{display:flex;align-items:center;gap:7px;height:32px;padding:0 12px;border-radius:99px;background:#ecfdf5!important;color:#047857;font-weight:500;border:1px solid #a7f3d0!important;font-size:12px;white-space:nowrap}
.xp-live:hover{background:var(--hover);color:var(--ink)}
.xp-live-dot{width:7px;height:7px;border-radius:50%;background:#10b981;box-shadow:0 0 0 3px rgba(16,185,129,.18)}
.xp-live-dot.is-busy{animation:xp-blink 1s ease-in-out infinite}
@keyframes xp-blink{50%{opacity:.35}}

/* Buttons */
.xp-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:32px;padding:0 12px;border-radius:8px;font-weight:500;white-space:nowrap;
  border:1px solid var(--line)!important;background:var(--surface)!important;color:var(--ink)!important;box-shadow:var(--shadow);transition:background .12s,border-color .12s,opacity .12s}
.xp-btn:hover{background:var(--hover)!important}
.xp-btn.is-solid{background:var(--grad)!important;color:#fff!important;border-color:transparent!important;box-shadow:0 8px 18px -8px rgba(124,58,237,.7)}
.xp-btn.is-solid:hover{opacity:.88}
.xp-btn:disabled{opacity:.6;cursor:default}
.xp-icon-btn{width:30px;height:30px;border-radius:7px;display:inline-grid;place-items:center;color:var(--mute);transition:background .1s,color .1s}
.xp-icon-btn:hover{background:var(--hover);color:var(--ink)}
.xp-icon-btn.is-strong{color:#7c3aed}
.xp-row-actions .xp-icon-btn:hover{background:#f5f3ff;color:#7c3aed}
.xp-spin{animation:xp-rot .8s linear infinite}
@keyframes xp-rot{to{transform:rotate(360deg)}}

/* Page header */
.xp-head{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:24px;flex-wrap:wrap}
.xp-head-text{min-width:0}
.xp-head h1{font-size:24px;line-height:1.25}
.xp-head-title{display:flex;align-items:center;gap:12px}
.xp-head-icon{width:40px;height:40px;border-radius:11px;display:grid;place-items:center;background:var(--cb);color:var(--c)}
.xp-head-av{width:44px;height:44px;border-radius:13px;display:grid;place-items:center;background:var(--grad);color:#fff;font-weight:700;font-size:15px;box-shadow:0 10px 20px -10px rgba(124,58,237,.7);flex-shrink:0}
.xp-head{padding:22px 24px;border-radius:16px;background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow);position:relative;overflow:hidden}
.xp-head:before{content:'';position:absolute;inset:0 0 auto 0;height:4px;background:var(--c,var(--accent))}
.xp-head.is-hero{background:radial-gradient(60% 120% at 100% 0%,rgba(219,39,119,.12),transparent 60%),radial-gradient(50% 120% at 0% 100%,rgba(14,165,233,.12),transparent 60%),linear-gradient(135deg,#eef2ff 0%,#faf5ff 50%,#fff7ed 100%);border-color:#e0e7ff}
.xp-head.is-hero:before{background:var(--grad)}
.xp-head>*{position:relative}
.xp-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 0;margin-top:10px;color:var(--ink-2)}
.xp-meta span{display:inline-flex;align-items:center;gap:6px}
.xp-meta span+span:before{content:'';width:4px;height:4px;border-radius:50%;background:#c7d2fe;margin:0 12px}
.xp-meta em{font-style:normal;color:var(--mute)}

/* Stats */
.xp-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:16px}
.xp-stat{padding:16px 18px;min-width:0;border-radius:14px;border:1px solid var(--sl);background:linear-gradient(160deg,var(--sb) 0%,#fff 70%);box-shadow:var(--shadow);transition:transform .15s,box-shadow .15s}
.xp-stat:hover{transform:translateY(-2px);box-shadow:0 12px 24px -14px var(--s)}
.s-indigo{--s:#4f46e5;--sb:#eef2ff;--sl:#e0e7ff}.s-green{--s:#059669;--sb:#ecfdf5;--sl:#d1fae5}.s-amber{--s:#d97706;--sb:#fffbeb;--sl:#fde68a}.s-pink{--s:#db2777;--sb:#fdf2f8;--sl:#fbcfe8}
.xp-stat-top{display:flex;align-items:center;gap:9px}
.xp-stat-icon{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:var(--s);color:#fff;box-shadow:0 6px 12px -6px var(--s)}
.xp-stat-label{font-size:12.5px;color:var(--ink-2);font-weight:500}
.xp-stat-value{font-size:26px;font-weight:700;color:var(--s);letter-spacing:-.025em;margin-top:10px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xp-stat-sub{font-size:12px;color:var(--mute);margin-top:2px;display:flex;align-items:center;gap:8px}
.xp-meter{display:inline-flex;align-items:center;gap:8px;font-variant-numeric:tabular-nums}
.xp-meter-track{display:block;width:64px;height:4px;border-radius:9px;background:var(--line);overflow:hidden}
.xp-meter-track i{display:block;height:100%;border-radius:9px;background:linear-gradient(90deg,#10b981,#059669)}

/* Attention */
.xp-attn{border:1px solid #fde68a;background:linear-gradient(90deg,#fffbeb,#fff7ed);border-radius:12px;padding:12px 16px;margin-bottom:16px}
.xp-attn-head{display:flex;align-items:center;gap:8px;color:var(--warn);flex-wrap:wrap}
.xp-attn-head b{font-weight:600}
.xp-attn-head span{color:var(--ink-2)}
.xp-attn-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.xp-attn-item{display:inline-flex;align-items:center;gap:8px;max-width:100%;height:28px;padding:0 10px;border-radius:7px;background:var(--surface);border:1px solid var(--warn-line);transition:border-color .1s}
.xp-attn-item:hover{border-color:var(--warn)}
.xp-attn-name{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xp-attn-folder{color:var(--mute);font-size:12px;white-space:nowrap}
.xp-attn-more{align-self:center;color:var(--mute);font-size:12px}

/* Card + toolbar */
.xp-card{border:1px solid var(--line);border-radius:14px;background:var(--surface);box-shadow:var(--shadow)}
.xp-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.xp-toolbar-right{display:flex;align-items:center;gap:10px}
.xp-result{color:var(--mute);font-size:12px}
.xp-seg{display:inline-flex;gap:2px;padding:2px;border-radius:8px;background:var(--surface-2);border:1px solid var(--line-2)}
.xp-seg button{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:6px;color:var(--mute);font-weight:500}
.xp-seg button span{font-size:11px;color:var(--faint);font-variant-numeric:tabular-nums}
.xp-seg button:hover{color:var(--ink)}
.xp-seg button.is-on{background:var(--surface);color:var(--ink);box-shadow:0 0 0 1px var(--line),var(--shadow)}
.xp-seg .seg-all.is-on{color:#4f46e5}.xp-seg .seg-ready.is-on{color:#059669}.xp-seg .seg-awaiting.is-on{color:#d97706}
.xp-seg button.is-on span{color:inherit;opacity:.75}
.xp-select select{height:30px;padding:0 28px 0 10px;border-radius:8px;border:1px solid var(--line);background-color:var(--surface);color:var(--ink);font:inherit;cursor:pointer;
  appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 9px center}

/* Table */
.xp-table{--cols:minmax(0,1fr) 112px 132px 150px 76px}
.xp-table.has-folder{--cols:minmax(0,1fr) 168px 112px 120px 150px 76px}
.xp-tr{display:grid;grid-template-columns:var(--cols);align-items:center;gap:16px;padding:0 16px;min-height:52px;border-bottom:1px solid var(--line-2);cursor:pointer;transition:background .08s}
.xp-tr:last-child{border-bottom:0;border-radius:0 0 12px 12px}
.xp-tr:not(.xp-thead):hover{background:#fafaff}
.xp-thead{min-height:38px;background:linear-gradient(90deg,#f5f3ff,#eff6ff 50%,#f0fdfa);border-bottom:1px solid var(--line);cursor:default;position:sticky;top:52px;z-index:2}
.xp-th{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:500;color:var(--mute);white-space:nowrap}
.xp-th:hover,.xp-th.is-sorted{color:var(--ink)}
.is-num{justify-self:end;text-align:right}
.xp-name{display:flex;align-items:center;gap:12px;min-width:0;padding:8px 0}
.xp-kind{width:32px;height:32px;border-radius:9px;display:grid;place-items:center;flex-shrink:0}
.xp-kind.is-lg{width:36px;height:36px;border-radius:9px}
.xp-kind.is-xl{width:48px;height:48px;border-radius:12px}
.k-pdf{color:#dc2626;background:#fee2e2}.k-sheet{color:#059669;background:#d1fae5}.k-img{color:#2563eb;background:#dbeafe}.k-zip{color:#a16207;background:#fef3c7}.k-doc{color:var(--accent);background:var(--accent-bg)}
.xp-name-text{min-width:0}
.xp-name-title{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xp-name-sub{font-size:12px;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xp-td{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xp-row-actions{display:flex;justify-content:flex-end;gap:2px;cursor:default;overflow:visible}
.xp-tr .xp-row-actions .xp-icon-btn{opacity:.75}
.xp-tr:hover .xp-row-actions .xp-icon-btn,.xp-tr:focus-within .xp-row-actions .xp-icon-btn{opacity:1}
.xp-needed{font-size:12px;font-weight:500;color:var(--warn)}
.xp-pill{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:6px;font-size:12px;font-weight:500;white-space:nowrap;border:1px solid}
.xp-pill i{width:6px;height:6px;border-radius:50%;background:currentColor}
.t-ok{color:var(--ok);background:var(--ok-bg);border-color:var(--ok-line)}
.t-warn{color:var(--warn);background:var(--warn-bg);border-color:var(--warn-line)}
.t-bad{color:var(--bad);background:var(--bad-bg);border-color:var(--bad-line)}
.t-info{color:var(--info);background:var(--info-bg);border-color:var(--info-line)}
.t-mute{color:var(--mute);background:var(--surface-2);border-color:var(--line)}
.xp-only-m{display:none}
.xp-ftag{display:inline-flex;align-items:center;gap:5px;max-width:100%;height:24px;padding:0 9px;border-radius:7px;background:var(--cb);color:var(--c);font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xp-ftag svg{flex-shrink:0}

/* Empty / states */
.xp-empty{display:flex;flex-direction:column;align-items:center;gap:4px;padding:56px 20px;text-align:center;color:var(--mute)}
.xp-empty svg{margin-bottom:6px}
.xp-empty b{color:var(--ink);font-weight:500}
.xp-center{min-height:100vh;display:grid;place-items:center;padding:20px}
.xp-state{width:400px;max-width:100%;text-align:center;padding:32px;border:1px solid var(--line);border-radius:14px;background:var(--surface);box-shadow:var(--shadow-pop)}
.xp-state-icon{width:40px;height:40px;margin:0 auto 14px;border-radius:10px;display:grid;place-items:center;background:var(--surface-2);border:1px solid var(--line);color:var(--mute)}
.xp-state h1{font-size:16px}
.xp-state p{color:var(--mute);margin-top:4px}
.xp-state .xp-btn{margin-top:18px}

/* Preview panel */
.xp-panel-wrap{position:fixed;inset:0;z-index:60}
.xp-scrim{position:fixed;inset:0;background:rgba(9,9,11,.35);z-index:35}
.xp-scrim.is-panel{z-index:0;animation:xp-fade .15s ease-out}
.xp-panel{position:absolute;top:0;right:0;bottom:0;width:min(640px,100%);display:flex;flex-direction:column;background:var(--surface);border-left:1px solid var(--line);box-shadow:var(--shadow-pop);animation:xp-slide .2s cubic-bezier(.2,.8,.2,1)}
@keyframes xp-slide{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}
@keyframes xp-fade{from{opacity:0}}
.xp-panel-head{display:flex;align-items:flex-start;gap:12px;padding:18px 16px 14px 20px;background:linear-gradient(135deg,#eef2ff,#fdf2f8);border-bottom:1px solid #e0e7ff}
.xp-panel-title{flex:1;min-width:0}
.xp-panel-title h2{font-size:16px;line-height:1.35;word-break:break-word}
.xp-panel-title p{color:var(--mute);margin-top:2px}
.xp-panel-actions{display:flex;gap:8px;padding:12px 20px;border-bottom:1px solid var(--line)}
.xp-panel-body{flex:1;overflow-y:auto;padding:16px 20px 24px}
.xp-viewer{height:min(62vh,640px);border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--surface-2)}
.xp-viewer iframe{width:100%;height:100%;border:0;display:block;background:#fff}
.xp-viewer.is-img{display:grid;place-items:center;padding:12px;height:auto;max-height:62vh}
.xp-viewer.is-img img{max-width:100%;max-height:58vh;object-fit:contain;border-radius:6px}
.xp-noview{display:flex;flex-direction:column;align-items:center;gap:4px;padding:36px 20px;border:1px dashed var(--line);border-radius:10px;text-align:center;color:var(--mute)}
.xp-noview b{color:var(--ink);font-weight:500;margin-top:8px}
.xp-noview.is-warn{border-color:var(--warn-line);background:var(--warn-bg)}
.xp-noview.is-warn svg{color:var(--warn)}
.xp-facts{margin-top:20px}
.xp-facts div{display:grid;grid-template-columns:140px minmax(0,1fr);gap:12px;padding:9px 0;border-bottom:1px solid var(--line-2)}
.xp-facts div:last-child{border-bottom:0}
.xp-facts dt{color:var(--mute)}
.xp-facts dd{word-break:break-word}

/* Toast */
.xp-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:80;display:flex;align-items:center;gap:8px;max-width:calc(100% - 32px);padding:10px 14px;border-radius:10px;background:var(--solid);color:var(--solid-ink);box-shadow:var(--shadow-pop);animation:xp-fade .15s}

/* Footer */
.xp-foot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;width:100%;max-width:1200px;margin:0 auto;padding:16px 40px 28px;font-size:12px;color:var(--faint)}

/* Skeleton */
.xp-shimmer{background:linear-gradient(90deg,var(--line-2) 0%,var(--hover) 50%,var(--line-2) 100%);background-size:200% 100%;animation:xp-sh 1.2s linear infinite}
@keyframes xp-sh{to{background-position:-200% 0}}

/* Responsive */
@media (max-width:1100px){
  .xp-content{padding:24px 24px 32px}
  .xp-foot{padding:16px 24px 24px}
  .xp-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media (max-width:960px){
  .xp-side{position:fixed;left:0;top:0;transform:translateX(-100%);transition:transform .2s ease;box-shadow:var(--shadow-pop)}
  .xp-side.is-open{transform:none}
  .xp-hide-nav{display:none}
  .xp-icon-btn.xp-side-close,.xp-icon-btn.xp-menu{display:inline-grid}
  .xp-top{padding:0 12px 0 8px}
}
@media (max-width:760px){
  .xp-hide-m{display:none!important}
  .xp-only-m{display:inline}
  .xp-table,.xp-table.has-folder{--cols:minmax(0,1fr) auto auto}
  .xp-search{width:auto;flex:1}
  .xp-top-right{flex:1;min-width:0}
  .xp-crumbs{display:none}
  .xp-content{padding:20px 16px 28px}
  .xp-foot{padding:14px 16px 24px}
  .xp-head h1{font-size:20px}
  .xp-head{padding:18px 16px}
  .xp-head .xp-btn{width:100%}
  .xp-meta{gap:4px 16px}
  .xp-meta span+span:before{display:none}
  .xp-name-sub{white-space:normal}
  .xp-attn-folder{display:none}
  .xp-tr{padding:0 12px;gap:10px}
  .xp-row-actions .xp-icon-btn{opacity:1!important}
  .xp-facts div{grid-template-columns:110px minmax(0,1fr)}
}
@media (max-width:480px){
  .xp-hide-s{display:none!important}
  .xp-table,.xp-table.has-folder{--cols:minmax(0,1fr) auto}
  .xp-stat{padding:14px}
  .xp-stat-value{font-size:20px}
  .xp-panel-actions .xp-btn{flex:1}
}
@media print{.xp-side,.xp-top,.xp-row-actions,.xp-toolbar{display:none!important}.xp-root{background:#fff}}
`;
