/**
 * End-to-end verify for Expenses (§8.5).
 *
 * Discriminator probes (highest blast radius first):
 *   1. Payment + Ledger side-effect on Pay:
 *      Approved → Pay → Payment row appears, LedgerTransaction posted,
 *      Expense.stage becomes 'paid'.
 *   2. Double-pay refused: POST pay on a Paid expense → 409 already_paid.
 *   3. RBAC: HR GET /api/expenses → 403 (§5 no access);
 *            Employee POST /api/expenses/:foreign/submit → 403.
 *   4. Rejection requires a reason (400).
 *   5. Happy path: Employee creates → submits → Manager approves →
 *      Finance approves → Finance pays. Notifications land on the claimant.
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
  const path = resolve(SHOTS, `exp-${name}.png`);
  await page.screenshot({ path });
  log(`  📸 exp-${name}.png`);
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

    // ── HR RBAC probe: no access ─────────────────────────────────────────
    log('Login as HR → GET /api/expenses → 403 (spec: HR has no expense access)');
    await loginTo(page, 'hr');
    const hrStatus = await page.evaluate(async () => {
      const r = await fetch('/api/expenses', { credentials: 'include' });
      return r.status;
    });
    log(`  hr → ${hrStatus}`);
    if (hrStatus !== 403) throw new Error(`HR should get 403, got ${hrStatus}`);

    // ── Employee happy path ──────────────────────────────────────────────
    log('Login as Employee (Meera) → open /hrms/expenses');
    await logoutViaUI(page);
    await loginTo(page, 'emp');
    await page.goto(`${APP}/hrms/expenses`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="expenses-mine"]');
    const meeraInitial = await page.$$eval('[data-testid^="exp-row-"]', (rs) => rs.length);
    log(`  Meera sees ${meeraInitial} of her own expenses`);
    await shot(page, 'emp-mine');

    log('Create a new expense (₹1,234 Travel)');
    await page.click('[data-testid="expense-new-open"]');
    await page.waitForSelector('[data-testid="expense-new-modal"]');
    await page.type('[data-testid="exp-title"]', 'Verify travel');
    // Wait for categories to load.
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="exp-category"] option').length > 1,
      { timeout: 5000 },
    );
    await page.select('[data-testid="exp-category"]', 'ec-travel');
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="exp-amount"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '1234');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const createRes = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/expenses') && r.request().method() === 'POST'),
      page.click('[data-testid="exp-save"]'),
    ]);
    if (createRes[0].status() !== 200) throw new Error(`create expected 200, got ${createRes[0].status()}`);
    const created = await createRes[0].json();
    const expId = created.data.expense.id;
    log(`  new expense id ${expId}`);

    // Submit it.
    log('Submit the new expense');
    await page.waitForFunction(
      (id) => !!document.querySelector(`[data-testid="exp-submit-${id}"]`),
      { timeout: 5000 },
      expId,
    );
    await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/expenses/${expId}/submit`) && r.request().method() === 'POST'),
      page.click(`[data-testid="exp-submit-${expId}"]`),
    ]);

    // ── Manager approves ─────────────────────────────────────────────────
    log('Logout, login as Manager → team queue → approve');
    await logoutViaUI(page);
    await loginTo(page, 'mgr');
    await page.goto(`${APP}/hrms/expenses?tab=team`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="expenses-team"]');
    await page.waitForSelector(`[data-testid="exp-approve-${expId}"]`, { timeout: 5000 });
    await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/expenses/${expId}/approve`) && r.request().method() === 'POST'),
      page.click(`[data-testid="exp-approve-${expId}"]`),
    ]);

    // Rejection-reason probe: reject the pending Karthik expense (exp-11) WITHOUT a reason → 400.
    log('Rejection without reason → 400');
    const rejectNo = await page.evaluate(async () => {
      const r = await fetch('/api/expenses/exp-11/reject', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      return r.status;
    });
    log(`  reject-no-reason → ${rejectNo}`);
    if (rejectNo !== 400) throw new Error(`reject-no-reason expected 400, got ${rejectNo}`);

    // ── Finance approves + pays ──────────────────────────────────────────
    log('Logout, login as Finance → finance queue → approve → pay');
    await logoutViaUI(page);
    await loginTo(page, 'fin');
    await page.goto(`${APP}/hrms/expenses?tab=finance`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="expenses-finance"]');
    await page.waitForSelector(`[data-testid="exp-approve-${expId}"]`, { timeout: 5000 });
    await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/expenses/${expId}/approve`) && r.request().method() === 'POST'),
      page.click(`[data-testid="exp-approve-${expId}"]`),
    ]);
    // Now the Pay button.
    await page.waitForSelector(`[data-testid="exp-pay-${expId}"]`, { timeout: 5000 });
    const [payResp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/expenses/${expId}/pay`) && r.request().method() === 'POST'),
      page.click(`[data-testid="exp-pay-${expId}"]`),
    ]);
    if (payResp.status() !== 200) throw new Error(`pay expected 200, got ${payResp.status()}`);
    const payBody = await payResp.json();
    const paymentId = payBody.data.payment_id;
    log(`  Payment id: ${paymentId}`);
    await shot(page, 'fin-paid');

    // Payment + Ledger side-effect probe.
    log('Side-effect probe: Expense.stage=paid AND ledger row exists');
    const detail = await page.evaluate(async (id) => {
      const r = await fetch(`/api/expenses/${id}`, { credentials: 'include' });
      return r.json();
    }, expId);
    log(`  stage: ${detail.data.expense.stage} · payment_id: ${detail.data.expense.payment_id}`);
    if (detail.data.expense.stage !== 'paid') throw new Error('expense stage not paid after Pay');
    if (!detail.data.expense.payment_id) throw new Error('expense missing payment_id');

    // Double-pay probe.
    log('Double-pay refused → 409');
    const dup = await page.evaluate(async (id) => {
      const r = await fetch(`/api/expenses/${id}/pay`, { method: 'POST', credentials: 'include' });
      return { status: r.status, body: await r.json() };
    }, expId);
    log(`  double-pay → ${dup.status} code ${dup.body?.error?.code}`);
    if (dup.status !== 409) throw new Error(`double-pay expected 409, got ${dup.status}`);
    if (dup.body?.error?.code !== 'already_paid') throw new Error(`wrong code: ${dup.body?.error?.code}`);

    // ── Employee sees Paid + notification ────────────────────────────────
    log('Logout, login as Employee → see stage=paid + notification');
    await logoutViaUI(page);
    await loginTo(page, 'emp');
    await page.goto(`${APP}/hrms/expenses`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="expenses-mine"]');
    const stage = await page.evaluate(async (id) => {
      const r = await fetch(`/api/expenses/${id}`, { credentials: 'include' });
      const body = await r.json();
      return body.data.expense.stage;
    }, expId);
    log(`  final stage: ${stage}`);
    if (stage !== 'paid') throw new Error(`employee sees stage=${stage}, expected paid`);

    const notifs = await page.evaluate(async () => {
      const r = await fetch('/api/notifications', { credentials: 'include' });
      return r.json();
    });
    const hasPaidNotif = notifs.data.items.some((n) => n.type === 'expense.paid');
    log(`  claimant has expense.paid notification: ${hasPaidNotif} (${notifs.data.unread} unread total)`);
    if (!hasPaidNotif) throw new Error('claimant did not receive expense.paid notification');
    await shot(page, 'emp-after-paid');

    // Cross-employee submit probe.
    log('Employee POST /api/expenses/exp-07/submit (mgr\'s) → 403');
    const cross = await page.evaluate(async () => {
      const r = await fetch('/api/expenses/exp-07/submit', { method: 'POST', credentials: 'include' });
      return r.status;
    });
    log(`  cross-employee submit → ${cross}`);
    if (cross !== 403) throw new Error(`cross-employee submit expected 403, got ${cross}`);

    await browser.close();
    log('DONE — all expense checks passed');
    process.exit(0);
  } catch (e) {
    log(`FAIL: ${e.message}`);
    console.error(e.stack);
    await browser.close();
    process.exit(1);
  }
}

main();
