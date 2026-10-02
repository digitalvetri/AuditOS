/**
 * End-to-end verify for the Documents module (§8.8).
 *
 * Covers:
 *   - Employee sees only own documents (scope)
 *   - Finance is denied outright (403)
 *   - HR uploads to Meera → list refreshes with the new row
 *   - Download uses the two-step signed URL:
 *       GET /documents/:id/download-url → { url, expires_at }
 *       GET url → 200 with bytes
 *     Bad token → 403
 *   - Expiring docs (< 30d) surface in Pending Actions on manager/HR dashboard
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = 'http://localhost:5173';
const SHOTS = resolve('scripts/shots');
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

const LOGINS = {
  md: { email: 'ravi@auditos.local', password: 'md' },
  hr: { email: 'priya@auditos.local', password: 'hr' },
  fin: { email: 'anitha@auditos.local', password: 'fin' },
  emp: { email: 'meera@auditos.local', password: 'emp' },
};

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}
async function shot(page, name) {
  const path = resolve(SHOTS, `doc-${name}.png`);
  await page.screenshot({ path });
  log(`  📸 doc-${name}.png`);
}

async function loginTo(page, who) {
  const { email, password } = LOGINS[who];
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle0', timeout: 15000 });
  await page.waitForSelector('input[type="email"]', { timeout: 5000 });
  await page.evaluate(() => {
    document.querySelector('input[type="email"]').value = '';
    document.querySelector('input[type="password"]').value = '';
  });
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.location.pathname === '/', { timeout: 15000 });
  await page.waitForSelector('aside nav a', { timeout: 5000 });
}
async function logoutViaUI(page) {
  await page.goto(APP, { waitUntil: 'networkidle0' });
  const trigger = await page.$('button[aria-haspopup="menu"]');
  if (!trigger) return;
  await trigger.click();
  await page.waitForSelector('div[role="menu"]', { timeout: 3000 });
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('button[role="menuitem"]'));
    const logout = items.find((b) => b.textContent.trim() === 'Log out');
    logout?.click();
  });
  await page.waitForSelector('input[type="email"]', { timeout: 5000 });
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1440, height: 900 },
  });

  try {
    const page = await browser.newPage();
    page.on('pageerror', (err) => log(`  pageerror: ${err.message}`));

    // Fresh DB (v5).
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });

    // ── HR view: full list with seeded docs ────────────────────────────────
    log('Login as HR');
    await loginTo(page, 'hr');
    await page.goto(`${APP}/hrms/documents`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="documents-table"]');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid^="document-row-"]').length > 0,
      { timeout: 5000 },
    );
    const hrCount = await page.$$eval('[data-testid^="document-row-"]', (rs) => rs.length);
    log(`  HR sees ${hrCount} documents`);
    if (hrCount < 5) throw new Error(`HR should see 5+ documents, got ${hrCount}`);
    await shot(page, 'hr-list');

    // ── HR uploads a new document to Meera ─────────────────────────────────
    log('HR uploads a new document for Meera');
    await page.click('[data-testid="document-upload-open"]');
    await page.waitForSelector('[data-testid="document-upload-modal"]');
    await page.type('[data-testid="document-name"]', 'Test upload verify');
    await page.select('[data-testid="document-type"]', 'employment');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="document-employee"] option').length > 1,
      { timeout: 5000 },
    );
    await page.select('[data-testid="document-employee"]', 'emp-exec');
    const uploadResPromise = page.waitForResponse(
      (r) => r.url().endsWith('/api/documents') && r.request().method() === 'POST',
      { timeout: 5000 },
    );
    await page.click('[data-testid="document-submit"]');
    const uploadRes = await uploadResPromise;
    log(`  upload status: ${uploadRes.status()}`);
    if (uploadRes.status() !== 200) throw new Error(`upload expected 200, got ${uploadRes.status()}`);
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="document-upload-modal"]'),
      { timeout: 5000 },
    );
    // Wait for list refresh + new count.
    await page.waitForFunction(
      (prev) => document.querySelectorAll('[data-testid^="document-row-"]').length > prev,
      { timeout: 5000 },
      hrCount,
    );
    const afterHrCount = await page.$$eval('[data-testid^="document-row-"]', (rs) => rs.length);
    log(`  HR list after upload: ${afterHrCount}`);
    if (afterHrCount !== hrCount + 1) throw new Error(`list did not grow after upload`);
    await shot(page, 'hr-after-upload');

    // ── Two-step download flow ─────────────────────────────────────────────
    log('Two-step signed URL: GET download-url, then GET url');
    const dlRes = await page.evaluate(async () => {
      const listR = await fetch('/api/documents', { credentials: 'include' });
      const list = await listR.json();
      const first = list.data.items[0];
      const urlR = await fetch(`/api/documents/${first.id}/download-url`, { credentials: 'include' });
      const urlJson = await urlR.json();
      const bytesR = await fetch(urlJson.data.url, { credentials: 'include' });
      const text = await bytesR.text();
      return {
        docId: first.id,
        url: urlJson.data.url,
        expires_at: urlJson.data.expires_at,
        bytesStatus: bytesR.status,
        bodyPreview: text.slice(0, 60),
      };
    });
    log(`  url: ${dlRes.url}`);
    log(`  bytes: ${dlRes.bytesStatus} · body preview: "${dlRes.bodyPreview}"`);
    if (dlRes.bytesStatus !== 200) throw new Error(`download expected 200, got ${dlRes.bytesStatus}`);
    if (!/Audit OS/.test(dlRes.bodyPreview)) throw new Error(`body preview missing marker`);

    log('Bad token → 403');
    const badStatus = await page.evaluate(async (docId) => {
      const r = await fetch(`/api/documents/${docId}/download?t=totally-bogus`, {
        credentials: 'include',
      });
      return r.status;
    }, dlRes.docId);
    log(`  bad token → ${badStatus}`);
    if (badStatus !== 403) throw new Error(`bad token expected 403, got ${badStatus}`);

    // ── Finance denied outright ────────────────────────────────────────────
    log('Logout, login as Finance');
    await logoutViaUI(page);
    await loginTo(page, 'fin');
    const finStatus = await page.evaluate(async () => {
      const r = await fetch('/api/documents', { credentials: 'include' });
      return r.status;
    });
    log(`  Finance GET /documents → ${finStatus}`);
    if (finStatus !== 403) throw new Error(`Finance expected 403, got ${finStatus}`);

    // ── Employee sees only own docs ────────────────────────────────────────
    log('Logout, login as Employee');
    await logoutViaUI(page);
    await loginTo(page, 'emp');
    const empRes = await page.evaluate(async () => {
      const r = await fetch('/api/documents', { credentials: 'include' });
      const body = await r.json();
      return {
        count: body.data.count,
        empIds: [...new Set(body.data.items.map((d) => d.employee_id))],
      };
    });
    log(`  Employee sees ${empRes.count} docs; employees seen: ${empRes.empIds.join(', ')}`);
    if (empRes.empIds.length !== 1 || empRes.empIds[0] !== 'emp-exec') {
      throw new Error(`Employee should only see own docs, saw: ${empRes.empIds.join(', ')}`);
    }

    // ── MD: pending actions includes expiring documents ───────────────────
    log('Logout, login as MD → pending actions should include the expiring passport');
    await logoutViaUI(page);
    await loginTo(page, 'md');
    // Fetch pending-actions directly — the widget aggregates data from a
    // single endpoint, this cuts UI timing out of the equation.
    const pendingApi = await page.evaluate(async () => {
      const r = await fetch('/api/dashboard/pending-actions', { credentials: 'include' });
      return r.json();
    });
    log(`  API returned ${pendingApi.data.count} items: ${pendingApi.data.items.map((i) => `${i.kind}:${i.title}`).join(' | ')}`);
    const hasExpiring = pendingApi.data.items.some((i) => i.kind === 'document_expiring');
    if (!hasExpiring) throw new Error('expiring document not in /api/dashboard/pending-actions');
    // Also confirm it renders in the widget after invalidation.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="pending-actions"]');
        return el && /Passport|expiring/i.test(el.textContent);
      },
      { timeout: 5000 },
    );
    await shot(page, 'md-pending-with-doc');

    await browser.close();
    log('DONE — all documents checks passed');
    process.exit(0);
  } catch (e) {
    log(`FAIL: ${e.message}`);
    console.error(e.stack);
    await browser.close();
    process.exit(1);
  }
}

main();
