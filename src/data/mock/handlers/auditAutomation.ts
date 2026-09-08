import { http, HttpResponse } from 'msw';

/**
 * Audit Automation mocks. Bank list and accounts render offline so the
 * upload wireframe is browseable in VITE_MOCK_MODE without the API. Uploads,
 * jobs and everything that needs pdfjs / password decryption route to the
 * real backend — the mock mirrors the message the Tools handlers use so
 * developers see one consistent hint.
 */

const AA_BANKS = [
  { id: 'hdfc-bank', key: 'hdfc-bank', name: 'HDFC Bank', order: 10 },
  { id: 'icici-bank', key: 'icici-bank', name: 'ICICI Bank', order: 20 },
  { id: 'sbi', key: 'sbi', name: 'State Bank of India', order: 30 },
  { id: 'axis-bank', key: 'axis-bank', name: 'Axis Bank', order: 40 },
  { id: 'kotak-mahindra', key: 'kotak-mahindra', name: 'Kotak Mahindra Bank', order: 50 },
  { id: 'indian-bank', key: 'indian-bank', name: 'Indian Bank', order: 60 },
  { id: 'canara-bank', key: 'canara-bank', name: 'Canara Bank', order: 70 },
  { id: 'tmb', key: 'tmb', name: 'Tamilnad Mercantile Bank', order: 80 },
  { id: 'karur-vysya', key: 'karur-vysya', name: 'Karur Vysya Bank', order: 90 },
  { id: 'city-union', key: 'city-union', name: 'City Union Bank', order: 100 },
  { id: 'generic', key: 'generic', name: 'Other / not listed', order: 999 },
];

const unavailable = () =>
  HttpResponse.json(
    {
      error: {
        code: 'mock_mode',
        message: 'Audit Automation uploads need the real backend. Set VITE_MOCK_MODE=false and run npm run dev:full.',
      },
    },
    { status: 503 },
  );

export const auditAutomationHandlers = [
  http.get('/api/audit-automation/banks', () =>
    HttpResponse.json({ data: { items: AA_BANKS, count: AA_BANKS.length } }),
  ),
  http.get('/api/audit-automation/accounts', () =>
    HttpResponse.json({ data: { items: [], count: 0 } }),
  ),
  http.post('/api/audit-automation/accounts', unavailable),
  http.post('/api/audit-automation/uploads', unavailable),
  http.get('/api/audit-automation/jobs', () =>
    HttpResponse.json({ data: { items: [], count: 0 } }),
  ),
  http.get('/api/audit-automation/jobs/:id', unavailable),

  // ── GST reconciliation ─────────────────────────────────────────────
  // Uploads / recon / rows / export all need the real backend (parsers +
  // matcher run there). Lists return empty in mock mode so the pages
  // render an honest empty state instead of erroring.
  http.get('/api/audit-automation/gst/2b', () =>
    HttpResponse.json({ data: { items: [] } }),
  ),
  http.get('/api/audit-automation/gst/purchase-registers', () =>
    HttpResponse.json({ data: { items: [] } }),
  ),
  http.get('/api/audit-automation/gst/recon', () =>
    HttpResponse.json({ data: { items: [] } }),
  ),
  http.post('/api/audit-automation/gst/2b/uploads', unavailable),
  http.post('/api/audit-automation/gst/purchase-registers/uploads', unavailable),
  http.post('/api/audit-automation/gst/recon', unavailable),
  http.get('/api/audit-automation/gst/recon/:id', unavailable),
  http.get('/api/audit-automation/gst/recon/:id/rows', unavailable),
  http.patch('/api/audit-automation/gst/recon/rows/:id', unavailable),

  // ── TDS reconciliation ─────────────────────────────────────────────
  http.get('/api/audit-automation/tds/26as', () =>
    HttpResponse.json({ data: { items: [] } }),
  ),
  http.get('/api/audit-automation/tds/books', () =>
    HttpResponse.json({ data: { items: [] } }),
  ),
  http.get('/api/audit-automation/tds/recon', () =>
    HttpResponse.json({ data: { items: [] } }),
  ),
  http.post('/api/audit-automation/tds/26as/uploads', unavailable),
  http.post('/api/audit-automation/tds/books/uploads', unavailable),
  http.post('/api/audit-automation/tds/recon', unavailable),
  http.get('/api/audit-automation/tds/recon/:id', unavailable),
  http.get('/api/audit-automation/tds/recon/:id/rows', unavailable),
  http.patch('/api/audit-automation/tds/recon/rows/:id', unavailable),
];
