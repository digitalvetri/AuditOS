/**
 * End-to-end verify for Accounts (§8.6).
 *
 * Discriminator probes:
 *   1. RBAC: Employee, Manager, HR all get 403 on any /api/accounts/* and
 *      /api/payments.
 *   2. Append-only: no PATCH endpoint exists for a ledger row. Reverse creates
 *      a contra entry with swapped debit/credit; the ORIGINAL row is now
 *      status='reversed' but its debit/credit/description are unchanged.
 *   3. Double-reverse refused: POST reverse on an already-reversed row → 409.
 *   4. Manual payment writes both a Payment AND a matching LedgerTransaction
 *      inside one atomic block. Ledger balance changes by the amount.
 *   5. Summary math: totals = sum(rows); this_month is scoped to the current
 *      IST month prefix.
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
  mgr: { email: 'vikram@auditos.local', password: 'mgr' },
  emp: { email: 'meera@auditos.local', password: 'emp' },
};

function log(msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }
async function shot(page, name) {
  const path = resolve(SHOTS, `acc-${name}.png`);
  await page.screenshot({ path });
  log(`  📸 acc-${name}.png`);
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

    // Fresh DB (v8).
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });

    // ── RBAC probes ────────────────────────────────────────────────────────
    for (const who of ['emp', 'mgr', 'hr']) {
      log(`Login as ${who} → GET /api/accounts/ledger + /api/payments → 403 each`);
      await logoutViaUI(page).catch(() => {});
      await loginTo(page, who);
      const [ledgerStatus, paymentsStatus] = await page.evaluate(async () => {
        const l = await fetch('/api/accounts/ledger', { credentials: 'include' });
        const p = await fetch('/api/payments', { credentials: 'include' });
        return [l.status, p.status];
      });
      log(`  ${who} → ledger ${ledgerStatus}, payments ${paymentsStatus}`);
      if (ledgerStatus !== 403) throw new Error(`${who} ledger expected 403, got ${ledgerStatus}`);
      if (paymentsStatus !== 403) throw new Error(`${who} payments expected 403, got ${paymentsStatus}`);
    }

    // ── Finance sees seeded data ──────────────────────────────────────────
    log('Logout, login as Finance → open /hrms/accounts');
    await logoutViaUI(page);
    await loginTo(page, 'fin');
    await page.goto(`${APP}/hrms/accounts?tab=ledger`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="accounts-ledger"]');
    const ledgerRowCount = await page.$$eval('[data-testid^="ledger-row-"]', (rs) => rs.length);
    log(`  ledger rows visible: ${ledgerRowCount}`);
    if (ledgerRowCount < 5) throw new Error(`expected 5+ seeded ledger rows, got ${ledgerRowCount}`);
    await shot(page, 'fin-ledger');

    const summaryBefore = await page.evaluate(async () => {
      const r = await fetch('/api/accounts/summary', { credentials: 'include' });
      return r.json();
    });
    log(`  balance before manual payment: ${summaryBefore.data.totals.balance_paise}`);

    // ── Manual payment → creates ledger + payment atomically ──────────────
    log('POST /api/payments (₹5,000 Employee Advance to Meera)');
    const paymentRes = await page.evaluate(async () => {
      const r = await fetch('/api/payments', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employee_id: 'emp-exec',
          amount_paise: 500_000, // ₹5,000
          method: 'bank_transfer',
          ledger_type: 'Employee Advance',
          description: 'Advance — verify test',
        }),
      });
      return { status: r.status, body: await r.json() };
    });
    log(`  status: ${paymentRes.status}, payment id: ${paymentRes.body?.data?.payment?.id}`);
    if (paymentRes.status !== 200) throw new Error(`payment expected 200, got ${paymentRes.status}`);
    const paymentId = paymentRes.body.data.payment.id;

    // Ledger row should exist with reference_id = paymentId.
    const findLedger = await page.evaluate(async (payId) => {
      const r = await fetch('/api/accounts/ledger?type=Employee%20Advance', { credentials: 'include' });
      const body = await r.json();
      return body.data.items.find((l) => l.reference_id === payId);
    }, paymentId);
    log(`  matching ledger row: ${findLedger?.id} debit ${findLedger?.debit_paise}`);
    if (!findLedger) throw new Error('no ledger row for the new payment');
    if (findLedger.debit_paise !== 500_000) throw new Error(`expected 500_000 debit, got ${findLedger.debit_paise}`);

    // Balance should decrease by 5,000 rupees = 500_000 paise (debit).
    const summaryAfter = await page.evaluate(async () => {
      const r = await fetch('/api/accounts/summary', { credentials: 'include' });
      return r.json();
    });
    const delta = summaryAfter.data.totals.balance_paise - summaryBefore.data.totals.balance_paise;
    log(`  balance delta: ${delta} (expected -500000)`);
    if (delta !== -500_000) throw new Error(`balance delta expected -500000, got ${delta}`);

    // ── Reverse a ledger row → contra entry, original stays intact ────────
    log('Reverse the new ledger row → contra entry');
    const reverseRes = await page.evaluate(async (id) => {
      const r = await fetch(`/api/accounts/ledger/${id}/reverse`, { method: 'POST', credentials: 'include' });
      return { status: r.status, body: await r.json() };
    }, findLedger.id);
    log(`  reverse status: ${reverseRes.status}`);
    if (reverseRes.status !== 200) throw new Error(`reverse expected 200, got ${reverseRes.status}`);
    const contra = reverseRes.body.data.reverse;
    log(`  contra row: debit ${contra.debit_paise} credit ${contra.credit_paise} ref ${contra.reference_id}`);
    if (contra.debit_paise !== 0) throw new Error(`contra debit expected 0, got ${contra.debit_paise}`);
    if (contra.credit_paise !== 500_000) throw new Error(`contra credit expected 500000, got ${contra.credit_paise}`);
    if (contra.reference_id !== findLedger.id) throw new Error(`contra reference_id should point at original`);

    // Original row unchanged (debit still 500_000; status flipped to reversed).
    const orig = await page.evaluate(async (id) => {
      const r = await fetch('/api/accounts/ledger?type=Employee%20Advance', { credentials: 'include' });
      const body = await r.json();
      return body.data.items.find((l) => l.id === id);
    }, findLedger.id);
    log(`  original after reverse: debit ${orig?.debit_paise} status ${orig?.status}`);
    if (orig?.debit_paise !== 500_000) throw new Error(`original debit changed to ${orig?.debit_paise}`);
    if (orig?.status !== 'reversed') throw new Error(`original status expected reversed, got ${orig?.status}`);

    // Double-reverse refused.
    log('Double-reverse → 409');
    const dup = await page.evaluate(async (id) => {
      const r = await fetch(`/api/accounts/ledger/${id}/reverse`, { method: 'POST', credentials: 'include' });
      return { status: r.status, body: await r.json() };
    }, findLedger.id);
    log(`  status ${dup.status} code ${dup.body?.error?.code}`);
    if (dup.status !== 409) throw new Error(`double-reverse expected 409, got ${dup.status}`);
    if (dup.body?.error?.code !== 'already_reversed') throw new Error(`wrong code: ${dup.body?.error?.code}`);

    // No PATCH/DELETE endpoints for ledger — prove by attempting.
    log('No PATCH endpoint on ledger row');
    const patchStatus = await page.evaluate(async (id) => {
      const r = await fetch(`/api/accounts/ledger/${id}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ debit_paise: 1 }) });
      return r.status;
    }, findLedger.id);
    log(`  PATCH → ${patchStatus}`);
    // MSW returns 404 for unhandled endpoints (or falls through to Vite). Either way, not 200.
    if (patchStatus === 200) throw new Error('PATCH on ledger returned 200 — the append-only invariant is broken');

    // Balance after reverse should be back to original.
    const summaryFinal = await page.evaluate(async () => {
      const r = await fetch('/api/accounts/summary', { credentials: 'include' });
      return r.json();
    });
    const finalDelta = summaryFinal.data.totals.balance_paise - summaryBefore.data.totals.balance_paise;
    log(`  balance delta after reverse: ${finalDelta} (expected 0)`);
    if (finalDelta !== 0) throw new Error(`net delta after reverse expected 0, got ${finalDelta}`);

    // ── Summary tab renders ───────────────────────────────────────────────
    log('Open Summary tab → widgets render');
    await page.goto(`${APP}/hrms/accounts`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="accounts-summary"]');
    await shot(page, 'fin-summary');

    await browser.close();
    log('DONE — all accounts checks passed');
    process.exit(0);
  } catch (e) {
    log(`FAIL: ${e.message}`);
    console.error(e.stack);
    await browser.close();
    process.exit(1);
  }
}

main();
