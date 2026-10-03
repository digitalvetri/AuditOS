/// <reference lib="webworker" />
/**
 * AuditOS service worker — built by vite-plugin-pwa (injectManifest).
 *
 *  · Precaches the app shell (hashed JS/CSS/fonts/icons) so the installed app
 *    opens instantly and still shows its frame when the network drops.
 *  · NEVER caches /api or /socket.io: every response there is per-user,
 *    permission-scoped data.
 *  · Shows Web Push notifications and routes a click to the record.
 *  · Waits for the page to say "update" before activating a new version, so a
 *    half-filled invoice or quotation is never reloaded from under someone.
 */
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

declare let self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

const NOT_APP = [/^\/api\//, /^\/socket\.io\//, /^\/mockServiceWorker\.js$/];

// SPA navigations: always the precached shell. It is the index.html that
// matches the precached JS/CSS, so it can never point at assets a newer
// deploy has removed; a new release arrives as a new worker and the page's
// "Reload" prompt switches over when the user is ready.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: NOT_APP }));

// Same-origin static files that are not in the precache (images under
// /public, lazily-added fonts): cache first, bounded.
registerRoute(
  ({ url, request }) => url.origin === self.location.origin
    && !NOT_APP.some((re) => re.test(url.pathname))
    && ['image', 'font'].includes(request.destination),
  new CacheFirst({
    cacheName: 'auditos-static',
    plugins: [new ExpirationPlugin({ maxEntries: 120, maxAgeSeconds: 30 * 24 * 60 * 60 })],
  }),
);

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ── Web Push ───────────────────────────────────────────────────────────────
interface PushData { id: string; title: string; body: string; action_url: string | null; module: string }

self.addEventListener('push', (event) => {
  let data: PushData;
  try {
    data = event.data?.json() as PushData;
  } catch {
    data = { id: String(Date.now()), title: 'AuditOS', body: event.data?.text() ?? '', action_url: null, module: 'system' };
  }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const focused = windows.find((w) => w.focused && w.visibilityState === 'visible');
    // The open, focused app already got this over the socket and showed its
    // own toast — just nudge it, don't double up with a system banner.
    if (focused) {
      focused.postMessage({ type: 'PUSH_RECEIVED', notification: data });
      return;
    }
    await self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.id,
      icon: '/pwa/icon-192.png',
      badge: '/pwa/badge-96.png',
      data: { url: data.action_url || '/notifications', id: data.id },
      timestamp: Date.now(),
    } as NotificationOptions);
    // Unread badge on the installed app's icon, where the platform supports it.
    const nav = self.navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void> };
    await nav.setAppBadge?.().catch(() => {});
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data?.url as string) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: 'NAVIGATE', url: target, id: event.notification.data?.id });
      return;
    }
    await self.clients.openWindow(target);
  })());
});
