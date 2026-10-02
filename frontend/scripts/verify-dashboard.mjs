/**
 * End-to-end verify for the Dashboard (§6.2) + Notifications (§8.9).
 *
 * Covers:
 *   - Employee dashboard: hero (today card) + secondary (quick actions,
 *     balances) + feed (notifications). Missing: Notifications gets populated
 *     the moment the Employee checks in — verify by triggering a check-in
 *     via /api/attendance/check-in and then observing bell + panel.
 *   - MD dashboard: KPI row + breakdown chart + department table + queue
 *     (pending actions + leave approvals) + feed (activity + notifications).
 *   - Bell shows unread count; opening panel + clicking a notification
 *     deep-links via action_url.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = 'http://localhost:5173';
const SHOTS = resolve('scripts/shots');
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

const HQ = { latitude: 13.0828, longitude: 80.2708, accuracy: 25 };

const LOGINS = {
  md: { email: 'ravi@auditos.local', password: 'md' },
  emp: { email: 'meera@auditos.local', password: 'emp' },
};

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}
async function shot(page, name) {
  const path = resolve(SHOTS, `dash-${name}.png`);
  await page.screenshot({ path });
  log(`  📸 dash-${name}.png`);
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
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(APP, ['geolocation']);

  try {
    const page = await browser.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') log(`  console.error: ${msg.text()}`);
    });
    page.on('pageerror', (err) => log(`  pageerror: ${err.message}`));

    // Fresh DB (v4).
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.setGeolocation(HQ);

    // ── Employee: fresh dashboard shows expected widgets ───────────────────
    log('Login as Employee');
    await loginTo(page, 'emp');

    // Bell should be present (Notifications primitive wired).
    await page.waitForSelector('[data-testid="notifications-bell"]', { timeout: 5000 });

    log('Employee sees hero (today card), quick actions, balances, notifications feed');
    await page.waitForSelector('[data-testid="today-card"]', { timeout: 5000 });
    await page.waitForSelector('[data-testid="quick-actions"]', { timeout: 5000 });
    await page.waitForSelector('[data-testid="leave-balances"]', { timeout: 5000 });
    await page.waitForSelector('[data-testid="notifications-feed"]', { timeout: 5000 });
    // Employee should NOT see HR-only widgets.
    if (await page.$('[data-testid="attendance-breakdown"]')) throw new Error('Employee should NOT see breakdown chart');
    if (await page.$('[data-testid="pending-actions"]')) throw new Error('Employee should NOT see pending actions');
    if (await page.$('[data-testid="activity-feed"]')) throw new Error('Employee should NOT see activity feed');
    await shot(page, 'emp-dashboard');

    // Trigger a check-in from the widget itself to prove wiring, and to
    // generate a notification we can then observe in the bell.
    log('Employee clicks Check in from the hero card');
    await page.click('[data-testid="check-in"]');
    await page.waitForResponse(
      (r) => r.url().endsWith('/api/attendance/check-in') && r.request().method() === 'POST',
      { timeout: 8000 },
    );

    // Give the bell's next 30s poll or query invalidation a moment.
    // Force it by opening + closing the panel — the panel query fires on mount.
    log('Open notifications bell — expect unread count');
    // Force a refetch via invalidating the query via the bell click:
    await page.evaluate(() => {
      const bell = document.querySelector('[data-testid="notifications-bell"]');
      bell?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await page.click('[data-testid="notifications-bell"]');
    await page.waitForSelector('[data-testid="notifications-panel"]', { timeout: 5000 });

    // Wait for the unread badge or panel content to reflect the new notification.
    await page.waitForFunction(
      () => {
        const panel = document.querySelector('[data-testid="notifications-panel"]');
        return panel && /Checked in|Attendance/i.test(panel.textContent);
      },
      { timeout: 5000 },
    );
    const unreadBefore = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="notifications-unread"]');
      return el ? el.textContent.trim() : '0';
    });
    log(`  bell unread count: ${unreadBefore}`);
    if (unreadBefore === '0') throw new Error('bell should show >0 unread after check-in');
    await shot(page, 'emp-bell-panel');

    // Click the first notification — should deep-link to /hrms/attendance.
    log('Click the first notification → deep-link to action_url');
    const firstBtn = await page.$('[data-testid="notifications-panel"] button');
    await firstBtn.click();
    await page.waitForFunction(() => /\/hrms\/attendance/.test(window.location.pathname), {
      timeout: 5000,
    });
    log(`  URL after deep-link: ${page.url()}`);

    // Back to dashboard, unread should have decremented by 1 once markRead
    // completes + the notifications query invalidates.
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="notifications-bell"]');
    // Poll for up to 5s.
    let unreadAfter = unreadBefore;
    for (let i = 0; i < 25; i++) {
      unreadAfter = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="notifications-unread"]');
        return el ? el.textContent.trim() : '0';
      });
      if (unreadAfter !== unreadBefore) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    log(`  bell unread after click: ${unreadAfter}`);
    if (unreadAfter === unreadBefore) throw new Error('unread did not decrement after markRead');

    // ── MD: full dashboard ────────────────────────────────────────────────
    log('Logout, login as MD');
    await logoutViaUI(page);
    await loginTo(page, 'md');

    log('MD sees KPI row + breakdown chart + department table + queue + activity feed');
    await page.waitForSelector('[data-testid="kpi-row"]', { timeout: 5000 });
    await page.waitForSelector('[data-testid="attendance-breakdown"]', { timeout: 5000 });
    await page.waitForSelector('[data-testid="department-table"]', { timeout: 5000 });
    await page.waitForSelector('[data-testid="pending-actions"]', { timeout: 5000 });
    await page.waitForSelector('[data-testid="activity-feed"]', { timeout: 5000 });
    await shot(page, 'md-dashboard');

    // Department table has rows.
    const deptRows = await page.$$eval('[data-testid="department-table"] tbody tr', (rs) => rs.length);
    log(`  department rows: ${deptRows}`);
    if (deptRows === 0) throw new Error('department table returned no rows');

    // Pending actions should include the seeded 8-day Earned leave (awaiting manager,
    // which the MD can approve at org scope) and possibly others.
    const pendingCount = await page.$eval('[data-testid="pending-actions"]', (el) => el.textContent);
    log(`  pending-actions text head: ${pendingCount.slice(0, 100)}`);

    // Activity feed shows the check-in we did above.
    const feedText = await page.$eval('[data-testid="activity-feed"]', (el) => el.textContent);
    log(`  activity feed head: ${feedText.slice(0, 120)}`);
    if (!/check_in|attendance/i.test(feedText)) {
      throw new Error('activity feed does not show the check-in event');
    }

    // ── /notifications full page ──────────────────────────────────────────
    log('Open /notifications full page');
    await page.goto(`${APP}/notifications`, { waitUntil: 'networkidle0' });
    await shot(page, 'md-notifications-page');

    await browser.close();
    log('DONE — all dashboard checks passed');
    process.exit(0);
  } catch (e) {
    log(`FAIL: ${e.message}`);
    console.error(e.stack);
    await browser.close();
    process.exit(1);
  }
}

main();
