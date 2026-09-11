/**
 * TDS weekly notice-check localStorage store.
 *
 * Mirrors the GST module's noticeCheckStore.ts — same shape, different
 * namespace so GST and TDS logs don't collide. Persists { [clientTanKey]:
 * { lastCheckedAt, outcome } } so a single client + TAN's "last checked"
 * status survives refresh. When the backend engine ships, this file is
 * swapped for API calls; the components don't change.
 */

const STORAGE_KEY = 'audit-os:tds-notice-check';

export type NoticeOutcome = 'clear' | 'found';

export interface NoticeCheckEntry {
  lastCheckedAt: string;   // ISO
  outcome: NoticeOutcome;
  note?: string;
}

export type NoticeCheckLog = Record<string, NoticeCheckEntry>;

/** Combine clientId + TAN into a single key — a client with two TANs
 *  gets two separate check entries. */
export function noticeKey(clientId: string, tan: string | null): string {
  return `${clientId}::${tan ?? '_no_tan'}`;
}

function safeParse(raw: string | null): NoticeCheckLog {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as NoticeCheckLog;
    return {};
  } catch {
    return {};
  }
}

export function readNoticeLog(): NoticeCheckLog {
  if (typeof localStorage === 'undefined') return {};
  return safeParse(localStorage.getItem(STORAGE_KEY));
}

export function writeNoticeCheck(
  key: string,
  outcome: NoticeOutcome,
  note?: string,
): NoticeCheckLog {
  const log = readNoticeLog();
  const next: NoticeCheckLog = {
    ...log,
    [key]: {
      lastCheckedAt: new Date().toISOString(),
      outcome,
      note,
    },
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage disabled — non-fatal.
  }
  return next;
}

export function clearNoticeLog(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

export function daysSinceISO(iso: string): number {
  const then = new Date(iso).getTime();
  const now = Date.now();
  return Math.max(0, Math.floor((now - then) / (24 * 60 * 60 * 1000)));
}
