import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

/**
 * `/api/*` and `/socket.io` are proxied to the Express backend — which keeps
 * the app same-origin, so the session cookie works without any CORS or
 * SameSite gymnastics and no component changes URL.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000';

  return {
    plugins: [
      react(),
      // Installable app + offline shell + Web Push (src/sw.ts). The service
      // worker is registered from src/platform/pwa — never in mock mode, where
      // MSW's worker owns the same scope.
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        injectRegister: false,
        registerType: 'prompt',
        devOptions: { enabled: true, type: 'module', navigateFallback: 'index.html' },
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,woff2,svg,png,ico,webmanifest}'],
          globIgnores: ['mockServiceWorker.js', 'brand/**', 'login-hero.png', 'jns-logo.png'],
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        },
        manifest: {
          id: '/',
          name: 'JNS Accounting — AuditOS',
          short_name: 'JNS AuditOS',
          description: 'Practice workspace for JNS Accounting Solutions — clients, filings, HR and payroll.',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          orientation: 'any',
          background_color: '#f7f4ff',
          theme_color: '#f7f4ff',
          categories: ['business', 'finance', 'productivity'],
          icons: [
            { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/pwa/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
            { src: '/pwa/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
          shortcuts: [
            { name: 'Dashboard', url: '/', icons: [{ src: '/pwa/icon-192.png', sizes: '192x192' }] },
            { name: 'Clients', url: '/workstation/clients', icons: [{ src: '/pwa/icon-192.png', sizes: '192x192' }] },
            { name: 'Attendance', url: '/hrms/attendance', icons: [{ src: '/pwa/icon-192.png', sizes: '192x192' }] },
            { name: 'Notifications', url: '/notifications', icons: [{ src: '/pwa/icon-192.png', sizes: '192x192' }] },
          ],
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    server: {
      port: 5173,
      strictPort: true,
      // Listen on the office network too, not only this computer: "Send on
      // WhatsApp" shows a QR code that a phone on the same Wi-Fi opens
      // (/send) to share the PDF with WhatsApp as an attachment.
      host: true,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: false },
        // Socket.IO transport for Messages realtime.
        '/socket.io': { target: apiTarget, ws: true, changeOrigin: false },
      },
    },
  };
});
