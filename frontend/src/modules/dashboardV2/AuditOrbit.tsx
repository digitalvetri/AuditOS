import { useEffect, useRef } from 'react';
import {
  BadgeIndianRupee, Calculator, ClipboardCheck, FileSearch, FileSpreadsheet, Landmark, Percent, Receipt, Scale,
  ShieldCheck,
} from 'lucide-react';

/**
 * The dashboard banner's audit orbit: the instruments of an audit circling
 * a shield — and a small game. The cursor is a solid bumper: touch an icon
 * and it is knocked off its orbit in the direction the cursor was moving,
 * harder the faster the cursor goes. A knocked icon never simply snaps home;
 * it keeps chasing its moving place on the ring, so it curves back into the
 * circle path and carries on round. Icons collide with each other too.
 *
 * Physics, per icon, in small fixed steps every animation frame:
 *   target   = its place on the (turning, breathing) ring
 *   spring   = a soft pull toward that target, so it drifts back visibly
 *   collide  = pushed out of the cursor's bumper, bouncing off it with the
 *              cursor's own velocity; and out of any icon it overlaps
 *   velocity is lightly damped.
 * While idle, every icon also floats and rocks out of step. Positions are
 * written straight to the DOM (no React state per frame).
 *
 * prefers-reduced-motion (e.g. GNOME with animations off) keeps the orbit
 * turning and the game fully working — that motion is the user's own doing —
 * and only drops the ambient extras: breathing, floating, rocking, swaying.
 */

const OUTER = [Calculator, FileSpreadsheet, Receipt, Scale, ClipboardCheck, FileSearch];
const INNER = [BadgeIndianRupee, Landmark, Percent];

const SIZE = 204;            // the orbit box, px
const R_OUTER = 84;
const R_INNER = 47;
const SPIN_OUTER = (2 * Math.PI) / 14;   // rad/s — one turn in 14s
const SPIN_INNER = -(2 * Math.PI) / 10;  // the inner ring turns the other way
const BREATHE = { outer: 7, inner: 4 };  // rings swell and shrink by this much, px
const BOB = 3.5;                         // each icon floats up and down, px
const TILT = 9;                          // …and rocks, degrees

const BUMPER = 24;           // the cursor's solid radius, px
const HIT_R = { outer: 18, inner: 14 };  // each icon's solid radius, px
const BOUNCE = 0.85;         // restitution off the cursor (1 = perfectly elastic)
const KICK = 1.15;           // how much of the cursor's own speed an icon takes
const SPRING = 26;           // soft pull back to the orbit — low, so the return is visible
const DAMPING = 2.4;         // per-second velocity decay
const MAX_SPEED = 1400;      // px/s cap, so a flick does not fling an icon off for good

interface Sat { ring: 'outer' | 'inner'; phase: number; x: number; y: number; vx: number; vy: number; spin: number }

export function AuditOrbit() {
  const boxRef = useRef<HTMLDivElement>(null);
  const coreRef = useRef<HTMLDivElement>(null);
  const haloRef = useRef<HTMLDivElement>(null);
  const satRefs = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const sats: Sat[] = [
      ...OUTER.map((_, i) => ({ ring: 'outer' as const, phase: (i / OUTER.length) * Math.PI * 2 })),
      ...INNER.map((_, i) => ({ ring: 'inner' as const, phase: (i / INNER.length) * Math.PI * 2 + 0.5 })),
    ].map((s) => {
      const r = s.ring === 'outer' ? R_OUTER : R_INNER;
      return { ...s, x: Math.sin(s.phase) * r, y: -Math.cos(s.phase) * r, vx: 0, vy: 0, spin: 0 };
    });

    // The cursor, relative to the orbit's centre, with its velocity (px/s).
    const cur = { x: 0, y: 0, vx: 0, vy: 0, t: 0, on: false };
    const onMove = (e: PointerEvent) => {
      const r = box.getBoundingClientRect();
      const x = e.clientX - (r.left + r.width / 2);
      const y = e.clientY - (r.top + r.height / 2);
      const now = performance.now();
      if (cur.on && cur.t) {
        const dt = Math.max(0.004, (now - cur.t) / 1000);
        // Smoothed, so one jittery sample does not become a huge kick.
        cur.vx = cur.vx * 0.5 + ((x - cur.x) / dt) * 0.5;
        cur.vy = cur.vy * 0.5 + ((y - cur.y) / dt) * 0.5;
      } else {
        cur.vx = 0; cur.vy = 0;
      }
      cur.x = x; cur.y = y; cur.t = now;
      cur.on = Math.hypot(x, y) < SIZE * 1.1;
    };
    const onLeave = () => { cur.on = false; };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', onLeave);

    const place = (i: number, s: Sat, heat: number, tilt = 0, bob = 0) => {
      const el = satRefs.current[i];
      if (!el) return;
      const scale = 1 + heat * 0.3;
      el.style.transform = `translate(${s.x.toFixed(2)}px, ${(s.y + bob).toFixed(2)}px) rotate(${tilt.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
      el.style.setProperty('--heat', heat.toFixed(3));
    };

    let raf = 0;
    const t0 = performance.now();

    // Ambient motion (breathing, floating, rocking, swaying) is off under
    // prefers-reduced-motion; the orbit and the cursor game are not.
    const ambient = reduced ? 0 : 1;

    let last = t0;
    let angleOuter = 0;
    let angleInner = 0;
    let lean = { x: 0, y: 0 };

    const tick = (now: number) => {
      let dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const time = (now - t0) / 1000;
      // The cursor's velocity fades if it stops moving over the orbit.
      if (now - cur.t > 60) { cur.vx *= 0.8; cur.vy *= 0.8; }
      const near = cur.on ? Math.max(0, 1 - Math.hypot(cur.x, cur.y) / SIZE) : 0;

      while (dt > 0) {
        const h = Math.min(dt, 1 / 180);
        dt -= h;
        angleOuter += SPIN_OUTER * h;
        angleInner += SPIN_INNER * h;
        const decay = Math.exp(-DAMPING * h);

        for (const s of sats) {
          // Chase its (moving) place on the breathing ring.
          const base = s.ring === 'outer' ? R_OUTER : R_INNER;
          const r = base + ambient * BREATHE[s.ring] * Math.sin(time * 1.6 + s.phase * 2);
          const a = s.phase + (s.ring === 'outer' ? angleOuter : angleInner);
          const tx = Math.sin(a) * r;
          const ty = -Math.cos(a) * r;
          s.vx = (s.vx + (tx - s.x) * SPRING * h) * decay;
          s.vy = (s.vy + (ty - s.y) * SPRING * h) * decay;
          s.x += s.vx * h;
          s.y += s.vy * h;
          s.spin *= Math.exp(-3 * h);

          // The cursor is solid: push the icon out and bounce it off.
          if (cur.on) {
            const dx = s.x - cur.x;
            const dy = s.y - cur.y;
            const d = Math.hypot(dx, dy) || 0.001;
            const min = BUMPER + HIT_R[s.ring];
            if (d < min) {
              const nx = dx / d;
              const ny = dy / d;
              s.x = cur.x + nx * min;
              s.y = cur.y + ny * min;
              // Relative velocity along the contact normal.
              const rvx = s.vx - cur.vx * KICK;
              const rvy = s.vy - cur.vy * KICK;
              const vn = rvx * nx + rvy * ny;
              if (vn < 0) {
                s.vx -= (1 + BOUNCE) * vn * nx;
                s.vy -= (1 + BOUNCE) * vn * ny;
                // A glancing hit sets it spinning.
                s.spin += (rvx * -ny + rvy * nx) * 0.25;
              }
              const sp = Math.hypot(s.vx, s.vy);
              if (sp > MAX_SPEED) { s.vx *= MAX_SPEED / sp; s.vy *= MAX_SPEED / sp; }
            }
          }
        }

        // Icons knock into each other.
        for (let i = 0; i < sats.length; i++) {
          for (let j = i + 1; j < sats.length; j++) {
            const p = sats[i];
            const q = sats[j];
            const dx = q.x - p.x;
            const dy = q.y - p.y;
            const d = Math.hypot(dx, dy) || 0.001;
            const min = HIT_R[p.ring] + HIT_R[q.ring];
            if (d < min) {
              const nx = dx / d;
              const ny = dy / d;
              const push = (min - d) / 2;
              p.x -= nx * push; p.y -= ny * push;
              q.x += nx * push; q.y += ny * push;
              const vn = (q.vx - p.vx) * nx + (q.vy - p.vy) * ny;
              if (vn < 0) {
                const imp = -(1 + 0.6) * vn / 2;
                p.vx -= imp * nx; p.vy -= imp * ny;
                q.vx += imp * nx; q.vy += imp * ny;
              }
            }
          }
        }
      }

      sats.forEach((s, i) => {
        // "Heat": how close the cursor's bumper is — the icon grows and glows.
        const gap = cur.on ? Math.hypot(s.x - cur.x, s.y - cur.y) - (BUMPER + HIT_R[s.ring]) : Infinity;
        const heat = Math.max(0, Math.min(1, 1 - gap / 40));
        // Every icon floats and rocks on its own beat, plus any spin from a hit.
        const bob = ambient * BOB * Math.sin(time * 2.1 + i * 1.3);
        const tilt = ambient * TILT * Math.sin(time * 1.4 + i * 0.9) + s.spin;
        place(i, s, heat, tilt, bob);
      });

      // The cursor's bumper, drawn as a faint glowing ring while over the orbit.
      const halo = haloRef.current;
      if (halo) {
        halo.style.opacity = cur.on ? String(Math.min(1, 0.35 + near)) : '0';
        halo.style.transform = `translate(${cur.x.toFixed(1)}px, ${cur.y.toFixed(1)}px)`;
      }

      // The shield leans toward the cursor and sways.
      const want = cur.on ? { x: cur.x * 0.06, y: cur.y * 0.06 } : { x: 0, y: 0 };
      lean = { x: lean.x + (want.x - lean.x) * 0.12, y: lean.y + (want.y - lean.y) * 0.12 };
      if (coreRef.current) {
        const sway = ambient * Math.sin(time * 1.1) * 6;
        coreRef.current.style.transform = `translate(calc(-50% + ${lean.x.toFixed(2)}px), calc(-50% + ${lean.y.toFixed(2)}px)) rotate(${sway.toFixed(2)}deg) scale(${(1 + near * 0.08 + ambient * Math.sin(time * 2) * 0.03).toFixed(3)})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  const icons = [...OUTER, ...INNER];
  return (
    <div ref={boxRef} className="audit-orbit" aria-hidden>
      <div className="audit-ring audit-ring-outer" />
      <div className="audit-ring audit-ring-inner" />
      <div ref={coreRef} className="audit-core"><ShieldCheck size={30} strokeWidth={1.7} /></div>
      {icons.map((Icon, i) => {
        const small = i >= OUTER.length;
        return (
          <span
            key={i}
            ref={(el) => { satRefs.current[i] = el; }}
            className={`audit-sat ${small ? 'audit-sat-sm' : ''}`}
          >
            <span className="audit-sat-face"><Icon size={small ? 14 : 18} strokeWidth={small ? 1.9 : 1.8} /></span>
          </span>
        );
      })}
      <div ref={haloRef} className="audit-bumper" style={{ width: BUMPER * 2, height: BUMPER * 2, margin: -BUMPER }} />
    </div>
  );
}
