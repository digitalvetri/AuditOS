import { http, HttpResponse } from 'msw';

/**
 * Tools need the real backend (LibreOffice, Ghostscript, OCR). In mock mode
 * every tools endpoint answers with one honest message instead of a hang.
 */
const unavailable = () =>
  HttpResponse.json(
    { error: { code: 'mock_mode', message: 'Tools need the real backend. Set VITE_MOCK_MODE=false and run npm run dev:full.' } },
    { status: 503 },
  );

export const toolsHandlers = [
  http.all('/api/tools', unavailable),
  http.all('/api/tools/*', unavailable),
  http.all('/api/tool-jobs/*', unavailable),
  http.all('/api/tool-documents', unavailable),
  http.all('/api/tool-documents/*', unavailable),
];
