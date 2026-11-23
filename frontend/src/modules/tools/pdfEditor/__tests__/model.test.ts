import { describe, expect, it } from 'vitest';
import { Geo, toSpec, type EditObj, type PageEntry } from '../model';

describe('PDF editor geometry', () => {
  it('maps user space to the screen the way pdf.js does (A4, no rotation)', () => {
    const g = new Geo([0, 0, 595, 842], 2, 0);
    expect(g.width).toBe(1190);
    expect(g.height).toBe(1684);
    expect(g.toScreen(0, 0)).toEqual([0, 1684]);      // bottom-left of the page = bottom-left of the screen
    expect(g.toScreen(595, 842)).toEqual([1190, 0]);
  });

  it('round-trips every quarter turn and an offset box', () => {
    for (const rot of [0, 90, 180, 270]) {
      const g = new Geo([100, 100, 700, 900], 1.5, rot);
      for (const [x, y] of [[100, 100], [250, 600], [700, 900]]) {
        const [sx, sy] = g.toScreen(x, y);
        const [bx, by] = g.toPdf(sx, sy);
        expect(bx).toBeCloseTo(x, 6);
        expect(by).toBeCloseTo(y, 6);
      }
      // The whole page is on screen, from 0,0.
      const corners = [[100, 100], [700, 100], [100, 900], [700, 900]].map(([x, y]) => g.toScreen(x, y));
      expect(Math.min(...corners.map((c) => c[0]))).toBeCloseTo(0, 6);
      expect(Math.min(...corners.map((c) => c[1]))).toBeCloseTo(0, 6);
    }
  });

  it('builds the server spec in page order, dropping edits on deleted pages', () => {
    const pages: PageEntry[] = [{ key: 'b', source: 1, rotate: 90 }, { key: 'n', source: null, rotate: 0 }];
    const objects: EditObj[] = [
      { id: '1', pageKey: 'b', type: 'text', x: 1, y: 2, text: 'a\nb', size: 10, font: 'sans', bold: false, italic: false, color: '#000000', rotation: 0 },
      { id: '2', pageKey: 'gone', type: 'whiteout', x: 0, y: 0, w: 1, h: 1, color: '#ffffff' },
      { id: '3', pageKey: 'n', type: 'text', x: 1, y: 2, text: '   ', size: 10, font: 'sans', bold: false, italic: false, color: '#000000', rotation: 0 },
    ];
    const spec = toSpec(pages, objects);
    expect(spec.pages).toEqual([{ source: 1, rotate: 90 }, { source: null, rotate: 0, width: 595.28, height: 841.89 }]);
    expect(spec.objects).toEqual([expect.objectContaining({ type: 'text', page: 0, lines: ['a', 'b'] })]);
  });
});
