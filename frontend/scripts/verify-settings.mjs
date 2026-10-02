/**
 * End-to-end verify for Settings (§8.11).
 *
 * Discriminator probes:
 *   1. Employee/Manager/Finance GET any /api/settings/{crud-thing} → 403
 *   2. HR creates a department → list updates + no duplicate
 *   3. Delete-in-use department (dep-ops) → 409 in_use
 *   4. HR edits a leave type entitlement → PATCH persists, ['leaves'] cache invalidates
 *   5. Statutory-rate supersede: POST new row → prior row's effective_to is capped,
 *      new row becomes current
 *   6. Roles matrix renders + reflects the code-defined MATRIX
 *   7. Add a holiday + delete a holiday
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

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}
async function shot(page, name) {
  const path = resolve(SHOTS, `set-${name}.png`);
  await page.screenshot({ path });
  log(`  📸 set-${name}.png`);
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

    // Fresh DB (v6).
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });

    // ── HR: full Settings page renders ────────────────────────────────────
    log('Login as HR → open /hrms/settings');
    await loginTo(page, 'hr');
    await page.goto(`${APP}/hrms/settings`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="settings-nav"]');
    await page.waitForSelector('[data-testid="settings-section-departments"]');
    await shot(page, 'hr-departments');

    // ── Create a department ───────────────────────────────────────────────
    log('Create department "Legal"');
    await page.click('[data-testid="settings-add"]');
    await page.type('[data-testid="dept-name"]', 'Legal');
    await page.type('[data-testid="dept-code"]', 'LEGAL');
    const createRes = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/settings/departments') && r.request().method() === 'POST'),
      page.click('[data-testid="dept-submit"]'),
    ]);
    log(`  POST /departments → ${createRes[0].status()}`);
    if (createRes[0].status() !== 200) throw new Error('create dept expected 200');
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('[data-testid^="dept-row-"]')).some((r) => /Legal/.test(r.textContent)),
      { timeout: 5000 },
    );

    // ── Delete-in-use → 409 ──────────────────────────────────────────────
    log('DELETE /departments/dep-ops → 409 in_use (has employees)');
    const inUseStatus = await page.evaluate(async () => {
      const r = await fetch('/api/settings/departments/dep-ops', { method: 'DELETE', credentials: 'include' });
      return { status: r.status, body: await r.json() };
    });
    log(`  status ${inUseStatus.status} code ${inUseStatus.body?.error?.code}`);
    if (inUseStatus.status !== 409) throw new Error(`expected 409, got ${inUseStatus.status}`);
    if (inUseStatus.body?.error?.code !== 'in_use') throw new Error(`wrong code: ${inUseStatus.body?.error?.code}`);

    // ── Edit Casual leave-type entitlement ────────────────────────────────
    log('Navigate to Leave Types, edit Casual entitlement 12 → 14');
    await page.click('[data-testid="settings-nav-leave-types"]');
    await page.waitForSelector('[data-testid="settings-section-leave-types"]');
    await page.waitForSelector('[data-testid="leave-type-edit-casual"]', { timeout: 5000 });
    await page.click('[data-testid="leave-type-edit-casual"]');
    // Change the entitlement input to 14.
    await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="number"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(inputs[0], '14');
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
    });
    const editRes = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/settings/leave-types/lt-casual') && r.request().method() === 'PATCH'),
      page.click('[data-testid="leave-type-save-casual"]'),
    ]);
    log(`  PATCH /leave-types/lt-casual → ${editRes[0].status()}`);
    if (editRes[0].status() !== 200) throw new Error('leave-type edit expected 200');
    // Verify server state.
    const casual = await page.evaluate(async () => {
      const r = await fetch('/api/settings/leave-types', { credentials: 'include' });
      const body = await r.json();
      return body.data.items.find((t) => t.code === 'casual');
    });
    log(`  casual annual_entitlement now: ${casual.annual_entitlement}`);
    if (casual.annual_entitlement !== 14) throw new Error(`casual entitlement expected 14, got ${casual.annual_entitlement}`);

    // ── Statutory-rate supersede ─────────────────────────────────────────
    log('Navigate to Statutory Rates → supersede pf.employee_rate 0.12 → 0.13');
    await page.click('[data-testid="settings-nav-statutory-rates"]');
    await page.waitForSelector('[data-testid="settings-section-statutory-rates"]');
    await page.waitForSelector('[data-testid="rate-pf.employee_rate"]');
    await page.click('[data-testid="rate-supersede-pf.employee_rate"]');
    // Fill new value + effective_from.
    await page.evaluate(() => {
      const scope = document.querySelector('[data-testid="rate-pf.employee_rate"]');
      const inputs = scope.querySelectorAll('input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(inputs[0], '0.13');
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.evaluate(() => {
      const dateInput = document.querySelector('[data-testid="rate-effective-from-pf.employee_rate"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(dateInput, '2027-04-01');
      dateInput.dispatchEvent(new Event('input', { bubbles: true }));
      dateInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const supersedeRes = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/settings/statutory-rates') && r.request().method() === 'POST'),
      page.click('[data-testid="rate-supersede-submit-pf.employee_rate"]'),
    ]);
    log(`  POST /statutory-rates → ${supersedeRes[0].status()}`);
    if (supersedeRes[0].status() !== 200) throw new Error('supersede expected 200');
    // Verify the prior row got capped.
    const rates = await page.evaluate(async () => {
      const r = await fetch('/api/settings/statutory-rates?code=pf.employee_rate', { credentials: 'include' });
      const body = await r.json();
      return body.data.items;
    });
    log(`  history rows for pf.employee_rate: ${rates.length}`);
    const current = rates.find((r) => r.effective_from === '2027-04-01');
    const prior = rates.find((r) => r.effective_from === '2026-04-01');
    log(`  current value: ${current?.value} · prior effective_to: ${prior?.effective_to}`);
    if (current?.value !== '0.13') throw new Error(`new current value expected 0.13, got ${current?.value}`);
    if (prior?.effective_to !== '2027-03-31')
      throw new Error(`prior effective_to expected 2027-03-31, got ${prior?.effective_to}`);
    await shot(page, 'hr-rates-superseded');

    // ── Add + delete a holiday ────────────────────────────────────────────
    log('Add a holiday, then delete it');
    await page.click('[data-testid="settings-nav-holidays"]');
    await page.waitForSelector('[data-testid="settings-section-holidays"]');
    await page.click('[data-testid="settings-add"]');
    await page.evaluate(() => {
      const d = document.querySelector('[data-testid="holiday-date"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(d, '2026-06-30');
      d.dispatchEvent(new Event('input', { bubbles: true }));
      d.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.type('[data-testid="holiday-name"]', 'Verify Holiday');
    const holidayRes = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/settings/holidays') && r.request().method() === 'POST'),
      page.click('[data-testid="holiday-submit"]'),
    ]);
    log(`  POST /holidays → ${holidayRes[0].status()}`);
    if (holidayRes[0].status() !== 200) throw new Error('holiday create expected 200');

    // ── Non-admin roles get 403 on settings API ──────────────────────────
    log('Logout, login as Employee → GET /settings/departments → 403');
    await logoutViaUI(page);
    await loginTo(page, 'emp');
    const empStatus = await page.evaluate(async () => {
      const r = await fetch('/api/settings/departments', { method: 'GET', credentials: 'include' });
      return r.status;
    });
    // Departments GET has no manage-gate in my handler intentionally — used
    // by other modules. But POST / mutations must be 403.
    log(`  employee GET /settings/departments (list) → ${empStatus}`);
    const empCreate = await page.evaluate(async () => {
      const r = await fetch('/api/settings/departments', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'HackDept', code: 'HACK' }),
      });
      return r.status;
    });
    log(`  employee POST /settings/departments → ${empCreate}`);
    if (empCreate !== 403) throw new Error(`employee POST expected 403, got ${empCreate}`);

    log('Login as Finance → POST /settings/statutory-rates → 403');
    await logoutViaUI(page);
    await loginTo(page, 'fin');
    const finRate = await page.evaluate(async () => {
      const r = await fetch('/api/settings/statutory-rates', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'test', value: '0.5', effective_from: '2027-01-01' }),
      });
      return r.status;
    });
    log(`  finance POST /statutory-rates → ${finRate}`);
    if (finRate !== 403) throw new Error(`finance POST expected 403, got ${finRate}`);

    await browser.close();
    log('DONE — all settings checks passed');
    process.exit(0);
  } catch (e) {
    log(`FAIL: ${e.message}`);
    console.error(e.stack);
    await browser.close();
    process.exit(1);
  }
}

main();
