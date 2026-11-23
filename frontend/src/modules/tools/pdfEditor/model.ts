/**
 * PDF editor — the document model and page geometry.
 *
 * Every edit is stored in PDF USER SPACE (the page's own coordinates, before
 * its /Rotate), never in screen pixels, so zoom and page rotation never move
 * it and the server draws it exactly where it was placed. `Geo` converts
 * between user space and the screen for one page at one zoom and rotation —
 * the same matrix pdf.js's PageViewport builds (reproduced here so a blank
 * page, which pdf.js never sees, converts the same way).
 */

export type Rot = 0 | 90 | 180 | 270;

export interface PageEntry {
  key: string;
  /** 0-based index of the original page; null = a blank page. */
  source: number | null;
  /** Extra clockwise rotation on top of the page's own. */
  rotate: Rot;
  /** Blank pages: size in points. */
  width?: number;
  height?: number;
}

interface Base { id: string; pageKey: string }
export interface TextObj extends Base {
  type: 'text';
  /** Baseline-left of the first line, user space. */
  x: number; y: number;
  text: string;
  size: number;
  font: FontId;
  bold: boolean;
  italic: boolean;
  color: string;
  /** Counter-clockwise degrees in user space = the page's on-screen rotation when typed. */
  rotation: number;
}
export interface BoxObj extends Base {
  type: 'whiteout' | 'highlight' | 'rect';
  /** Bottom-left and size, user space. */
  x: number; y: number; w: number; h: number;
  color: string;
  opacity?: number;
  borderWidth?: number;
}
export interface InkObj extends Base { type: 'ink'; points: [number, number][]; color: string; width: number }
export interface ImageObj extends Base {
  type: 'image';
  /** The image's bottom-left corner before rotation, user space. */
  x: number; y: number; w: number; h: number;
  rotation: number;
  data: string;
  opacity: number;
}
export type EditObj = TextObj | BoxObj | InkObj | ImageObj;

export const LINE_HEIGHT = 1.2;
/** The faces loaded into the page (pdfjs.ts) — the same files the server embeds. */
export const FACE = { arial: 'PdfEdArial', sans: 'PdfEdSans', serif: 'PdfEdSerif' } as const;
export type FontId = keyof typeof FACE;
/**
 * CSS stacks. Liberation Sans (Arial metrics) has no ₹, so the browser falls
 * back to Carlito for it — and the server splits the line the same way.
 */
export const FONT_FAMILY: Record<FontId, string> = {
  arial: `'${FACE.arial}', '${FACE.sans}'`,
  sans: `'${FACE.sans}'`,
  serif: `'${FACE.serif}', '${FACE.sans}'`,
};

let seq = 0;
export const newId = () => `o${Date.now().toString(36)}${(++seq).toString(36)}`;

/** One page's screen ⇄ user-space mapping. */
export class Geo {
  readonly width: number;
  readonly height: number;
  readonly transform: number[];
  readonly rotation: number;
  readonly scale: number;
  private readonly inv: number[];

  constructor(viewBox: number[], scale: number, rotation: number, userUnit = 1) {
    const s = scale * userUnit;
    const cx = (viewBox[2] + viewBox[0]) / 2;
    const cy = (viewBox[3] + viewBox[1]) / 2;
    let r = rotation % 360;
    if (r < 0) r += 360;
    const [a, b, c, d] = r === 180 ? [-1, 0, 0, 1] : r === 90 ? [0, 1, 1, 0] : r === 270 ? [0, -1, -1, 0] : [1, 0, 0, -1];
    let ox: number; let oy: number;
    if (a === 0) {
      ox = Math.abs(cy - viewBox[1]) * s; oy = Math.abs(cx - viewBox[0]) * s;
      this.width = (viewBox[3] - viewBox[1]) * s; this.height = (viewBox[2] - viewBox[0]) * s;
    } else {
      ox = Math.abs(cx - viewBox[0]) * s; oy = Math.abs(cy - viewBox[1]) * s;
      this.width = (viewBox[2] - viewBox[0]) * s; this.height = (viewBox[3] - viewBox[1]) * s;
    }
    this.transform = [a * s, b * s, c * s, d * s, ox - a * s * cx - c * s * cy, oy - b * s * cx - d * s * cy];
    this.rotation = r;
    this.scale = s;
    const [m0, m1, m2, m3, m4, m5] = this.transform;
    const det = m0 * m3 - m1 * m2;
    this.inv = [m3 / det, -m1 / det, -m2 / det, m0 / det, (m2 * m5 - m3 * m4) / det, (m1 * m4 - m0 * m5) / det];
  }

  toScreen(x: number, y: number): [number, number] {
    const t = this.transform;
    return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
  }

  toPdf(sx: number, sy: number): [number, number] {
    const t = this.inv;
    return [t[0] * sx + t[2] * sy + t[4], t[1] * sx + t[3] * sy + t[5]];
  }

  /** A screen rectangle as a user-space box (bottom-left + size). */
  boxFromScreen(sx1: number, sy1: number, sx2: number, sy2: number) {
    const [x1, y1] = this.toPdf(sx1, sy1);
    const [x2, y2] = this.toPdf(sx2, sy2);
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }

  /** A user-space box as a screen rectangle. */
  screenBox(o: { x: number; y: number; w: number; h: number }) {
    const [ax, ay] = this.toScreen(o.x, o.y);
    const [bx, by] = this.toScreen(o.x + o.w, o.y + o.h);
    return { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
  }
}

/** The page's view box and own rotation, for real and blank pages alike. */
export interface PageInfo { view: number[]; rotate: number; userUnit: number }

export const A4: [number, number] = [595.28, 841.89];

export function pageInfo(entry: PageEntry, originals: PageInfo[]): PageInfo {
  if (entry.source === null) return { view: [0, 0, entry.width ?? A4[0], entry.height ?? A4[1]], rotate: 0, userUnit: 1 };
  return originals[entry.source];
}

export function viewRotation(entry: PageEntry, originals: PageInfo[]): number {
  return (pageInfo(entry, originals).rotate + entry.rotate) % 360;
}

/** The request body the server's editor takes (backend PdfEditor.ts). */
export function toSpec(pages: PageEntry[], objects: EditObj[]) {
  const index = new Map(pages.map((p, i) => [p.key, i]));
  return {
    pages: pages.map((p) => ({ source: p.source, rotate: p.rotate, ...(p.source === null ? { width: p.width ?? A4[0], height: p.height ?? A4[1] } : {}) })),
    objects: objects.filter((o) => index.has(o.pageKey)).flatMap((o): Record<string, unknown>[] => {
      const page = index.get(o.pageKey)!;
      switch (o.type) {
        case 'text': {
          const lines = o.text.replace(/\r/g, '').split('\n');
          if (!lines.some((l) => l.trim())) return [];
          return [{ type: 'text', page, x: o.x, y: o.y, lines, size: o.size, font: o.font, bold: o.bold, italic: o.italic, color: o.color, rotation: o.rotation, lineHeight: LINE_HEIGHT }];
        }
        case 'ink': return [{ type: 'ink', page, points: o.points, color: o.color, width: o.width }];
        case 'image': return [{ type: 'image', page, x: o.x, y: o.y, w: o.w, h: o.h, rotation: o.rotation, data: o.data, opacity: o.opacity }];
        default: {
          const b = o as BoxObj;
          return [{
            type: b.type, page, x: b.x, y: b.y, w: Math.max(0.5, b.w), h: Math.max(0.5, b.h), color: b.color,
            ...(b.type === 'highlight' ? { opacity: b.opacity ?? 0.4 } : {}),
            ...(b.type === 'rect' ? { borderWidth: b.borderWidth ?? 1.5 } : {}),
          }];
        }
      }
    }),
  };
}
