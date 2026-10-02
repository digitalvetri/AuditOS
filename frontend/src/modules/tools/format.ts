import type { FileType } from './types';

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const FILE_TYPE_LABEL: Record<FileType, string> = {
  pdf: 'PDF', excel: 'XLSX', word: 'DOCX', csv: 'CSV', image: 'Image', text: 'TXT', zip: 'ZIP', other: 'File',
};

export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}
