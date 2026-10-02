/**
 * Sidebar hierarchy check — Tools is a top-level sibling of Dashboard and
 * Workstation, not a Workstation child. Screenshots → scripts/shots/nav/.
 */
import puppeteer from 'puppeteer-core';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const APP = process.env.APP ?? 'http://localhost:5173';
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome-stable';
const OUT = resolve('scripts/shots/nav');
mkdirSync(OUT, { recursive: true });
const failures = [];
const errors = [];
const check = (ok, m) => { console.log(`  ${ok ? '✓' : '✗'} ${m}`); if (!ok) failures.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (p, n, clip) => { await sleep(200); await p.screenshot({ path: resolve(OUT, `${n}.png`), ...(clip ? { clip } : {}) }); console.log(`  📷 ${n}.png`); };

/** Sidebar as [{ section, items:[{label, active}] }] in render order. */
async function structure(page) {
  return page.$eval('aside nav', (nav) => {
    const out = [];
    for (const group of nav.children) {
      const header = group.querySelector('button');
      const items = [...group.querySelectorAll('a')].map((a) => ({
        label: a.textContent.trim(),
        active: a.className.includes('bg-sidebarActive'),
      }));
      out.push({ section: header ? header.textContent.trim() : null, items });
    }
    return out;
  });
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'], defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.type('input[type="email"]', 'ravi@auditos.local');
  await page.type('input[type="password"]', 'md');
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.location.pathname === '/', { timeout: 15000 });
  await page.waitForSelector('aside nav a');

  console.log('Hierarchy');
  const s = await structure(page);
  const flat = s.map((g) => `${g.section ?? '(top)'}: ${g.items.map((i) => i.label).join(', ')}`);
  flat.forEach((l) => console.log(`    ${l}`));
  const top = s.filter((g) => g.section === null).flatMap((g) => g.items.map((i) => i.label));
  const tools = s.find((g) => g.section === 'TOOLS');
  const ws = s.find((g) => g.section === 'WORKSTATION');
  check(top.includes('Dashboard'), 'Dashboard is top-level');
  check(Boolean(ws), 'Workstation is top-level');
  check(Boolean(tools) && tools.items.map((i) => i.label).join() === 'Tools', 'Tools is top-level: a TOOLS section with the Tools row');
  check(ws && !ws.items.some((i) => i.label === 'Tools'), 'Tools is NOT inside Workstation');
  check(ws && JSON.stringify(ws.items.map((i) => i.label)) === JSON.stringify(['Overview', 'Leads', 'Clients', 'Follow-ups', 'Services', 'Documents']), 'Workstation contains only its own six modules');
  const order = s.map((g) => g.section);
  check(order.indexOf('TOOLS') > order.indexOf('WORKSTATION'), `TOOLS section sits after WORKSTATION (${order.filter(Boolean).join(' → ')})`);
  await shot(page, '01-sidebar-dashboard', { x: 0, y: 0, width: 264, height: 900 });

  console.log('Navigation + active state');
  await page.click('aside nav a[href="/tools"]');
  await page.waitForFunction(() => window.location.pathname === '/tools', { timeout: 10000 });
  await page.waitForSelector('[data-testid="tools-page"]');
  let cards = await page.$$('[data-testid^="tool-card-"]');
  check(cards.length === 18, `clicking Tools opens the Tools page (${cards.length} cards)`);
  let st = await structure(page);
  const active = (st2) => st2.flatMap((g) => g.items).filter((i) => i.active).map((i) => i.label);
  check(JSON.stringify(active(st)) === JSON.stringify(['Tools']), `active on /tools → ${active(st).join(', ')}`);
  await shot(page, '02-sidebar-tools-active', { x: 0, y: 0, width: 264, height: 900 });
  await shot(page, '03-tools-page-full');

  await page.goto(`${APP}/tools/merge-pdf`, { waitUntil: 'networkidle0' });
  st = await structure(page);
  check(JSON.stringify(active(st)) === JSON.stringify(['Tools']), `active on /tools/merge-pdf → ${active(st).join(', ')}`);
  check(Boolean(await page.$('[data-testid="tool-workspace-merge-pdf"]')), 'Tools workspace works after navigation');

  await page.click('aside nav a[href="/workstation/leads"]');
  await page.waitForFunction(() => window.location.pathname === '/workstation/leads', { timeout: 10000 });
  await sleep(300);
  st = await structure(page);
  check(JSON.stringify(active(st)) === JSON.stringify(['Leads']), `active on /workstation/leads → ${active(st).join(', ')} (Tools not highlighted)`);
  await shot(page, '04-sidebar-workstation-active', { x: 0, y: 0, width: 264, height: 900 });

  // Workstation fold does not hide Tools
  await page.evaluate(() => [...document.querySelectorAll('aside button')].find((b) => b.textContent.trim().startsWith('WORKSTATION'))?.click());
  await sleep(300);
  st = await structure(page);
  const wsFolded = st.find((g) => g.section === 'WORKSTATION');
  check(wsFolded && wsFolded.items.length === 0 && st.some((g) => g.section === 'TOOLS' && g.items.some((i) => i.label === 'Tools')), 'folding Workstation hides its items but not Tools');
  await shot(page, '05-sidebar-workstation-folded', { x: 0, y: 0, width: 264, height: 900 });
  await page.evaluate(() => [...document.querySelectorAll('aside button')].find((b) => b.textContent.trim().startsWith('WORKSTATION'))?.click());

  console.log('Refresh');
  await page.goto(`${APP}/tools`, { waitUntil: 'networkidle0' });
  cards = await page.$$('[data-testid^="tool-card-"]');
  check(cards.length === 18, 'browser refresh on /tools works');
  await page.goto(`${APP}/workstation/clients`, { waitUntil: 'networkidle0' });
  check(/Clients/.test(await page.$eval('main h1', (h) => h.textContent)), 'browser refresh on /workstation/clients works');
  await page.goto(`${APP}/`, { waitUntil: 'networkidle0' });
  st = await structure(page);
  check(JSON.stringify(active(st)) === JSON.stringify(['Dashboard']), 'Dashboard active on /');

  console.log('Collapsed rail + mobile');
  await page.click('aside button[aria-label="Collapse sidebar"]');
  await sleep(300);
  await shot(page, '06-sidebar-collapsed', { x: 0, y: 0, width: 80, height: 900 });
  check(Boolean(await page.$('aside nav a[href="/tools"]')), 'Tools present in collapsed rail');
  await page.click('aside button[aria-label="Expand sidebar"]');
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`${APP}/tools`, { waitUntil: 'networkidle0' });
  await page.click('button[aria-label="Open navigation"]');
  await sleep(400);
  await shot(page, '07-mobile-drawer');
  st = await structure(page);
  check(JSON.stringify(active(st)) === JSON.stringify(['Tools']), 'mobile drawer shows Tools active');
} catch (e) {
  failures.push(`crash: ${e.message}`);
  console.log(e.stack);
} finally {
  await browser.close();
}
const real = errors.filter((e) => !/favicon|ERR_ABORTED|status of (401|403|404)/.test(e));
console.log(`\nConsole errors: ${real.length}`); real.forEach((e) => console.log(`  ${e.slice(0, 160)}`));
console.log(`Failures: ${failures.length}`); failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length || real.length ? 1 : 0);
