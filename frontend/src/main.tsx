import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installDocumentPrint } from '@/modules/workstation/print';
import { installPhoneTables } from '@/lib/phoneTables';
// Self-hosted Inter — bundled with the app so Brave Shields / strict
// tracking-protection browsers can't strip the CDN and fall back to
// Segoe UI, which has different metrics and shifts the whole layout.
import '@fontsource-variable/inter/index.css';
// Geist — the Teal & Coral UI face (self-hosted for the same reason as Inter;
// Inter stays loaded as the fallback). Geist Mono sets codes and GSTINs.
import '@fontsource-variable/geist/index.css';
// Plus Jakarta Sans — the Pastel Bento UI face.
import '@fontsource-variable/plus-jakarta-sans/index.css';
import '@fontsource-variable/geist-mono/index.css';
// Instrument Serif — the dashboard greeting only.
import '@fontsource/instrument-serif/latin-400.css';
import '@fontsource/instrument-serif/latin-400-italic.css';
// Poppins for display figures (dashboard numbers) — Latin, 600/700 only.
import '@fontsource/poppins/latin-600.css';
import '@fontsource/poppins/latin-700.css';
import '@/design/globals.css';
// Mobile-only layer (≤767px). Imported after globals so its media-scoped
// rules win at phone widths; contributes nothing at 768px and up.
import '@/design/mobile.css';
// Dark-theme washes for the components' hand-picked pastel colours.
import '@/design/dark-tints.css';
// Chat surface: wallpaper, bubbles, day marks. Scoped to the messages screen.
import '@/design/chat.css';

function boot() {
  // Quotations, invoices, letters: print the document alone, on its own paper size.
  installDocumentPrint();
  installPhoneTables();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

boot();
