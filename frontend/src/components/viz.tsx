/**
 * Small, dependency-free visual primitives for the Teal & Coral screens:
 * sparkline, billed-vs-collected area chart, semicircle gauge, progress ring,
 * segmented bar and initials avatar.
 *
 * All colours come from the theme tokens (`rgb(var(--c-…))`) so light and
 * dark mode need no extra wiring. Every component draws from props only — no
 * data fetching here.
 */
import { useId, useMemo, useRef, useState, type CSSProperties } from 'react';

const TEAL = 'rgb(var(--c-primary))';
const CORAL = 'rgb(var(--c-coral))';

// ── Sparkline ──────────────────────────────────────────────────────────────

/** A smooth trend line with a soft fill, sized by its container. */
export function Sparkline({ values, color = TEAL, height = 44, className = '' }: {
  values: number[]; color?: string; height?: number; className?: string;
}) {
  const id = useId().replace(/:/g, '');
  const W = 300;
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, 4 + (1 - (v - min) / span) * (height - 8)] as const);
  const d = smooth(pts);
  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className={'block w-full ' + className} style={{ height }} aria-hidden>
      <defs>
        <linearGradient id={`sp-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.22" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${W} ${height} L0 ${height}Z`} fill={`url(#sp-${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function smooth(pts: readonly (readonly [number, number])[]): string {
  return pts.map(([x, y], i) => {
    if (i === 0) return `M${x} ${y}`;
    const [px, py] = pts[i - 1];
    const c = (x - px) / 2;
    return `C${px + c} ${py} ${x - c} ${y} ${x} ${y}`;
  }).join(' ');
}

// ── Area chart (two series) ────────────────────────────────────────────────

export interface AreaPoint { label: string; a: number; b: number }

/**
 * Two smoothed series (a = teal, b = coral) on a shared axis, with a hover
 * crosshair and tooltip. `format` renders axis ticks and tooltip values.
 */
export function AreaChart({ points, labels, format, height = 240 }: {
  points: AreaPoint[];
  labels: { a: string; b: string };
  format: (n: number) => string;
  height?: number;
}) {
  const id = useId().replace(/:/g, '');
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, L = 52, R = 14, T = 14, B = 28;
  const max = useMemo(() => niceMax(Math.max(1, ...points.flatMap((p) => [p.a, p.b]))), [points]);
  const x = (i: number) => L + (points.length === 1 ? 0 : (i * (W - L - R)) / (points.length - 1));
  const y = (v: number) => T + (1 - v / max) * (height - T - B);
  const line = (k: 'a' | 'b') => smooth(points.map((p, i) => [x(i), y(p[k])] as const));
  const area = (k: 'a' | 'b') => `${line(k)} L${x(points.length - 1)} ${y(0)} L${x(0)} ${y(0)}Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);

  const onMove = (e: React.MouseEvent) => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r || points.length === 0) return;
    const sx = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((sx - L) / (W - L - R)) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };

  const h = hover !== null ? points[hover] : null;
  const tipLeft = hover !== null ? `${(Math.min(x(hover) + 12, W - 180) / W) * 100}%` : '0';
  return (
    <div ref={wrap} className="relative" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${height}`} className="block w-full" style={{ height }} role="img"
        aria-label={`${labels.a} and ${labels.b} by month`}>
        <defs>
          <linearGradient id={`aa-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={TEAL} stopOpacity="0.22" /><stop offset="1" stopColor={TEAL} stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`ab-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={CORAL} stopOpacity="0.18" /><stop offset="1" stopColor={CORAL} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="rgb(var(--c-border))" strokeDasharray="2 5" />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" className="fill-inkFaint" style={{ font: '500 11px var(--font-ui, inherit)' }}>{format(t)}</text>
          </g>
        ))}
        {points.map((p, i) => (
          <text key={p.label} x={x(i)} y={height - 8} textAnchor="middle" className="fill-inkFaint" style={{ font: '500 11px inherit' }}>{p.label}</text>
        ))}
        <path d={area('a')} fill={`url(#aa-${id})`} />
        <path d={area('b')} fill={`url(#ab-${id})`} />
        <path d={line('a')} fill="none" stroke={TEAL} strokeWidth="2.5" strokeLinecap="round" className="viz-draw" />
        <path d={line('b')} fill="none" stroke={CORAL} strokeWidth="2.5" strokeLinecap="round" className="viz-draw" />
        {hover !== null && h ? (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={height - B} stroke="rgb(var(--c-neutral-300))" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(h.a)} r="5" fill="rgb(var(--c-surface))" stroke={TEAL} strokeWidth="2.5" />
            <circle cx={x(hover)} cy={y(h.b)} r="5" fill="rgb(var(--c-surface))" stroke={CORAL} strokeWidth="2.5" />
          </g>
        ) : null}
      </svg>
      {h ? (
        <div className="pointer-events-none absolute top-2 z-10 min-w-[168px] rounded-lg bg-ink px-3 py-2 text-12 text-surface shadow-drawer"
          style={{ left: tipLeft }}>
          <div className="font-semibold mb-1">{h.label}</div>
          <Row color={TEAL} label={labels.a} value={format(h.a)} />
          <Row color={CORAL} label={labels.b} value={format(h.b)} />
        </div>
      ) : null}
    </div>
  );
}

function Row({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 opacity-90">
      <span className="h-2 w-2 rounded-sm" style={{ background: color }} />
      <span>{label}</span>
      <span className="ml-auto font-semibold tabular-nums">{value}</span>
    </div>
  );
}

/** Round an axis maximum up to 1, 2, 2.5 or 5 × 10ⁿ. */
function niceMax(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

// ── Gauge ──────────────────────────────────────────────────────────────────

/** A 180° gauge for a 0–1 value, teal → coral gradient, animated in. */
export function Gauge({ value, size = 200, track = 'rgb(var(--c-white) / 0.10)' }: { value: number; size?: number; track?: string }) {
  const id = useId().replace(/:/g, '');
  const len = Math.PI * 80;
  const v = Math.max(0, Math.min(1, value));
  return (
    <svg viewBox="0 0 200 112" style={{ width: size, height: size * 0.56 }} aria-hidden>
      <defs>
        <linearGradient id={`g-${id}`} x1="0" x2="1">
          <stop offset="0" stopColor="#5fd3c9" /><stop offset="1" stopColor="#0f9d96" />
        </linearGradient>
      </defs>
      <path d="M20 104 A80 80 0 0 1 180 104" fill="none" stroke={track} strokeWidth="14" strokeLinecap="round" />
      <path d="M20 104 A80 80 0 0 1 180 104" fill="none" stroke={`url(#g-${id})`} strokeWidth="14" strokeLinecap="round"
        strokeDasharray={len} strokeDashoffset={len * (1 - v)} className="viz-gauge"
        style={{ filter: 'drop-shadow(0 0 6px rgb(122 90 248 / 0.30))' }} />
    </svg>
  );
}

// ── Ring ───────────────────────────────────────────────────────────────────

/**
 * A circular progress ring for a 0–1 value. Colour follows the value unless
 * given: ≥ .85 success, ≥ .6 warning, else danger.
 */
export function Ring({ value, size = 22, stroke = 3, color, children }: {
  value: number; size?: number; stroke?: number; color?: string; children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  const col = color ?? (v >= 0.85 ? 'rgb(var(--c-success))' : v >= 0.6 ? 'rgb(var(--c-warning))' : 'rgb(var(--c-danger))');
  return (
    <span className="relative inline-grid place-items-center shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--c-neutral-200))" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={col} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={`${c * v} ${c}`} className="viz-ring" />
      </svg>
      {children ? <span className="absolute inset-0 grid place-items-center">{children}</span> : null}
    </span>
  );
}

// ── Donut (several segments) ───────────────────────────────────────────────

export function Donut({ segments, size = 104, stroke = 12, children }: {
  segments: { value: number; color: string; label?: string }[]; size?: number; stroke?: number; children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  let offset = 0;
  return (
    <span className="relative inline-grid place-items-center shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--c-neutral-100))" strokeWidth={stroke} />
        {segments.map((s, i) => {
          const len = (s.value / total) * c;
          const el = (
            <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={stroke}
              strokeDasharray={`${Math.max(0, len - (len > 2 ? 1.5 : 0))} ${c}`} strokeDashoffset={-offset} />
          );
          offset += len;
          return el;
        })}
      </svg>
      {children ? <span className="absolute inset-0 grid place-items-center text-center">{children}</span> : null}
    </span>
  );
}

// ── Segmented bar ──────────────────────────────────────────────────────────

export function SegBar({ parts, className = '' }: { parts: { value: number; color: string; label?: string }[]; className?: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (total === 0) return <div className={'h-2 rounded bg-neutral-100 ' + className} />;
  return (
    <div className={'flex gap-[3px] h-2 ' + className}>
      {parts.filter((p) => p.value > 0).map((p, i) => (
        <span key={i} className="rounded-[3px]" style={{ flex: p.value, background: p.color }} title={p.label} />
      ))}
    </div>
  );
}

// ── Avatar ─────────────────────────────────────────────────────────────────

const AVATAR_TONES = ['#6941d9', '#2f9e44', '#c27a0a', '#6941d9', '#7a5af8', '#4a5468', '#b45309', '#3a3358'];

export function initials(name: string | null | undefined): string {
  return (name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '·';
}

/** A stable tone per name, so the same person/client is always the same colour. */
export function toneFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

export function Avatar({ name, src, size = 30, square = false, className = '', style }: {
  name: string | null | undefined; src?: string | null; size?: number; square?: boolean; className?: string; style?: CSSProperties;
}) {
  const radius = square ? Math.round(size * 0.3) : 9999;
  if (src) {
    return <img src={src} alt="" className={'shrink-0 object-cover ' + className}
      style={{ width: size, height: size, borderRadius: radius, ...style }} />;
  }
  return (
    <span aria-hidden className={'shrink-0 inline-grid place-items-center font-semibold text-white ' + className}
      style={{ width: size, height: size, borderRadius: radius, background: toneFor(name ?? '?'), fontSize: Math.max(9, size * 0.36), ...style }}>
      {initials(name)}
    </span>
  );
}
