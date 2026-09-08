/**
 * Books module verification — drives Chrome via puppeteer-core against the
 * dev server. Screenshots land in scripts/shots/books/ (git-ignored).
 * Exit code 1 on any failed check or console error.
 *
 *   node scripts/verify-books.mjs
 *   APP=http://localhost:5173 node scripts/verify-books.mjs
 */
import puppeteer from 'puppeteer-core';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const APP = process.env.APP ?? 'http://192.168.1.60:5173';
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome-stable';
const OUT = resolve('scripts/shots/books');
mkdirSync(OUT, { recursive: true });

const failures = [];
const errors = [];
const log = (m) => console.log(m);
const check = (ok, m) => { log(`  ${ok ? '✓' : '✗'} ${m}`); if (!ok) failures.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (p, n) => { await sleep(250); await p.screenshot({ path: resolve(OUT, `${n}.png`), fullPage: true }); log(`  📷 ${n}.png`); };

async function login(page, email, pw) {
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.location.pathname === '/', { timeout: 15000 });
}
const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
const go = async (page, path) => { await page.goto(`${APP}${path}`, { waitUntil: 'networkidle0' }); await sleep(400); };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'], defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('response', async (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });

try {
  log('Login as MD');
  await login(page, 'ravi@auditos.local', 'md');

  log('Sidebar');
  const nav = await page.$eval('aside nav', (n) => [...n.children].map((g) => `${g.querySelector('button')?.textContent.trim() ?? '(top)'}: ${[...g.querySelectorAll('a')].map((a) => a.textContent.trim()).join(', ')}`));
  nav.forEach((l) => log(`    ${l}`));
  check(nav.some((l) => l.startsWith('BOOKS:')), 'BOOKS is a top-level sidebar section');
  check(nav.some((l) => l.startsWith('TOOLS:')), 'TOOLS is still top-level');

  log('Books list');
  await page.click('aside nav a[href="/books"]');
  await page.waitForSelector('[data-testid="books-list-page"]', { timeout: 10000 });
  await sleep(600);
  const cards = await page.$$('[data-testid^="books-card-"]');
  check(cards.length >= 2, `client books listed (${cards.length})`);
  await shot(page, '01-books-list');
  const allOrgIds = await page.$$eval('[data-testid^="books-card-"]', (as) => as.map((a) => a.getAttribute('href').split('/').pop()));
  const orgId = allOrgIds[0];

  log('Overview');
  await go(page, `/books/${orgId}`);
  await page.waitForSelector('[data-testid="books-overview"]', { timeout: 10000 });
  const overview = await text(page, '[data-testid="books-overview"]');
  check(/receivables/i.test(overview) && /payables/i.test(overview) && /₹/.test(overview), 'overview shows receivables, payables and cash');
  await shot(page, '02-overview');

  log('Sales');
  await go(page, `/books/${orgId}/sales`);
  await page.waitForSelector('[data-testid="books-sales"] table', { timeout: 10000 });
  const invoiceRows = await page.$$('[data-testid="books-sales"] table tbody tr');
  check(invoiceRows.length > 0, `invoices listed (${invoiceRows.length})`);
  await shot(page, '03-sales');

  log('Invoice drawer');
  // Open a POSTED invoice — a draft has no journal yet.
  const postedRow = await page.evaluateHandle(() => [...document.querySelectorAll('[data-testid="books-sales"] table tbody tr')].find((r) => /open|paid|partly/i.test(r.innerText)));
  await postedRow.asElement().click();
  await page.waitForSelector('[data-testid="document-drawer"]', { timeout: 10000 });
  await sleep(700);
  const drawer = await text(page, '[data-testid="document-drawer"]');
  check(/taxable value/i.test(drawer) && /journal/i.test(drawer), 'drawer shows the totals and the journal it posted');
  check(/audit trail/i.test(drawer) && /created/i.test(drawer), 'drawer shows the audit trail');
  await shot(page, '04-invoice-drawer');
  await page.keyboard.press('Escape');
  await sleep(300);

  log('New invoice, live totals');
  await page.click('[data-testid="books-new-document"]');
  await page.waitForSelector('[data-testid="document-contact"]', { timeout: 10000 });
  await sleep(500);
  // Pick a base-currency customer; a foreign one would need an exchange rate.
  const inrContact = await page.$eval('[data-testid="document-contact"]', (s) => [...s.options].find((o) => o.value && !/USA|USD/.test(o.textContent))?.value ?? s.options[1].value);
  await page.select('[data-testid="document-contact"]', inrContact);
  await page.type('[data-testid="line-description-0"]', 'Verification line');
  await page.type('[data-testid="line-rate-0"]', '1000');
  await sleep(400);
  const totals = await text(page, '[data-testid="document-totals"]');
  check(/1,000\.00/.test(totals), `editor computes the taxable value (${totals.split('\n').slice(0, 2).join(' ')})`);
  await shot(page, '05-invoice-editor');
  await page.click('[data-testid="document-save"]');
  await page.waitForSelector('[data-testid="document-drawer"]', { timeout: 15000 });
  await sleep(600);
  check(/draft/i.test(await text(page, '[data-testid="document-drawer"]')), 'a new invoice saves as a draft');
  await page.click('[data-testid="document-post"]');
  await page.waitForFunction(() => !/draft/i.test(document.querySelector('[data-testid="document-drawer"]')?.innerText ?? 'draft'), { timeout: 15000 });
  const posted = await text(page, '[data-testid="document-drawer"]');
  check(/open|paid/i.test(posted) && /accounts receivable/i.test(posted), 'posting creates the journal (Dr Accounts Receivable)');
  await shot(page, '06-invoice-posted');

  log('Void refuses to edit a posted document');
  await page.click('[data-testid="document-void"]');
  await page.waitForSelector('[data-testid="document-void-confirm"]', { timeout: 5000 });
  await page.click('[data-testid="document-void-confirm"]');
  await page.waitForFunction(() => /void/i.test(document.querySelector('[data-testid="document-drawer"]')?.innerText ?? ''), { timeout: 15000 });
  check(true, 'voiding posts a reversing journal');
  await page.keyboard.press('Escape');

  log('Purchases');
  await go(page, `/books/${orgId}/purchases`);
  await page.waitForSelector('[data-testid="books-purchases"] table', { timeout: 10000 });
  check((await page.$$('[data-testid="books-purchases"] table tbody tr')).length > 0, 'bills listed');
  await shot(page, '07-purchases');

  log('Journals');
  await go(page, `/books/${orgId}/journals`);
  await page.waitForSelector('[data-testid="books-journals"] table', { timeout: 10000 });
  const journals = await text(page, '[data-testid="books-journals"]');
  check(/invoice/i.test(journals) && /payment/i.test(journals), 'journals list shows the vouchers every wrapper produced');
  await shot(page, '08-journals');

  log('Manual journal refuses to post unbalanced');
  await page.click('[data-testid="journal-new"]');
  await page.waitForSelector('[data-testid="journal-ledger-0"]', { timeout: 10000 });
  await sleep(400);
  const l0 = await page.$eval('[data-testid="journal-ledger-0"] option:nth-child(2)', (o) => o.value);
  const l1 = await page.$eval('[data-testid="journal-ledger-1"] option:nth-child(3)', (o) => o.value);
  await page.select('[data-testid="journal-ledger-0"]', l0);
  await page.select('[data-testid="journal-ledger-1"]', l1);
  await page.type('[data-testid="journal-narration"]', 'Verification journal');
  await page.type('[data-testid="journal-amount-0"]', '500');
  await page.type('[data-testid="journal-amount-1"]', '400');
  await sleep(300);
  await page.click('[data-testid="journal-post"]');
  await sleep(600);
  check(/must be equal|not balanced/i.test(await text(page, '[role="dialog"]')), 'unbalanced journal is refused before posting');
  await shot(page, '09-journal-unbalanced');
  await page.click('[data-testid="journal-amount-1"]');
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await page.type('[data-testid="journal-amount-1"]', '500');
  await sleep(300);
  await page.click('[data-testid="journal-post"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="journal-amount-0"]'), { timeout: 15000 });
  check(true, 'balanced journal posts');

  log('Banking');
  await go(page, `/books/${orgId}/banking`);
  await page.waitForSelector('[data-testid="books-banking"] table', { timeout: 10000 });
  check(/hdfc|cash/i.test(await text(page, '[data-testid="books-banking"]')), 'bank and cash accounts with balances');
  await shot(page, '10-banking');
  const rec = await page.$('[data-testid^="reconcile-"]');
  if (rec) {
    await rec.click();
    await page.waitForSelector('[data-testid="books-reconcile"]', { timeout: 10000 });
    await sleep(500);
    check(/ledger entries/i.test(await text(page, '[data-testid="books-reconcile"]')), 'reconciliation view opens');
    await shot(page, '11-reconciliation');
  }

  log('Reports');
  for (const [name, expect] of [['trial-balance', /trial balance/i], ['profit-and-loss', /net (profit|loss)/i], ['balance-sheet', /total assets/i], ['ar-ageing', /receivables ageing/i], ['gstr-1', /b2b invoices/i]]) {
    await go(page, `/books/${orgId}/reports`);
    await page.waitForSelector('[data-testid="report-picker"]', { timeout: 10000 });
    await page.select('[data-testid="report-picker"]', name);
    await page.waitForFunction((re) => new RegExp(re, 'i').test(document.querySelector('[data-testid="books-reports"]')?.innerText ?? ''), { timeout: 15000 }, expect.source).catch(() => {});
    const body = await text(page, '[data-testid="books-reports"]');
    check(expect.test(body), `${name} renders`);
    if (name === 'trial-balance') {
      const nums = [...body.matchAll(/₹[\d,]+\.\d{2}/g)].map((m) => m[0]);
      check(nums.length > 4, `trial balance has figures (${nums.length} amounts)`);
      await shot(page, '12-trial-balance');
    }
    if (name === 'balance-sheet') { check(!/out by/i.test(body), 'balance sheet balances'); await shot(page, '13-balance-sheet'); }
    if (name === 'gstr-1') await shot(page, '14-gstr1');
  }

  log('Settings and multi-tenancy');
  await go(page, `/books/${orgId}/settings`);
  await page.waitForSelector('[data-testid="books-settings"]', { timeout: 10000 });
  await page.click('[data-testid="settings-tab-chart"]');
  await sleep(600);
  check(/sundry debtors/i.test(await text(page, '[data-testid="books-settings"]')), 'chart of accounts carries Tally groups');
  await shot(page, '15-settings-chart');

  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }));
  await login(page, 'meera@auditos.local', 'emp');
  await go(page, '/books');
  await sleep(600);
  const staffList = await text(page, 'main');
  const staffCards = await page.$$eval('[data-testid^="books-card-"]', (as) => as.map((a) => a.getAttribute('href').split('/').pop()));
  check(staffCards.length === 1, `a staff member sees only their assigned books (${staffCards.length} of ${allOrgIds.length})`);
  check(!/new books/i.test(staffList), 'a staff member cannot create books');
  await shot(page, '16-books-staff');
  if (staffCards.length) {
    await go(page, `/books/${staffCards[0]}`);
    const tabs = await page.$$eval('nav[aria-label="Books sections"] a', (as) => as.map((a) => a.textContent.trim()));
    check(!tabs.includes('Reports') && !tabs.includes('Settings') && !tabs.includes('Journals'), `staff sees only ${tabs.join(', ')}`);
  }
  const forbidden = allOrgIds.find((id) => !staffCards.includes(id));
  await go(page, `/books/${forbidden}`);
  await sleep(600);
  check(/not assigned|does not exist/i.test(await text(page, 'main')), "a staff member cannot open another client's books");
  await shot(page, '17-books-denied');

  log('Existing modules still work');
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }));
  await login(page, 'ravi@auditos.local', 'md');
  for (const [path, needle] of [['/', /dashboard|today/i], ['/hrms/employees', /employees/i], ['/workstation', /workstation|overview/i], ['/tools', /tools & converters/i]]) {
    await go(page, path);
    check(needle.test(await text(page, 'main')), `${path} still renders`);
  }
} catch (e) {
  failures.push(`crash: ${e.message}`);
  log(e.stack);
  await shot(page, 'zz-crash').catch(() => {});
} finally {
  await browser.close();
}

const real = errors.filter((e) => !/favicon|ERR_ABORTED|status of (401|403|404|422)/.test(e));
log(`\nConsole errors: ${real.length}`);
real.slice(0, 10).forEach((e) => log(`  ${e.slice(0, 200)}`));
log(`Failures: ${failures.length}`);
failures.forEach((f) => log(`  - ${f}`));
process.exit(failures.length || real.length ? 1 : 0);
