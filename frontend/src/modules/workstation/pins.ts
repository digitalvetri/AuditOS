/**
 * Pinned clients — a per-user shortlist shown in the sidebar and toggled from
 * the Client 360 panel. Stored in this browser only (localStorage): it is a
 * personal convenience, not shared data, so it needs no API.
 */
import { useCallback, useEffect, useState } from 'react';

const KEY = 'audit-os:pinned-clients';
const EVENT = 'audit-os:pins-changed';
const MAX = 8;

export interface PinnedClient { id: string; name: string }

function read(): PinnedClient[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as PinnedClient[]) : [];
    return Array.isArray(list) ? list.filter((p) => p && typeof p.id === 'string') : [];
  } catch {
    return [];
  }
}

function write(list: PinnedClient[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch { /* storage blocked — pins simply don't persist */ }
  window.dispatchEvent(new Event(EVENT));
}

export function usePinnedClients() {
  const [pins, setPins] = useState<PinnedClient[]>(read);
  useEffect(() => {
    const sync = () => setPins(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const isPinned = useCallback((id: string) => pins.some((p) => p.id === id), [pins]);
  const toggle = useCallback((client: PinnedClient) => {
    const list = read();
    write(list.some((p) => p.id === client.id) ? list.filter((p) => p.id !== client.id) : [client, ...list]);
  }, []);

  return { pins, isPinned, toggle };
}
