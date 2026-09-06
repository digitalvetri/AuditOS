import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * In mock mode MSW intercepts `/api/*` inside the browser and the proxy is
 * never reached. In real mode the same relative URLs are proxied to the
 * Express backend — which keeps the app same-origin, so the session cookie
 * works without any CORS or SameSite gymnastics and no component changes URL.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000';

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: false },
        // Socket.IO transport for Messages realtime.
        '/socket.io': { target: apiTarget, ws: true, changeOrigin: false },
      },
    },
  };
});
