import {
  BadgeCheck, Calculator, ClipboardCheck, FileSearch, FileSpreadsheet, IndianRupee, Landmark, Percent, Receipt,
  Scale, ShieldCheck, Stamp, type LucideIcon,
} from 'lucide-react';

/**
 * The sidebar's audit backdrop, drawn behind the navigation:
 *   - faint ledger rules, like ruled audit paper;
 *   - the instruments of an audit (calculator, ledger, receipt, stamp, scale,
 *     ₹, %, a tick…) drifting slowly upward, swaying and turning;
 *   - a growth chart along the bottom: bars rising left to right, growing in
 *     turn, with a trend arrow drawing itself over their tops;
 *   - small teal ticks that light up now and then, as if a line had just
 *     been checked.
 * Purely decorative: no pointer events, hidden from assistive tech, and faint
 * enough that the menu text always reads first. CSS only — see `.sb-backdrop`.
 */

/** [icon, left %, size px, rise seconds, delay seconds] — fixed, so it never jumps between renders. */
const DRIFT: [LucideIcon, number, number, number, number][] = [
  [Calculator, 12, 22, 26, 0],
  [FileSpreadsheet, 70, 20, 31, -6],
  [Receipt, 38, 18, 23, -12],
  [Scale, 82, 24, 34, -3],
  [Stamp, 22, 20, 29, -18],
  [IndianRupee, 58, 16, 21, -9],
  [Percent, 8, 15, 25, -21],
  [ClipboardCheck, 46, 21, 33, -15],
  [Landmark, 88, 18, 28, -24],
  [FileSearch, 30, 19, 27, -27],
  [ShieldCheck, 64, 22, 36, -30],
  [BadgeCheck, 16, 16, 24, -5],
];

/** [top %, left %, delay seconds] — ticks that flash in turn. */
const TICKS: [number, number, number][] = [
  [18, 78, 1.6], [34, 14, 2.9], [52, 70, 4.6], [68, 26, 6.1], [84, 60, 7.6],
];

/**
 * The growth chart at the foot: bars stepping up left to right, each taller
 * than the one before, with a trend arrow climbing over their tops. Drawn in
 * a fixed 220×220 box (the open sidebar's inner width).
 */
const CHART = 220;
const BAR_W = 25;
const BAR_GAP = 14;
const BAR_H = [24, 36, 48, 60, 72, 84]; // % of the box, rising
const tops = BAR_H.map((h, i) => ({ x: i * (BAR_W + BAR_GAP) + BAR_W / 2, y: CHART - (h / 100) * CHART - 16 }));
const trend = tops.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
// Arrowhead: along the last segment's direction, at the last point.
const [p1, p2] = [tops[tops.length - 2], tops[tops.length - 1]];
const ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
const head = [ang - 2.6, ang + 2.6]
  .map((a) => `${(p2.x + Math.cos(a) * 11).toFixed(1)},${(p2.y + Math.sin(a) * 11).toFixed(1)}`);
const arrowHead = `M${head[0]} L${p2.x.toFixed(1)},${p2.y.toFixed(1)} L${head[1]}`;

export function SidebarBackdrop({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div className="sb-backdrop" aria-hidden>
      <div className="sb-ledger" />
      {DRIFT.map(([Icon, left, size, dur, delay], i) => (
        <span
          key={i}
          className="sb-drift"
          style={{ left: `${left}%`, animationDuration: `${dur}s`, animationDelay: `${delay}s` }}
        >
          <span className="sb-drift-sway" style={{ animationDelay: `${delay / 2}s` }}>
            <Icon size={size} strokeWidth={1.5} />
          </span>
        </span>
      ))}
      {collapsed ? null : (
        <div className="sb-chart" style={{ width: CHART, height: CHART }}>
          {BAR_H.map((h, i) => (
            <span
              key={`b${i}`}
              className="sb-bar"
              style={{ left: i * (BAR_W + BAR_GAP), width: BAR_W, height: `${h}%`, animationDelay: `${i * 0.18}s` }}
            />
          ))}
          <svg className="sb-trend" width={CHART} height={CHART} viewBox={`0 0 ${CHART} ${CHART}`} fill="none">
            <path className="sb-trend-line" d={trend} pathLength={1} />
            <path className="sb-trend-head" d={arrowHead} />
          </svg>
        </div>
      )}
      {TICKS.map(([top, left, delay], i) => (
        <span key={`t${i}`} className="sb-tick" style={{ top: `${top}%`, left: `${left}%`, animationDelay: `${delay}s` }}>
          <BadgeCheck size={14} strokeWidth={2} />
        </span>
      ))}
    </div>
  );
}
