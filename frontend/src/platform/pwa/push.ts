/**
 * Web Push on this device: ask permission (only ever from a click), subscribe
 * the service worker, and register the endpoint with the API. The server
 * fans every notification out to these endpoints, so alerts arrive even when
 * no AuditOS tab is open.
 */
import { api } from '@/services/api';

export type PushState = 'unsupported' | 'insecure' | 'denied' | 'off' | 'on';

export function pushSupported(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  return (await currentSubscription()) ? 'on' : 'off';
}

function keyBytes(base64url: string): Uint8Array {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function send(sub: PushSubscription) {
  const json = sub.toJSON();
  await api.post('/api/notifications/push/subscribe', { endpoint: json.endpoint, keys: json.keys });
}

/** Turn push on. Must be called from a user gesture (permission prompt). */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const { public_key } = await api.get<{ public_key: string | null }>('/api/notifications/push/key');
  if (!public_key) throw new Error('Push is not configured on the server yet.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(public_key) as unknown as BufferSource,
    });
  }
  await send(sub);
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const sub = await currentSubscription();
  if (sub) {
    await api.post('/api/notifications/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => false);
  }
  return pushState();
}

/**
 * After sign-in: if this browser already allowed notifications, re-attach its
 * subscription to whoever is signed in now (logout detached it server-side).
 */
export async function resyncPush(): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const sub = await currentSubscription();
  if (sub) await send(sub).catch(() => {});
}
