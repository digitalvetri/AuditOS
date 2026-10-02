/**
 * End-to-end verify for the Employees module (§8.1).
 *
 * Four discriminator probes matter more than the happy path:
 *   1. Finance shape probe: GET /employees/:id returns EXACTLY the 6-field
 *      Finance projection — no email, phone, joining_date, etc.
 *   2. Self-edit employment field → 422 employment_fields_hr_only, DB unchanged.
 *   3. Deactivate Meera → subsequent login as Meera fails 401; check-in with
 *      a captured pre-deactivation cookie also fails.
 *   4. Articled Training endpoint 404 for non-articled type; tab visible only
 *      for Articled.
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
  mgr: { email: 'vikram@auditos.local', password: 'mgr' },
  hr: { email: 'priya@auditos.local', password: 'hr' },
  fin: { email: 'anitha@auditos.local', password: 'fin' },
  emp: { email: 'meera@auditos.local', password: 'emp' },
  art: { email: 'karthik@auditos.local', password: 'art' },
};

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}
async function shot(page, name) {
  const path = resolve(SHOTS, `emp-${name}.png`);
  await page.screenshot({ path });
  log(`  📸 emp-${name}.png`);
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

async function attemptLogin(page, who) {
  const { email, password } = LOGINS[who];
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('input[type="email"]', { timeout: 5000 });
  await page.evaluate(() => {
    document.querySelector('input[type="email"]').value = '';
    document.querySelector('input[type="password"]').value = '';
  });
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', password);
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/auth/login') && r.request().method() === 'POST'),
    page.click('button[type="submit"]'),
  ]);
  return resp.status();
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
    page.on('console', (msg) => {
      if (msg.type() === 'error') log(`  console.error: ${msg.text()}`);
    });
    page.on('pageerror', (err) => log(`  pageerror: ${err.message}`));

    // Fresh DB (v4). Clear localStorage then reload; use domcontentloaded
    // (networkidle0 can hang on chatty apps with many queries in flight).
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });

    // ── HR: full list + open a profile, verify tabs ───────────────────────
    log('Login as HR');
    await loginTo(page, 'hr');
    await page.goto(`${APP}/hrms/employees`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="employees-list"] table', { timeout: 5000 });
    const hrCount = await page.$$eval('[data-testid^="employee-row-"]', (rs) => rs.length);
    log(`  HR sees ${hrCount} employees`);
    if (hrCount < 5) throw new Error(`HR should see at least 5 employees, got ${hrCount}`);
    await shot(page, 'hr-list');

    log('Open the Articled Assistant profile → Training tab must be present');
    await page.goto(`${APP}/hrms/employees/emp-articled`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="employee-tab-overview"]');
    const hasTraining = await page.$('[data-testid="employee-tab-training"]');
    if (!hasTraining) throw new Error('Training tab missing for Articled Assistant');
    await page.click('[data-testid="employee-tab-training"]');
    await page.waitForSelector('[data-testid="articled-training"]', { timeout: 5000 });
    const trainingText = await page.$eval('[data-testid="articled-training"]', (n) => n.textContent);
    if (!/ICAI/.test(trainingText)) throw new Error('training panel missing ICAI field');
    await shot(page, 'hr-training-tab');

    log('Open a non-Articled profile → Training tab must be absent, /training → 404');
    await page.goto(`${APP}/hrms/employees/emp-exec`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="employee-tab-overview"]');
    const noTraining = await page.$('[data-testid="employee-tab-training"]');
    if (noTraining) throw new Error('Training tab should NOT show for non-Articled');
    const trainingStatus = await page.evaluate(async () => {
      const r = await fetch('/api/employees/emp-exec/training', { credentials: 'include' });
      return r.status;
    });
    log(`  GET /employees/emp-exec/training → ${trainingStatus}`);
    if (trainingStatus !== 404) throw new Error(`expected 404 for non-articled training, got ${trainingStatus}`);

    // ── Finance projection shape probe ────────────────────────────────────
    log('Logout, login as Finance');
    await logoutViaUI(page);
    await loginTo(page, 'fin');
    log('Finance GET /employees/emp-exec — shape must be exactly 6 fields + id');
    const finRes = await page.evaluate(async () => {
      const r = await fetch('/api/employees/emp-exec', { credentials: 'include' });
      const body = await r.json();
      return { status: r.status, body };
    });
    log(`  status: ${finRes.status}`);
    const empKeys = Object.keys(finRes.body?.data?.employee ?? {}).sort();
    log(`  employee keys: ${empKeys.join(', ')}`);
    const expected = [
      'bank_account_masked',
      'department_id',
      'designation_id',
      'employee_code',
      'full_name',
      'id',
      'status',
    ];
    const missing = expected.filter((k) => !empKeys.includes(k));
    const extra = empKeys.filter((k) => !expected.includes(k));
    if (missing.length) throw new Error(`Finance projection missing: ${missing.join(', ')}`);
    if (extra.length) throw new Error(`Finance projection leaked fields: ${extra.join(', ')}`);
    log('  Finance projection shape is exactly {id, employee_code, full_name, department_id, designation_id, bank_account_masked, status}');
    await shot(page, 'fin-profile');

    // ── Dept Manager sees dept only ───────────────────────────────────────
    log('Logout, login as Dept Manager');
    await logoutViaUI(page);
    await loginTo(page, 'mgr');
    await page.goto(`${APP}/hrms/employees`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="employees-list"] table', { timeout: 5000 });
    const mgrIds = await page.$$eval('[data-testid^="employee-row-"]', (rs) =>
      rs.map((r) => r.getAttribute('data-testid').replace('employee-row-', '')),
    );
    log(`  Manager sees: ${mgrIds.join(', ')}`);
    // Vikram is dept 'dep-ops' — should see emp-mgr, emp-exec, emp-articled, emp-probation.
    const expectedForMgr = ['emp-mgr', 'emp-exec', 'emp-articled', 'emp-probation'];
    for (const id of expectedForMgr) {
      if (!mgrIds.includes(id)) throw new Error(`Manager missing dept member: ${id}`);
    }
    // Should NOT see MD (management dept) or HR (hr dept).
    if (mgrIds.includes('emp-md')) throw new Error('Manager should not see MD (different dept)');
    if (mgrIds.includes('emp-hr')) throw new Error('Manager should not see HR (different dept)');
    // Cross-dept fetch → 403.
    const crossStatus = await page.evaluate(async () => {
      const r = await fetch('/api/employees/emp-md', { credentials: 'include' });
      return r.status;
    });
    log(`  Manager GET /employees/emp-md (cross-dept) → ${crossStatus}`);
    if (crossStatus !== 403) throw new Error(`cross-dept expected 403, got ${crossStatus}`);

    // ── Employee self-edit constraints ────────────────────────────────────
    log('Logout, login as Employee');
    await logoutViaUI(page);
    await loginTo(page, 'emp');
    log('Self PATCH contact field → 200');
    const okStatus = await page.evaluate(async () => {
      const r = await fetch('/api/employees/emp-exec', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '+91 90000 12345' }),
      });
      return r.status;
    });
    log(`  contact PATCH → ${okStatus}`);
    if (okStatus !== 200) throw new Error(`expected 200 for contact PATCH, got ${okStatus}`);

    log('Self PATCH employment field → 422 employment_fields_hr_only');
    const forbidden = await page.evaluate(async () => {
      const r = await fetch('/api/employees/emp-exec', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ department_id: 'dep-mgmt' }),
      });
      return { status: r.status, body: await r.json() };
    });
    log(`  employment PATCH → ${forbidden.status} ${forbidden.body?.error?.code}`);
    if (forbidden.status !== 422)
      throw new Error(`expected 422, got ${forbidden.status}`);
    if (forbidden.body?.error?.code !== 'employment_fields_hr_only')
      throw new Error(`wrong error code: ${forbidden.body?.error?.code}`);

    // Verify DB is unchanged — GET back and check dept.
    const after = await page.evaluate(async () => {
      const r = await fetch('/api/employees/emp-exec', { credentials: 'include' });
      return r.json();
    });
    log(`  emp-exec department_id after attempted forbidden PATCH: ${after.data.employee.department_id}`);
    if (after.data.employee.department_id !== 'dep-ops')
      throw new Error(`DB corrupted: dept is ${after.data.employee.department_id}`);

    // Employee sees only self in the list.
    await page.goto(`${APP}/hrms/employees`, { waitUntil: 'networkidle0' });
    // Sidebar hides Employees for basic Employee; but the URL is reachable — the
    // list returns just self.
    const empListStatus = await page.evaluate(async () => {
      const r = await fetch('/api/employees', { credentials: 'include' });
      const body = await r.json();
      return { count: body.data.count, ids: body.data.items.map((i) => i.id) };
    });
    log(`  Employee sees ${empListStatus.count} rows: ${empListStatus.ids.join(', ')}`);
    if (empListStatus.count !== 1 || empListStatus.ids[0] !== 'emp-exec')
      throw new Error('Employee should see only self in /employees');

    // ── Deactivate probe ──────────────────────────────────────────────────
    // Snapshot Meera's cookie BEFORE deactivation, so we can attempt check-in with
    // the stale cookie afterwards.
    log('Snapshot Meera\'s cookie before deactivation');
    const meeraCookies = await page.cookies(APP);
    const meeraJar = meeraCookies.map((c) => ({ name: c.name, value: c.value }));

    log('Logout, login as MD, deactivate emp-exec (Meera)');
    await logoutViaUI(page);
    await loginTo(page, 'md');
    const deactivate = await page.evaluate(async () => {
      const r = await fetch('/api/employees/emp-exec/deactivate', {
        method: 'POST',
        credentials: 'include',
      });
      return r.status;
    });
    log(`  deactivate status: ${deactivate}`);
    if (deactivate !== 200) throw new Error(`deactivate expected 200, got ${deactivate}`);

    log('Attempt login as Meera → 401 (User.is_active=false)');
    await logoutViaUI(page);
    const loginStatus = await attemptLogin(page, 'emp');
    log(`  Meera login → ${loginStatus}`);
    if (loginStatus !== 401) throw new Error(`Meera login expected 401, got ${loginStatus}`);

    log('Attempt check-in with Meera\'s stale cookie → 403 inactive');
    // Restore Meera's cookie into the page context, hit /check-in directly.
    await page.deleteCookie(...(await page.cookies(APP)));
    for (const c of meeraJar) {
      await page.setCookie({ name: c.name, value: c.value, url: APP });
    }
    const staleCheckIn = await page.evaluate(async () => {
      const r = await fetch('/api/attendance/check-in', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latitude: 13.0828, longitude: 80.2708, accuracy_m: 25 }),
      });
      return { status: r.status, body: await r.json() };
    });
    log(`  stale-cookie check-in → ${staleCheckIn.status} ${staleCheckIn.body?.error?.code}`);
    // The spec (§14) requires "a deactivated employee cannot log in or check
    // in." Either 401 (session invalidated — currentUser() no longer finds
    // the inactive user) or 403 (found but blocked) satisfies that; both are
    // hard denials with no side effect. Accept either.
    if (staleCheckIn.status !== 401 && staleCheckIn.status !== 403)
      throw new Error(`stale check-in must be 401 or 403, got ${staleCheckIn.status}`);

    // Cleanup: log back in as MD to take a final screenshot of the Employees list w/ inactive.
    await page.deleteCookie(...(await page.cookies(APP)));
    await loginTo(page, 'md');
    await page.goto(`${APP}/hrms/employees?includeInactive=true`, { waitUntil: 'networkidle0' });
    await shot(page, 'md-list-with-inactive');

    await browser.close();
    log('DONE — all employee checks passed');
    process.exit(0);
  } catch (e) {
    log(`FAIL: ${e.message}`);
    console.error(e.stack);
    await browser.close();
    process.exit(1);
  }
}

main();
