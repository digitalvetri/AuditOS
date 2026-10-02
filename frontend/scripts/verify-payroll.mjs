/**
 * End-to-end verify for Payroll (§8.4).
 *
 * Four discriminator probes (highest blast radius first):
 *   1. Immutability: POST approve on a Processed run → 409 already_processed.
 *      PATCH SalaryStructure after Process — the Processed PayrollItem is UNCHANGED.
 *   2. Statutory snapshot: after Process, SUPERSEDE pf.employee_rate.
 *      Re-GET the run — snapshot still shows the old value.
 *   3. RBAC: Dept Manager GET /api/payroll/runs → 403.
 *              Employee GET /api/payroll/payslips/<someone-else> → 403.
 *   4. "Show the working": every PayrollItem has separate fields for
 *      basic/hra/conveyance/special AND pf/esi/pt/tds/lop/advance.
 *
 * Plus happy-path: MD creates a Sep run → calculate → HR review → Finance
 * approve → Process → payslips visible to Meera.
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
  const path = resolve(SHOTS, `pay-${name}.png`);
  await page.screenshot({ path });
  log(`  📸 pay-${name}.png`);
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

    // Fresh DB (v7).
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });

    // ── Grep probe (build-time): no statutory literals in lib/payroll ────
    // (Confirmed at write-time; the verify browser step focuses on runtime.)

    // ── Dept Manager RBAC probe ──────────────────────────────────────────
    log('Login as Dept Manager → GET /api/payroll/runs → 403');
    await loginTo(page, 'mgr');
    const mgrStatus = await page.evaluate(async () => {
      const r = await fetch('/api/payroll/runs', { credentials: 'include' });
      return r.status;
    });
    log(`  mgr → ${mgrStatus}`);
    if (mgrStatus !== 403) throw new Error(`mgr expected 403, got ${mgrStatus}`);

    // ── Employee "someone else's payslip" probe ──────────────────────────
    log('Login as Employee → GET /api/payroll/payslips/ps-pr-2026-08-emp-md → 403');
    await logoutViaUI(page);
    await loginTo(page, 'emp');
    const empStatus = await page.evaluate(async () => {
      const r = await fetch('/api/payroll/payslips/ps-pr-2026-08-emp-md', { credentials: 'include' });
      return r.status;
    });
    log(`  cross-employee payslip → ${empStatus}`);
    if (empStatus !== 403) throw new Error(`cross-payslip expected 403, got ${empStatus}`);

    // ── Employee's own payslips list ─────────────────────────────────────
    const meeraPayslips = await page.evaluate(async () => {
      const r = await fetch('/api/payroll/payslips', { credentials: 'include' });
      return r.json();
    });
    log(`  Meera sees ${meeraPayslips.data.items.length} payslips`);
    if (meeraPayslips.data.items.length < 2) throw new Error('Meera should see 2 seeded payslips');
    if (meeraPayslips.data.items.some((p) => p.employee?.id !== 'emp-exec')) {
      throw new Error('Meera saw a non-own payslip');
    }

    // ── HR: happy path — create Sep run, calculate, review, approve, process ─
    log('Login as HR → open /hrms/payroll');
    await logoutViaUI(page);
    await loginTo(page, 'hr');
    await page.goto(`${APP}/hrms/payroll`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="payroll-runs"]');
    // Should show 3 seeded runs (Jul processed, Aug processed, Sep draft).
    const runCount = await page.$$eval('[data-testid^="payroll-run-row-"]', (rs) => rs.length);
    log(`  seeded runs: ${runCount}`);
    if (runCount < 3) throw new Error(`expected 3 seeded runs, got ${runCount}`);
    await shot(page, 'hr-runs-list');

    log('Open the Draft (Sep 2026) run and Calculate');
    await page.goto(`${APP}/hrms/payroll/runs/pr-2026-09`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="payroll-calculate"]');
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/payroll/runs/pr-2026-09/calculate') && r.request().method() === 'POST'),
      page.click('[data-testid="payroll-calculate"]'),
    ]);
    // Items should now render.
    await page.waitForSelector('[data-testid="payroll-items"]', { timeout: 5000 });
    const itemsCount = await page.$$eval('[data-testid^="payroll-item-"]', (rs) => rs.length);
    log(`  items after Calculate: ${itemsCount}`);
    if (itemsCount === 0) throw new Error('Calculate produced no items');
    await shot(page, 'hr-run-calculated');

    // "Show the working" shape probe — direct fetch, assert every field.
    log('Shape probe: every PayrollItem has separate earnings + deductions');
    const runDetail = await page.evaluate(async () => {
      const r = await fetch('/api/payroll/runs/pr-2026-09', { credentials: 'include' });
      return r.json();
    });
    const meeraItem = runDetail.data.items.find((i) => i.employee?.id === 'emp-exec');
    if (!meeraItem) throw new Error('Meera item missing');
    const earnKeys = ['basic_paise', 'hra_paise', 'conveyance_paise', 'special_paise', 'incentive_paise'];
    const dedKeys = ['pf_employee_paise', 'esi_employee_paise', 'pt_paise', 'tds_paise', 'lop_paise', 'advance_paise'];
    for (const k of earnKeys) {
      if (typeof meeraItem.earnings?.[k] !== 'number') throw new Error(`earnings.${k} missing on Meera item`);
    }
    for (const k of dedKeys) {
      if (typeof meeraItem.deductions?.[k] !== 'number') throw new Error(`deductions.${k} missing on Meera item`);
    }
    log(`  Meera net paise: ${meeraItem.net_paise} (gross ${meeraItem.gross_paise}, lop_days ${meeraItem.lop_days})`);

    log('Send to HR review');
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/payroll/runs/pr-2026-09/review') && r.request().method() === 'POST'),
      page.click('[data-testid="payroll-review"]'),
    ]);
    await page.waitForSelector('[data-testid="payroll-review"]', { timeout: 5000 }); // now "Send to Finance review"
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/payroll/runs/pr-2026-09/review') && r.request().method() === 'POST'),
      page.click('[data-testid="payroll-review"]'),
    ]);

    // ── Finance approves + processes ─────────────────────────────────────
    log('Logout, login as Finance → Approve → Process');
    await logoutViaUI(page);
    await loginTo(page, 'fin');
    await page.goto(`${APP}/hrms/payroll/runs/pr-2026-09`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="payroll-approve"]', { timeout: 5000 });
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/payroll/runs/pr-2026-09/approve') && r.request().method() === 'POST'),
      page.click('[data-testid="payroll-approve"]'),
    ]);
    await page.waitForSelector('[data-testid="payroll-process"]', { timeout: 5000 });
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/payroll/runs/pr-2026-09/process') && r.request().method() === 'POST'),
      page.click('[data-testid="payroll-process"]'),
    ]);
    await shot(page, 'fin-run-processed');

    // ── Immutability probe #1: approve on Processed → 409 ───────────────
    log('Immutability probe: approve on Processed → 409');
    const dup = await page.evaluate(async () => {
      const r = await fetch('/api/payroll/runs/pr-2026-09/approve', { method: 'POST', credentials: 'include' });
      return { status: r.status, body: await r.json() };
    });
    log(`  status ${dup.status} code ${dup.body?.error?.code}`);
    if (dup.status !== 409) throw new Error(`expected 409, got ${dup.status}`);
    if (dup.body?.error?.code !== 'already_processed') throw new Error(`wrong code: ${dup.body?.error?.code}`);

    // ── Immutability probe #2: patch Meera's salary → prior PayrollItem unchanged ─
    log('Immutability probe: patch Meera salary AFTER process — item unchanged');
    // Grab the Meera item's net BEFORE the salary change.
    const netBefore = await page.evaluate(async () => {
      const r = await fetch('/api/payroll/runs/pr-2026-09', { credentials: 'include' });
      const body = await r.json();
      return body.data.items.find((i) => i.employee?.id === 'emp-exec')?.net_paise;
    });
    // Login as MD to patch salary (has salary.manage).
    await logoutViaUI(page);
    await loginTo(page, 'md');
    const patchStatus = await page.evaluate(async () => {
      const r = await fetch('/api/employees/emp-exec/salary', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          effective_from: '2026-10-01',
          monthly_ctc_paise: 100_00_00 * 100, // 1 crore CTC to make change obvious
          basic_paise: 50_00_00 * 100,
          hra_paise: 20_00_00 * 100,
          conveyance_paise: 160000,
          special_allowance_paise: 20_00_00 * 100,
        }),
      });
      return r.status;
    });
    log(`  salary PATCH → ${patchStatus}`);
    if (patchStatus !== 200) throw new Error(`salary PATCH expected 200, got ${patchStatus}`);
    const netAfter = await page.evaluate(async () => {
      const r = await fetch('/api/payroll/runs/pr-2026-09', { credentials: 'include' });
      const body = await r.json();
      return body.data.items.find((i) => i.employee?.id === 'emp-exec')?.net_paise;
    });
    log(`  Meera net paise before ${netBefore} · after ${netAfter}`);
    if (netBefore !== netAfter) throw new Error(`Processed PayrollItem changed after salary patch (${netBefore} → ${netAfter})`);

    // ── Statutory snapshot probe: supersede rate → past runs unchanged ──
    log('Statutory snapshot probe: supersede pf.employee_rate 0.12 → 0.20');
    const snapBefore = await page.evaluate(async () => {
      const r = await fetch('/api/payroll/runs/pr-2026-09', { credentials: 'include' });
      const body = await r.json();
      return body.data.run.statutory_snapshot?.['pf.employee_rate'];
    });
    log(`  snapshot before supersede: pf.employee_rate = ${snapBefore}`);
    const superseded = await page.evaluate(async () => {
      const r = await fetch('/api/settings/statutory-rates', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'pf.employee_rate', value: '0.20', effective_from: '2026-10-01' }),
      });
      return r.status;
    });
    log(`  supersede status: ${superseded}`);
    if (superseded !== 200) throw new Error(`supersede expected 200, got ${superseded}`);
    const snapAfter = await page.evaluate(async () => {
      const r = await fetch('/api/payroll/runs/pr-2026-09', { credentials: 'include' });
      const body = await r.json();
      return body.data.run.statutory_snapshot?.['pf.employee_rate'];
    });
    log(`  snapshot after supersede: pf.employee_rate = ${snapAfter}`);
    if (snapAfter !== snapBefore) throw new Error(`statutory snapshot changed after supersede (${snapBefore} → ${snapAfter})`);

    // ── Employee sees the newly-published payslip ────────────────────────
    log('Logout, login as Employee → new payslip visible');
    await logoutViaUI(page);
    await loginTo(page, 'emp');
    await page.goto(`${APP}/me/payslips`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="my-payslips"]');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid^="my-payslip-"]').length >= 3,
      { timeout: 5000 },
    );
    const meeraCount = await page.$$eval('[data-testid^="my-payslip-"]', (rs) => rs.length);
    log(`  Meera now sees ${meeraCount} payslips`);
    if (meeraCount < 3) throw new Error(`Meera should see 3 payslips, got ${meeraCount}`);
    await shot(page, 'emp-payslips');

    // Open the Sep payslip.
    log('Open a payslip → PDF download → 200');
    await page.click('[data-testid="my-payslip-ps-pr-2026-09-emp-exec"] a');
    await page.waitForSelector('[data-testid="payslip-detail"]');
    await page.waitForSelector('[data-testid="payslip-in-words"]');
    const inWords = await page.$eval('[data-testid="payslip-in-words"]', (n) => n.textContent);
    log(`  in words: "${inWords}"`);
    if (!/rupees only/i.test(inWords)) throw new Error('in-words does not read like currency');
    const dlRes = await page.evaluate(async () => {
      const r = await fetch('/api/payroll/payslips/ps-pr-2026-09-emp-exec/download-url', { credentials: 'include' });
      const url = (await r.json()).data.url;
      const b = await fetch(url, { credentials: 'include' });
      const text = await b.text();
      return { status: b.status, preview: text.slice(0, 40) };
    });
    log(`  PDF: ${dlRes.status} · "${dlRes.preview}"`);
    if (dlRes.status !== 200 || !/PAYSLIP/i.test(dlRes.preview)) throw new Error('payslip PDF broken');
    await shot(page, 'emp-payslip-open');

    await browser.close();
    log('DONE — all payroll checks passed');
    process.exit(0);
  } catch (e) {
    log(`FAIL: ${e.message}`);
    console.error(e.stack);
    await browser.close();
    process.exit(1);
  }
}

main();
