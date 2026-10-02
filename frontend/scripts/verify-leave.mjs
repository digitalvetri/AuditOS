/**
 * End-to-end verify for the Leave module (§8.3).
 *
 * Covers:
 *   - Employee sees balances chip strip on Dashboard (secondary widget)
 *   - Apply a 2-day Casual → live day-count preview shows 2.0
 *   - Manager approves → status Approved, balance decrements, attendance rows
 *     flip to `On Leave` in the records table (the strong assertion)
 *   - 8-day Earned request already seeded → manager approves → status stays
 *     Pending "Awaiting HR" (approver_id set, hr_approver_id still null)
 *   - HR (MD) approves → status Approved, balance decrements
 *   - Cancel a future-approved leave → balance restored, On Leave rows removed
 *
 * Uses the single-page + UI-logout rotation pattern that worked for Attendance.
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
  emp: { email: 'meera@auditos.local', password: 'emp' },
};

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}
async function shot(page, name) {
  const path = resolve(SHOTS, `leave-${name}.png`);
  await page.screenshot({ path });
  log(`  📸 leave-${name}.png`);
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

async function findByText(page, selector, text) {
  return page.evaluateHandle(
    (sel, t) =>
      Array.from(document.querySelectorAll(sel)).find(
        (n) => n.textContent && n.textContent.trim().includes(t),
      ) ?? null,
    selector,
    text,
  );
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
    page.on('response', (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith('/api/leaves') || u.pathname.startsWith('/api/attendance')) {
        log(`  [net] ${r.status()} ${r.request().method()} ${u.pathname}${u.search}`);
      }
    });

    // Fresh DB for the run.
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle0' });

    // ── Employee applies for a 2-day Casual ───────────────────────────────
    log('Login as Employee');
    await loginTo(page, 'emp');

    log('Balances widget visible on Dashboard');
    await page.waitForSelector('[data-testid="leave-balances"]', { timeout: 5000 });
    await shot(page, 'emp-dashboard');

    log('Open /hrms/leave');
    await page.goto(`${APP}/hrms/leave`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="leave-balances"]');

    log('Open Apply modal, choose Casual, pick a 2-day future range');
    await page.click('[data-testid="leave-apply-open"]');
    await page.waitForSelector('[data-testid="leave-apply-modal"]');
    // Wait for balances query to populate the select options.
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="leave-type"] option').length > 1,
      { timeout: 5000 },
    );
    // Pick Casual by value = 'lt-casual'.
    await page.select('[data-testid="leave-type"]', 'lt-casual');

    // Pick 2 weekdays that don't collide with the seeded requests: use next
    // week's Tuesday..Wednesday relative to today.
    const dates = await page.evaluate(() => {
      const t = new Date();
      const daysToTue = (2 - t.getDay() + 7) % 7 || 7; // next Tuesday
      const start = new Date(t);
      start.setDate(t.getDate() + daysToTue);
      const end = new Date(start);
      end.setDate(start.getDate() + 1);
      const iso = (d) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return { start: iso(start), end: iso(end) };
    });
    log(`  chose ${dates.start} → ${dates.end}`);
    await page.evaluate((ds) => {
      const [startEl, endEl] = document.querySelectorAll('input[type="date"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(startEl, ds.start);
      startEl.dispatchEvent(new Event('input', { bubbles: true }));
      startEl.dispatchEvent(new Event('change', { bubbles: true }));
      setter.call(endEl, ds.end);
      endEl.dispatchEvent(new Event('input', { bubbles: true }));
      endEl.dispatchEvent(new Event('change', { bubbles: true }));
    }, dates);
    // Fill reason.
    const textarea = await page.$('[data-testid="leave-apply-modal"] textarea');
    await textarea.click({ clickCount: 3 });
    await page.keyboard.type('Personal family function');

    // Preview should show 2.0 days.
    const previewDays = await page.$eval(
      '[data-testid="leave-days"]',
      (el) => el.textContent.trim(),
    );
    log(`  preview days: ${previewDays}`);
    if (previewDays !== '2.0')
      throw new Error(`expected preview 2.0, got "${previewDays}"`);

    await shot(page, 'apply-preview');

    log('Submit');
    // Capture the response to learn the new request's id so we can act on it
    // specifically later (the manager queue may hold multiple Casual rows).
    const submitResPromise = page.waitForResponse(
      (r) => r.url().endsWith('/api/leaves') && r.request().method() === 'POST',
      { timeout: 5000 },
    );
    await page.click('[data-testid="leave-submit"]');
    const submitRes = await submitResPromise;
    const submitJson = await submitRes.json();
    const newRequestId = submitJson?.data?.request?.id;
    log(`  new request id: ${newRequestId}`);
    if (!newRequestId) throw new Error('submit response missing request id');
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="leave-apply-modal"]'),
      { timeout: 5000 },
    );

    log('Employee sees the new pending request in "My requests"');
    await page.click('[data-testid="leave-tab-mine"]');
    await page.waitForSelector('[data-testid="leave-list-mine"]');
    // Wait for the list network fetch + hydration to complete.
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid^="leave-row-"]').length > 0,
      { timeout: 5000 },
    );
    const myCount = await page.$$eval('[data-testid^="leave-row-"]', (rs) => rs.length);
    log(`  my requests count: ${myCount}`);
    if (myCount < 1) throw new Error('expected at least one leave row');
    await shot(page, 'emp-mine');

    // ── Manager approves the 2-day Casual ─────────────────────────────────
    log('Logout, login as Dept Manager');
    await logoutViaUI(page);
    await loginTo(page, 'mgr');
    await page.goto(`${APP}/hrms/leave?tab=queue`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="leave-list-queue"]');
    await page.waitForFunction(
      (id) =>
        !!document.querySelector(`[data-testid="leave-approve-${id}"]`),
      { timeout: 5000 },
      newRequestId,
    );

    log(`  approve the new 2-day Casual (${newRequestId})`);
    await page.click(`[data-testid="leave-approve-${newRequestId}"]`);
    // Wait for the mutation to complete and the queue to refetch.
    await page.waitForResponse(
      (r) => r.url().includes(`/leaves/${newRequestId}/approve`) && r.request().method() === 'POST',
      { timeout: 5000 },
    );
    await page.waitForFunction(
      (id) => !document.querySelector(`[data-testid="leave-approve-${id}"]`),
      { timeout: 5000 },
      newRequestId,
    );
    await shot(page, 'mgr-approved-casual');

    // ── Manager approves the seeded 8-day Earned → stays pending (HR next) ─
    log('Manager approves 8-day Earned (lr-emp-earned) → expect status stays pending, awaiting HR');
    await page.waitForSelector('[data-testid="leave-approve-lr-emp-earned"]', { timeout: 5000 });
    await page.click('[data-testid="leave-approve-lr-emp-earned"]');
    await page.waitForResponse(
      (r) => r.url().includes('/leaves/lr-emp-earned/approve'),
      { timeout: 5000 },
    );
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="leave-approve-lr-emp-earned"]'),
      { timeout: 5000 },
    );
    // Manager's queue filter excludes rows where they already approved — so
    // the Earned row disappears from THEIR queue but still exists globally.
    // Confirm via a direct fetch.
    const earnedStatus = await page.evaluate(async () => {
      const r = await fetch('/api/leaves/lr-emp-earned', { credentials: 'include' });
      return r.json();
    });
    log(`  Earned status=${earnedStatus.data?.request?.status} stage=${earnedStatus.data?.request?.stage} approver=${earnedStatus.data?.request?.approver_id}`);
    if (earnedStatus.data?.request?.status !== 'pending')
      throw new Error(`expected pending, got ${earnedStatus.data?.request?.status}`);
    if (earnedStatus.data?.request?.stage !== 'awaiting_hr')
      throw new Error(`expected stage awaiting_hr, got ${earnedStatus.data?.request?.stage}`);

    // ── Log in as MD (org-wide leave.approve) → complete Earned approval ──
    log('Logout, login as MD → HR-stage approval of Earned');
    await logoutViaUI(page);
    await loginTo(page, 'md');
    await page.goto(`${APP}/hrms/leave?tab=queue`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="leave-list-queue"]');
    await page.waitForSelector('[data-testid="leave-approve-lr-emp-earned"]', { timeout: 5000 });
    await shot(page, 'md-queue-earned');
    await page.click('[data-testid="leave-approve-lr-emp-earned"]');
    await page.waitForResponse(
      (r) => r.url().includes('/leaves/lr-emp-earned/approve'),
      { timeout: 5000 },
    );
    await shot(page, 'md-earned-approved');

    // ── Back to Employee: assert balance decrement + attendance row flip ──
    log('Logout, login as Employee → check balances + attendance flip');
    await logoutViaUI(page);
    await loginTo(page, 'emp');

    // Balance: Casual was 6 - 3 availed = 3 → approve 2 → availed 5, available 1.
    // The seed also has an earlier pending Casual (1 day for Sep 14/15 → 1 day).
    // We do not approve that here, so its `pending` shouldn't affect availed.
    const bal = await page.evaluate(async () => {
      const r = await fetch('/api/leaves/balances/emp-exec', { credentials: 'include' });
      return r.json();
    });
    const casualRow = bal.data.items.find((i) => i.type.code === 'casual');
    log(`  casual availed=${casualRow.availed} entitled=${casualRow.entitled}`);
    if (casualRow.availed !== 5)
      throw new Error(`casual availed expected 5, got ${casualRow.availed}`);

    const earnedRow = bal.data.items.find((i) => i.type.code === 'earned');
    log(`  earned availed=${earnedRow.availed} entitled=${earnedRow.entitled}`);
    if (earnedRow.availed !== 8)
      throw new Error(`earned availed expected 8 after Earned approval, got ${earnedRow.availed}`);

    // Attendance flip: pick the start date of the 2-day Casual (dates.start)
    // and confirm the attendance row's status is "on_leave".
    const attendance = await page.evaluate(async (from) => {
      const r = await fetch(
        `/api/attendance?from=${from}&to=${from}`,
        { credentials: 'include' },
      );
      return r.json();
    }, dates.start);
    const row = attendance.data.items[0];
    log(`  attendance on ${dates.start}: status=${row?.status}`);
    if (!row || row.status !== 'on_leave')
      throw new Error(`expected on_leave on ${dates.start}, got ${row?.status}`);

    await shot(page, 'emp-after-approval');

    // ── Cancel a future-approved leave — balance restored, rows removed ───
    log('Employee cancels the 2-day Casual → balance restored, on_leave rows removed');
    await page.goto(`${APP}/hrms/leave`, { waitUntil: 'networkidle0' });
    await page.click('[data-testid="leave-tab-mine"]');
    await page.waitForSelector('[data-testid="leave-list-mine"]');
    await page.waitForSelector(`[data-testid="leave-cancel-${newRequestId}"]`, { timeout: 5000 });
    await page.click(`[data-testid="leave-cancel-${newRequestId}"]`);
    await page.waitForResponse(
      (r) => r.url().includes(`/leaves/${newRequestId}/cancel`),
      { timeout: 5000 },
    );
    await shot(page, 'emp-after-cancel');

    const balAfter = await page.evaluate(async () => {
      const r = await fetch('/api/leaves/balances/emp-exec', { credentials: 'include' });
      return r.json();
    });
    const casualAfter = balAfter.data.items.find((i) => i.type.code === 'casual');
    log(`  casual availed after cancel: ${casualAfter.availed}`);
    if (casualAfter.availed !== 3)
      throw new Error(`casual availed after cancel expected 3, got ${casualAfter.availed}`);

    const attAfter = await page.evaluate(async (from) => {
      const r = await fetch(`/api/attendance?from=${from}&to=${from}`, { credentials: 'include' });
      return r.json();
    }, dates.start);
    const rowAfter = attAfter.data.items[0];
    log(`  attendance on ${dates.start} after cancel: status=${rowAfter?.status}`);
    if (rowAfter && rowAfter.status === 'on_leave')
      throw new Error(`on_leave row NOT removed after cancel: ${rowAfter?.status}`);

    // ── Probe: apply Earned during probation should 422. No probation user
    // in seed — skip. Probe: retroactive Casual → 422.
    log('Probe: past-dated Casual → 422');
    const pastStatus = await page.evaluate(async () => {
      const r = await fetch('/api/leaves', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leave_type_id: 'lt-casual',
          start_date: '2026-08-01',
          end_date: '2026-08-01',
          half_day: false,
          reason: 'test past',
        }),
      });
      return r.status;
    });
    log(`  past-dated Casual → ${pastStatus}`);
    if (pastStatus !== 422) throw new Error(`expected 422, got ${pastStatus}`);

    log('Probe: retroactive Sick (yesterday) → 200');
    const sickStatus = await page.evaluate(async () => {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      const iso = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
      const r = await fetch('/api/leaves', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leave_type_id: 'lt-sick',
          start_date: iso,
          end_date: iso,
          half_day: false,
          reason: 'flu yesterday',
        }),
      });
      return { status: r.status, body: r.status !== 200 ? await r.text() : null };
    });
    log(`  retroactive Sick → ${sickStatus.status}${sickStatus.body ? ` : ${sickStatus.body.slice(0, 120)}` : ''}`);
    if (sickStatus.status !== 200) throw new Error(`expected 200 sick, got ${sickStatus.status}`);

    await browser.close();
    log('DONE — all leave checks passed');
    process.exit(0);
  } catch (e) {
    log(`FAIL: ${e.message}`);
    console.error(e.stack);
    await browser.close();
    process.exit(1);
  }
}

// keep the linter quiet — this helper is here for future use
void findByText;

main();
