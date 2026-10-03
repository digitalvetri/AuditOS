/**
 * The header for a record's own page — a client, an employee, a lead, an
 * invoice. One tinted panel (teal → coral wash) holding:
 *
 *   avatar · title · mono ID line · chips      actions
 *   meta row (contact, owner, dates …)
 *   stats row (a few figures that matter for this record)
 *
 * Presentation only: every value and action comes from the page.
 */
import { NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Avatar } from '@/components/viz';

export interface HeaderStat { label: string; value: ReactNode; tone?: 'bad' | 'ok' | 'warn'; hint?: string }

export function EntityHeader({ name, avatar, square, title, idLine, chips, meta, actions, stats, children }: {
  /** Seed for the initials avatar (person or company name). */
  name: string;
  avatar?: string | null;
  square?: boolean;
  title?: ReactNode;
  idLine?: ReactNode;
  chips?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  stats?: HeaderStat[];
  children?: ReactNode;
}) {
  return (
    <header className="eh-panel dash-rise rounded-[18px] mb-4 overflow-hidden">
      <div className="px-5 md:px-6 pt-5 pb-4">
        <div className="flex flex-col md:flex-row md:items-start gap-4">
          <div className="flex items-center gap-4 min-w-0 flex-1">
            <Avatar name={name} src={avatar} size={56} square={square} className="shadow-raised" />
            <div className="min-w-0">
              <h1 className="text-[24px] leading-tight font-semibold tracking-[-0.025em] text-ink truncate">{title ?? name}</h1>
              {idLine ? <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-12 text-inkMuted font-mono">{idLine}</div> : null}
              {chips ? <div className="mt-2 flex flex-wrap items-center gap-[6px]">{chips}</div> : null}
            </div>
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2 md:justify-end">{actions}</div> : null}
        </div>
        {meta ? <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-13 text-inkMuted">{meta}</div> : null}
        {children}
      </div>
      {stats && stats.length ? (
        <div className="eh-stats grid border-t border-border" style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }}>
          {stats.map((s) => (
            <div key={s.label} className="px-5 md:px-6 py-3 min-w-0" title={s.hint}>
              <div className="text-11 font-semibold uppercase tracking-[0.06em] text-inkFaint truncate">{s.label}</div>
              <div className={'num-display text-18 leading-tight mt-0.5 truncate ' + (s.tone === 'bad' ? 'text-danger' : s.tone === 'ok' ? 'text-success' : s.tone === 'warn' ? 'text-warning' : 'text-ink')}>{s.value}</div>
            </div>
          ))}
        </div>
      ) : null}
    </header>
  );
}

/** A small rounded tag for the chips row. */
export function HeaderTag({ children, tone }: { children: ReactNode; tone?: 'bad' | 'warn' | 'ok' | 'teal' }) {
  const cls = tone === 'bad' ? 'bg-danger/10 text-danger'
    : tone === 'warn' ? 'bg-warning/10 text-warning'
    : tone === 'ok' ? 'bg-success/10 text-success'
    : tone === 'teal' ? 'bg-primary/10 text-primary'
    : 'bg-surface text-inkMuted shadow-card';
  return <span className={'inline-flex items-center gap-[6px] h-6 px-[10px] rounded-full text-11 font-semibold whitespace-nowrap ' + cls}>{children}</span>;
}

/** An icon + text item for the meta row; becomes a link when `href` is set. */
export function MetaItem({ icon, children, href }: { icon: ReactNode; children: ReactNode; href?: string }) {
  const inner = <><span className="text-inkFaint">{icon}</span><span className="truncate">{children}</span></>;
  return href
    ? <a href={href} className="inline-flex items-center gap-2 min-w-0 hover:text-ink">{inner}</a>
    : <span className="inline-flex items-center gap-2 min-w-0">{inner}</span>;
}

/** Secondary header action (white chip button). */
export const headerBtn = 'inline-flex items-center gap-[6px] h-9 px-3 rounded-[10px] bg-surface text-ink text-13 font-semibold shadow-card hover:shadow-raised transition-shadow';
/** Primary header action. */
export const headerBtnPrimary = 'inline-flex items-center gap-[6px] h-9 px-3 rounded-[10px] bg-primary text-white text-13 font-semibold';

/** Underlined page tabs (the Clients-page view tabs), as router links. */
export function PageTabs({ tabs }: { tabs: { to: string; label: string; end?: boolean; count?: number }[] }) {
  return (
    <nav className="cl-views flex gap-1 border-b border-border mb-4 overflow-x-auto" aria-label="Sections">
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end}
          className={({ isActive }) => 'cl-view relative flex items-center gap-2 px-3 pt-2 pb-[10px] text-13 font-medium whitespace-nowrap transition-colors ' + (isActive ? 'is-on text-ink' : 'text-inkMuted hover:text-ink')}>
          {t.label}
          {t.count ? <span className="cl-count">{t.count}</span> : null}
        </NavLink>
      ))}
    </nav>
  );
}
