import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import '@/design/globals.css';
// Mobile-only layer (≤767px). Imported after globals so its media-scoped
// rules win at phone widths; contributes nothing at 768px and up.
import '@/design/mobile.css';
// Chat surface: wallpaper, bubbles, day marks. Scoped to the messages screen.
import '@/design/chat.css';

const MOCK_MODE = import.meta.env.VITE_MOCK_MODE === 'true';

async function boot() {
  // In mock mode, start MSW BEFORE mounting React so the auth boot request
  // is intercepted. In non-mock mode we skip MSW entirely and the same
  // `fetch('/api/...')` calls hit a real backend (§2 swappability).
  if (MOCK_MODE) {
    const { worker } = await import('@/data/mock/browser');
    await worker.start({
      // 'warn', not 'bypass': an unmocked /api/* call still passes through
      // to the proxy, but it says so in the console. Books and Workstation
      // have no handlers, so in mock mode they fall through and fail with a
      // bare "Could not load …" — the warning is what makes that legible
      // instead of looking like a broken page.
      onUnhandledRequest: 'warn',
      quiet: true,
    });
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

boot();
