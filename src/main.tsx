import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import '@/design/globals.css';

const MOCK_MODE = import.meta.env.VITE_MOCK_MODE === 'true';

async function boot() {
  // In mock mode, start MSW BEFORE mounting React so the auth boot request
  // is intercepted. In non-mock mode we skip MSW entirely and the same
  // `fetch('/api/...')` calls hit a real backend (§2 swappability).
  if (MOCK_MODE) {
    const { worker } = await import('@/data/mock/browser');
    await worker.start({
      onUnhandledRequest: 'bypass',
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
