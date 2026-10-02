/**
 * Verification script — drives Chrome via puppeteer-core against the dev server.
 * Not part of the app; safe to delete after the scaffold session.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME =
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = 'http://localhost:5173';
const SHOTS = resolve('scripts/shots');
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

const LOGINS = {
  md: { email: 'ravi@auditos.local', password: 'md' },
  employee: { email: 'meera@auditos.local', password: 'emp' },
};

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function shot(page, name) {
  const path = resolve(SHOTS, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  log(`  📸 ${name}.png`);
}

async function login(page, who) {
  const { email, password } = LOGINS[who];
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/')) log(`  [net] ${r.status()} ${r.request().method()} ${u.pathname}`);
  });
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle0', timeout: 15000 });
  await page.waitForSelector('input[type="email"]');
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', password);
  await page.click('button[type="submit"]');
  // Wait for URL change to / rather than networkidle (MSW responses reset the idle timer).
  await page.waitForFunction(
    () => window.location.pathname === '/',
    { timeout: 15000 },
  );
  await page.waitForSelector('aside nav a', { timeout: 5000 });
}

async function sidebarItems(page) {
  // Read all NavLink text under the sidebar's <nav>.
  return page.$$eval('aside nav a', (links) => links.map((a) => a.textContent.trim()));
}

async function assertReserved(page, path, expectedTitle) {
  await page.goto(`${APP}${path}`, { waitUntil: 'networkidle0', timeout: 15000 });
  const title = await page.$eval('h1', (h) => h.textContent.trim());
  if (title !== expectedTitle) {
    throw new Error(`${path} → h1 was "${title}", expected "${expectedTitle}"`);
  }
  // §6.4: no CTA, no "coming soon"
  const bodyText = await page.$eval('body', (b) => b.textContent);
  if (/coming soon/i.test(bodyText)) throw new Error(`${path} has "coming soon"`);
  if (await page.$('button.bg-gold')) {
    throw new Error(`${path} has a primary (gold) CTA button`);
  }
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1440, height: 900 },
  });

  try {
    const results = [];

    // ── MD login ──────────────────────────────────────────────────────
    const md = await browser.newPage();
    md.on('console', (msg) => {
      if (msg.type() === 'error') log(`  console.error(md): ${msg.text()}`);
    });
    md.on('pageerror', (err) => log(`  pageerror(md): ${err.message}`));

    // Start from a clean slate — no stale localStorage from prior runs.
    await md.goto(APP, { waitUntil: 'domcontentloaded' });
    await md.evaluate(() => localStorage.clear());

    log('Login as MD');
    await login(md, 'md');
    await shot(md, 'md-01-dashboard');

    const cookieDoc = await md.evaluate(() => document.cookie);
    const cookieJar = await md.cookies();
    log(`  document.cookie: "${cookieDoc}"`);
    log(`  cookie jar: ${JSON.stringify(cookieJar.map((c) => ({ n: c.name, v: c.value.slice(0, 10), path: c.path, exp: c.expires })))}`);

    const mdNav = await sidebarItems(md);
    log(`  MD sidebar: ${mdNav.join(' · ')}`);
    results.push(['md.nav', mdNav]);

    // Expected for MD: everything visible.
    const mdExpected = ['Dashboard', 'HRMS', 'Employees', 'Attendance', 'Leave', 'Payroll', 'Expenses', 'Accounts', 'Messages', 'Documents', 'Reports', 'Settings', 'Workstation', 'Tools'];
    const mdMissing = mdExpected.filter((x) => !mdNav.includes(x));
    if (mdMissing.length) throw new Error(`MD missing nav items: ${mdMissing.join(', ')}`);

    log('Click Workstation (reserved)');
    await assertReserved(md, '/workstation', 'Workstation');
    await shot(md, 'md-02-workstation');

    log('Click Tools (reserved)');
    await assertReserved(md, '/tools', 'Tools');
    await shot(md, 'md-03-tools');

    log('Collapse sidebar');
    await md.goto(`${APP}/`, { waitUntil: 'networkidle0' });
    await md.click('button[aria-label="Collapse sidebar"]');
    await new Promise((r) => setTimeout(r, 400));
    const collapsedWidth = await md.$eval('aside', (a) => a.getBoundingClientRect().width);
    log(`  collapsed sidebar width: ${collapsedWidth}px`);
    await shot(md, 'md-04-collapsed');
    if (collapsedWidth > 60) throw new Error(`sidebar did not collapse (width=${collapsedWidth})`);

    log('Refresh — collapse should persist');
    await md.reload({ waitUntil: 'networkidle0' });
    const afterRefreshWidth = await md.$eval('aside', (a) => a.getBoundingClientRect().width);
    log(`  post-refresh sidebar width: ${afterRefreshWidth}px`);
    await shot(md, 'md-05-collapsed-after-refresh');
    if (afterRefreshWidth > 60) throw new Error(`sidebar collapse did not persist (width=${afterRefreshWidth})`);

    log('Expand sidebar back');
    await md.click('button[aria-label="Expand sidebar"]');
    await new Promise((r) => setTimeout(r, 400));

    log('Logout via profile menu');
    // Open profile menu (button with aria-haspopup="menu")
    await md.click('button[aria-haspopup="menu"]');
    await md.waitForSelector('div[role="menu"]');
    // Click the "Log out" menu item (the last button with that text)
    await md.evaluate(() => {
      const items = Array.from(document.querySelectorAll('button[role="menuitem"]'));
      const logout = items.find((b) => b.textContent.trim() === 'Log out');
      if (!logout) throw new Error('Log out menu item not found');
      logout.click();
    });
    await md.waitForSelector('input[type="email"]', { timeout: 5000 });
    log(`  post-logout URL: ${md.url()}`);
    if (!md.url().endsWith('/login')) throw new Error(`logout did not route to /login (got ${md.url()})`);
    await shot(md, 'md-06-logged-out');
    await md.close();

    // ── Employee login (fresh page, fresh localStorage) ────────────────
    // Clear the "collapsed" localStorage first so we start from a known state.
    const emp = await browser.newPage();
    emp.on('console', (msg) => {
      if (msg.type() === 'error') log(`  console.error(emp): ${msg.text()}`);
    });
    emp.on('pageerror', (err) => log(`  pageerror(emp): ${err.message}`));

    // Isolate from MD's session — clear cookies + localStorage.
    await emp.goto(APP, { waitUntil: 'domcontentloaded' });
    const priorCookies = await emp.cookies();
    if (priorCookies.length) await emp.deleteCookie(...priorCookies);
    await emp.evaluate(() => localStorage.clear());

    log('Login as Employee');
    await login(emp, 'employee');
    await shot(emp, 'emp-01-dashboard');

    const empNav = await sidebarItems(emp);
    log(`  Employee sidebar: ${empNav.join(' · ')}`);
    results.push(['employee.nav', empNav]);

    // §6.1: An Employee sees Attendance, Leave, Payroll, Expenses, Messages, Documents.
    //       Employees, Accounts, Reports, Settings must NOT appear.
    // Top-level always present: Dashboard, HRMS, Workstation, Tools.
    const empExpected = ['Dashboard', 'HRMS', 'Attendance', 'Leave', 'Payroll', 'Expenses', 'Messages', 'Documents', 'Workstation', 'Tools'];
    const empForbidden = ['Employees', 'Accounts', 'Reports', 'Settings'];
    const missing = empExpected.filter((x) => !empNav.includes(x));
    const leaked = empForbidden.filter((x) => empNav.includes(x));
    if (missing.length) throw new Error(`Employee missing nav: ${missing.join(', ')}`);
    if (leaked.length) throw new Error(`Employee should NOT see: ${leaked.join(', ')}`);

    log('Employee: click Workstation (reserved must still work)');
    await assertReserved(emp, '/workstation', 'Workstation');
    await shot(emp, 'emp-02-workstation');

    await emp.close();
    await browser.close();
    log('DONE — all checks passed');
    console.log('\n---RESULTS---');
    for (const [k, v] of results) console.log(`${k}: ${JSON.stringify(v)}`);
    process.exit(0);
  } catch (e) {
    log(`FAIL: ${e.message}`);
    console.error(e.stack);
    await browser.close();
    process.exit(1);
  }
}

main();
