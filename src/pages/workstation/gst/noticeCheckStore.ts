/**
 * Client-side persistence for the weekly notice-check workflow.
 *
 * Stores { [clientId]: { lastCheckedAt, outcome, note? } } in localStorage
 * so the operator’s work survives a refresh. When the real backend (task
 * #4) ships, this file is swapped for API calls and the NoticeCheck page
 * doesn’t change shape.
 *
 * Design notes:
 *  - Storage key is namespaced (audit-os:gst-notice-check) so it lives
 *    alongside the other audit-os:* keys and won’t collide.
 *  - Read is defensive — any parse error just returns an empty map rather
 *    than crashing the page.
 *  - We don’t track who checked it here; the audit trail is a server
 *    concern.
 */

const STORAGE_KEY = 'audit-os:gst-notice-check';

export type NoticeOutcome = 'clear' | 'found';

export interface NoticeCheckEntry {
  lastCheckedAt: string;  // ISO
  outcome: NoticeOutcome;
  note?: string;
}

export type NoticeCheckLog = Record<string, NoticeCheckEntry>;

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
  clientId: string,
  outcome: NoticeOutcome,
  note?: string,
): NoticeCheckLog {
  const log = readNoticeLog();
  const next: NoticeCheckLog = {
    ...log,
    [clientId]: {
      lastCheckedAt: new Date().toISOString(),
      outcome,
      note,
    },
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota exceeded / storage disabled — non-fatal.
  }
  return next;
}

export function clearNoticeLog(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Days between now and the ISO date, floored to whole days. */
export function daysSinceISO(iso: string): number {
  const then = new Date(iso).getTime();
  const now = Date.now();
  return Math.max(0, Math.floor((now - then) / (24 * 60 * 60 * 1000)));
}
