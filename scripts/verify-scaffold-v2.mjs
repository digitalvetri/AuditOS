/**
 * Scaffold verification against the v2 shell (ui-shell-redesign branch).
 *
 * User scenario:
 *   - Log in as MD and as Employee
 *   - Check the sidebar renders role-scoped nav
 *   - Click Workstation and Tools (reserved screens)
 *   - Collapse the sidebar and refresh (state should persist)
 *   - Log out
 *
 * We drive Chrome at http://localhost:5173. Each step captures a screenshot
 * and text observations for the reviewer.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = 'http://localhost:5173';
const SHOTS = resolve('scripts/shots-v2');
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

const LOGINS = {
  md:       { email: 'ravi@auditos.local',  password: 'md' },
  employee: { email: 'meera@auditos.local', password: 'emp' },
};

const findings = [];
function log(msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }
function record(tag, msg) { findings.push({ tag, msg }); log(`  ${tag} ${msg}`); }

async function shot(page, name) {
  const path = resolve(SHOTS, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  log(`  screenshot -> ${path}`);
}

async function login(page, who) {
  const { email, password } = LOGINS[who];
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle0', timeout: 15000 });
  await page.waitForSelector('input[type="email"]');
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.location.pathname === '/', { timeout: 15000 });
  await page.waitForSelector('aside nav a', { timeout: 5000 });
}

async function sidebarItems(page) {
  return page.$$eval('aside nav a', (links) =>
    links.map((a) => ({
      label: a.textContent.trim(),
      href:  a.getAttribute('href'),
      active: a.className.includes('sidebarActive') || a.getAttribute('aria-current') === 'page',
    })),
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
    // ── MD ────────────────────────────────────────────────────────────────
    const md = await browser.newPage();
    md.on('console', (m) => { if (m.type() === 'error') log(`  console.error(md): ${m.text()}`); });
    md.on('pageerror', (e) => log(`  pageerror(md): ${e.message}`));
    await md.goto(APP, { waitUntil: 'domcontentloaded' });
    await md.evaluate(() => localStorage.clear());
    const priorCookies = await md.cookies();
    if (priorCookies.length) await md.deleteCookie(...priorCookies);

    log('MD: login');
    await login(md, 'md');
    await shot(md, 'md-01-dashboard');

    const mdNav = await sidebarItems(md);
    log(`  MD sidebar (${mdNav.length}): ${mdNav.map((n) => n.label).join(' · ')}`);

    log('MD: /workstation (not in sidebar in v2 — direct URL)');
    await md.goto(`${APP}/workstation`, { waitUntil: 'networkidle0', timeout: 15000 });
    const wsTitle = await md.$eval('h1', (h) => h.textContent.trim()).catch(() => null);
    log(`  /workstation h1: ${JSON.stringify(wsTitle)}`);
    await shot(md, 'md-02-workstation');

    log('MD: /tools via sidebar click');
    await md.goto(`${APP}/`, { waitUntil: 'networkidle0' });
    const toolsClicked = await md.evaluate(() => {
      const a = Array.from(document.querySelectorAll('aside nav a')).find((el) => el.textContent.trim() === 'Tools');
      if (!a) return false;
      a.click(); return true;
    });
    log(`  Tools link found & clicked: ${toolsClicked}`);
    await md.waitForFunction(() => window.location.pathname === '/tools', { timeout: 5000 }).catch(() => {});
    const toolsTitle = await md.$eval('h1', (h) => h.textContent.trim()).catch(() => null);
    log(`  /tools h1: ${JSON.stringify(toolsTitle)}`);
    await shot(md, 'md-03-tools');

    log('MD: collapse sidebar');
    await md.goto(`${APP}/`, { waitUntil: 'networkidle0' });
    const beforeWidth = await md.$eval('aside', (a) => a.getBoundingClientRect().width);
    log(`  pre-collapse sidebar width: ${beforeWidth}px`);
    const collapseBtn = await md.$('button[aria-label="Collapse sidebar"]');
    if (!collapseBtn) { record('FAIL', 'Collapse button [aria-label="Collapse sidebar"] not found'); }
    else await collapseBtn.click();
    await new Promise((r) => setTimeout(r, 500));
    const collapsedWidth = await md.$eval('aside', (a) => a.getBoundingClientRect().width);
    log(`  post-collapse sidebar width: ${collapsedWidth}px`);
    await shot(md, 'md-04-collapsed');
    if (collapsedWidth > 80) record('FAIL', `Sidebar did not collapse (width=${collapsedWidth}px)`);

    log('MD: refresh — collapse should persist');
    await md.reload({ waitUntil: 'networkidle0' });
    await md.waitForSelector('aside', { timeout: 5000 });
    const afterRefreshWidth = await md.$eval('aside', (a) => a.getBoundingClientRect().width);
    log(`  post-refresh sidebar width: ${afterRefreshWidth}px`);
    await shot(md, 'md-05-collapse-after-refresh');
    if (afterRefreshWidth > 80) record('FAIL', `Collapse did not persist across refresh (width=${afterRefreshWidth}px)`);

    log('MD: expand back');
    await md.click('button[aria-label="Expand sidebar"]');
    await new Promise((r) => setTimeout(r, 300));

    log('MD: logout via profile dropdown');
    await md.click('button[aria-haspopup="menu"]');
    await md.waitForSelector('div[role="menu"]', { timeout: 3000 });
    await md.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button[role="menuitem"]')).find((b) => b.textContent.trim() === 'Log out');
      if (!btn) throw new Error('Log out menu item missing');
      btn.click();
    });
    await md.waitForSelector('input[type="email"]', { timeout: 5000 });
    log(`  post-logout URL: ${md.url()}`);
    if (!md.url().endsWith('/login')) record('FAIL', `Logout did not route to /login (got ${md.url()})`);
    await shot(md, 'md-06-logged-out');
    await md.close();

    // ── Employee ─────────────────────────────────────────────────────────
    const emp = await browser.newPage();
    emp.on('console', (m) => { if (m.type() === 'error') log(`  console.error(emp): ${m.text()}`); });
    emp.on('pageerror', (e) => log(`  pageerror(emp): ${e.message}`));
    await emp.goto(APP, { waitUntil: 'domcontentloaded' });
    const c2 = await emp.cookies();
    if (c2.length) await emp.deleteCookie(...c2);
    await emp.evaluate(() => localStorage.clear());

    log('Employee: login');
    await login(emp, 'employee');
    await shot(emp, 'emp-01-dashboard');

    const empNav = await sidebarItems(emp);
    log(`  Employee sidebar (${empNav.length}): ${empNav.map((n) => n.label).join(' · ')}`);

    // §6.1: An Employee should not see Employees, Accounts, Reports, Settings.
    const forbiddenForEmployee = ['Employees', 'Accounts', 'Reports', 'Settings'];
    const leaked = empNav.map((n) => n.label).filter((l) => forbiddenForEmployee.includes(l));
    if (leaked.length) {
      record('FAIL', `Employee sees admin-only items in sidebar: ${leaked.join(', ')} (spec §6.1 says these must be hidden by role)`);
    }

    // Compare MD vs Employee — should differ.
    if (mdNav.length === empNav.length && mdNav.every((n, i) => n.label === empNav[i].label)) {
      record('FAIL', 'MD and Employee sidebars are identical — no role scoping happening');
    } else {
      record('PASS', 'MD and Employee sidebars differ');
    }

    log('Employee: /workstation route reachable');
    await emp.goto(`${APP}/workstation`, { waitUntil: 'networkidle0' });
    const empWsTitle = await emp.$eval('h1', (h) => h.textContent.trim()).catch(() => null);
    log(`  emp /workstation h1: ${JSON.stringify(empWsTitle)}`);
    await shot(emp, 'emp-02-workstation');

    log('Employee: logout');
    await emp.goto(`${APP}/`, { waitUntil: 'networkidle0' });
    await emp.click('button[aria-haspopup="menu"]');
    await emp.waitForSelector('div[role="menu"]', { timeout: 3000 });
    await emp.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button[role="menuitem"]')).find((b) => b.textContent.trim() === 'Log out');
      btn?.click();
    });
    await emp.waitForSelector('input[type="email"]', { timeout: 5000 });
    log(`  emp post-logout URL: ${emp.url()}`);
    await shot(emp, 'emp-03-logged-out');

    await emp.close();
    await browser.close();

    console.log('\n---FINDINGS---');
    for (const f of findings) console.log(`${f.tag} ${f.msg}`);
    console.log('---');
    process.exit(0);
  } catch (e) {
    log(`SCRIPT ERROR: ${e.message}`);
    console.error(e.stack);
    await browser.close();
    process.exit(1);
  }
}

main();
