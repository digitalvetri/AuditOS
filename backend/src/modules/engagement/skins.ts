/**
 * The firm's Word templates, as the PDF needs them — a mirror of WORD_SKINS
 * in src/modules/workstation/engagement/templates.ts, which documents every
 * number. The browser page and this PDF are two renderings of the same
 * points, so a number changed there must be changed here.
 */

export type FontKey = 'times' | 'segoe' | 'arial' | 'bell' | 'calibri'

export interface HeadLine { font: FontKey; size: number; bold: boolean; color: string; baseline: number }

export interface WordSkin {
  size: number
  pitch: number
  pitchBySize?: Record<string, number>
  gap: number
  blank: number
  top: [number, number]
  bottom: number
  margin: number
  letterhead: { name: HeadLine; addr: HeadLine[]; repeat: boolean }
  footer: { baseline: number; spaced: boolean }
  listIndent: number
  markerWidth: number
  company?: { size: number; color: string }
}

const NAVY = '#002060'
const addr = (font: FontKey, size: number, baselines: number[]): HeadLine[] =>
  baselines.map((baseline) => ({ font, size, bold: true, color: '#000000', baseline }))

export const WORD_SKINS: Record<string, WordSkin> = {
  'jns-compliance': {
    size: 11, pitch: 13.63, gap: 2.03, blank: 17.7,
    top: [115.57, 93.67], bottom: 770, margin: 72,
    letterhead: {
      name: { font: 'segoe', size: 16, bold: true, color: NAVY, baseline: 31.2 },
      addr: addr('bell', 10, [43.0, 54.5, 65.8]),
      repeat: false,
    },
    footer: { baseline: 789.8, spaced: true },
    listIndent: 18, markerWidth: 18,
  },
  'jns-epr': {
    size: 11, pitch: 13.4, pitchBySize: { '12': 13.8, '14': 16.1 }, gap: 2.1, blank: 17.9,
    company: { size: 10.5, color: '#212121' },
    top: [97.6, 17.2], bottom: 770, margin: 72,
    letterhead: {
      name: { font: 'times', size: 15.8, bold: true, color: NAVY, baseline: 28.5 },
      addr: addr('times', 10.1, [41.5, 53.0, 64.5]),
      repeat: false,
    },
    footer: { baseline: 790.2, spaced: false },
    listIndent: 18, markerWidth: 18,
  },
  'jns-accounting-services': {
    size: 11, pitch: 13.75, gap: 1.83, blank: 17.25,
    top: [108.2, 44.7], bottom: 770, margin: 72,
    letterhead: {
      name: { font: 'arial', size: 16, bold: true, color: NAVY, baseline: 29.0 },
      addr: addr('bell', 9.8, [43.0, 58.0, 73.0]),
      repeat: false,
    },
    footer: { baseline: 791.5, spaced: false },
    listIndent: 18, markerWidth: 18.5,
  },
  'jns-bookkeeping': {
    size: 11, pitch: 13.63, gap: 2.03, blank: 17.7,
    top: [121.37, 121.47], bottom: 770, margin: 72,
    letterhead: {
      name: { font: 'segoe', size: 16, bold: true, color: NAVY, baseline: 52.2 },
      addr: addr('bell', 10, [65.0, 76.2, 87.5]),
      repeat: true,
    },
    footer: { baseline: 789.8, spaced: true },
    listIndent: 18, markerWidth: 18,
  },
}

export const skinOf = (templateId: string | null | undefined): WordSkin | null => WORD_SKINS[templateId ?? ''] ?? null

export const pitchOf = (skin: WordSkin, size?: number): number => {
  if (!size || size === skin.size) return skin.pitch
  return skin.pitchBySize?.[String(size)] ?? Math.round(size * 1.16 * 100) / 100
}
