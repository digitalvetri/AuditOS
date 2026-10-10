import { describe, expect, it } from 'vitest';
import { smooth } from '../viz';

/** Every cubic segment's control points stay inside its endpoints' y-range: no overshoot. */
function controlsInRange(d: string, pts: [number, number][]) {
  const segs = d.split(' C').slice(1).map((s) => s.trim().split(/\s+/).map(Number));
  expect(segs).toHaveLength(pts.length - 1);
  segs.forEach((s, i) => {
    const lo = Math.min(pts[i][1], pts[i + 1][1]);
    const hi = Math.max(pts[i][1], pts[i + 1][1]);
    for (const y of [s[1], s[3]]) {
      expect(y).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(y).toBeLessThanOrEqual(hi + 1e-9);
    }
  });
}

describe('smooth (monotone curve)', () => {
  it('never overshoots between points', () => {
    const pts: [number, number][] = [[0, 200], [100, 20], [200, 200], [300, 200], [400, 190], [500, 10]];
    controlsInRange(smooth(pts), pts);
  });
  it('a flat run stays flat', () => {
    const d = smooth([[0, 50], [10, 50], [20, 50]]);
    const ys = d.replace(/[MC]/g, '').trim().split(/\s+/).map(Number).filter((_, i) => i % 2 === 1);
    expect(ys.every((y) => y === 50)).toBe(true);
  });
  it('handles short series', () => {
    expect(smooth([])).toBe('');
    expect(smooth([[1, 2]])).toBe('M1 2');
    expect(smooth([[0, 0], [10, 5]])).toBe('M0 0 L10 5');
  });
});
