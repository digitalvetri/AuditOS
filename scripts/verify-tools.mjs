/**
 * Tools module verification — drives Chrome via puppeteer-core against the
 * dev server (same pattern as verify.mjs). Screenshots land in
 * scripts/shots/tools/ (git-ignored). Exit code 1 on any failed check.
 *
 *   node scripts/verify-tools.mjs            # full run
 *   CHROME=/path/to/chrome node scripts/verify-tools.mjs
 */
import puppeteer from 'puppeteer-core';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const APP = process.env.APP ?? 'http://localhost:5173';
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome-stable';
const FX = resolve('server/src/modules/tools/__tests__/fixtures');
const OUT = resolve('scripts/shots/tools');
mkdirSync(OUT, { recursive: true });

const log = (m) => console.log(m);
const failures = [];
const consoleErrors = [];
const check = (ok, msg) => { if (ok) log(`  ✓ ${msg}`); else { log(`  ✗ ${msg}`); failures.push(msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name) {
  await sleep(250);
  await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: true });
  log(`  📷 ${name}.png`);
}

async function login(page, email, password) {
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.location.pathname === '/', { timeout: 15000 });
}

async function go(page, path) {
  await page.goto(`${APP}${path}`, { waitUntil: 'networkidle0' });
  await sleep(200);
}

async function text(page, sel) {
  return page.$eval(sel, (el) => el.textContent?.trim() ?? '').catch(() => '');
}

async function uploadAndRun(page, path, files, { before, timeout = 120000, expectError = false } = {}) {
  await go(page, path);
  const input = await page.$('input[type="file"]');
  await input.uploadFile(...files.map((f) => resolve(FX, f)));
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-testid="tool-run"]');
    return b && !document.querySelector('[data-testid="file-list"] .text-red') && !/Uploading|Checking/.test(document.querySelector('[data-testid="file-list"]')?.textContent ?? '');
  }, { timeout: 30000 });
  if (before) await before();
  await sleep(150);
  await page.click('[data-testid="tool-run"]');
  await page.waitForSelector(expectError ? '[data-testid="tool-error"]' : '[data-testid="result-panel"]', { timeout });
  await sleep(200);
  return expectError ? text(page, '[data-testid="tool-error"]') : text(page, '[data-testid="result-panel"]');
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  try {
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    log('Login as MD');
    await login(page, 'ravi@auditos.local', 'md');

    // ── Tools page ──────────────────────────────────────────────────────
    log('Tools page');
    await go(page, '/tools');
    await shot(page, '01-tools-desktop');
    const cards = await page.$$('[data-testid^="tool-card-"]');
    check(cards.length === 18, `18 cards rendered (${cards.length})`);
    const groups = await page.$$eval('[data-testid^="tools-group-"] h2', (els) => els.map((e) => e.textContent));
    check(JSON.stringify(groups) === JSON.stringify(['Document conversion', 'PDF utilities', 'Compliance converters']), `group labels ${groups.join(' · ')}`);
    check((await text(page, 'h1')) === 'Tools & Converters', 'header title');
    check(Boolean(await page.$('[data-testid="tools-documents-link"]')), 'Documents entry point present');
    const names = await page.$$eval('[data-testid^="tool-card-"] h3', (els) => els.map((e) => e.textContent));
    check(names.includes('Unlock PDF') && names.includes('e-Sign PDF') && names.includes('GST JSON ⇄ Excel'), 'card names intact');

    // Search
    const searchCount = async (q) => {
      await page.click('[data-testid="tools-search"]');
      await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      if (q) await page.type('[data-testid="tools-search"]', q);
      await sleep(120);
      return page.$$eval('[data-testid^="tool-card-"]', (els) => els.map((e) => e.querySelector('h3').textContent));
    };
    const pdf = await searchCount('pdf');
    check(pdf.length >= 10 && pdf.includes('Merge PDF') && pdf.includes('OCR Scan'), `search "pdf" → ${pdf.length} cards`);
    const excel = await searchCount('excel');
    check(excel.includes('GST JSON ⇄ Excel') && excel.includes('Excel to Tally XML') && excel.includes('CSV to Excel'), `search "excel" → ${excel.length} cards`);
    await shot(page, '02-tools-search-excel');
    const tally = await searchCount('tally');
    check(tally.length === 1 && tally[0] === 'Excel to Tally XML', `search "tally" → ${tally.join(', ')}`);
    const visibleGroups = await page.$$('[data-testid^="tools-group-"]');
    check(visibleGroups.length === 1, 'empty sections hidden');
    await searchCount('zzzz');
    check(Boolean(await page.$('[data-testid="tools-empty"]')), 'no-match empty state');
    await searchCount('');

    // Responsive
    await page.setViewport({ width: 900, height: 1000 });
    await go(page, '/tools');
    await shot(page, '03-tools-tablet');
    await page.setViewport({ width: 390, height: 844 });
    await go(page, '/tools');
    await shot(page, '04-tools-mobile');
    await page.setViewport({ width: 1440, height: 900 });

    // Coming soon
    await go(page, '/tools/gst-json-excel');
    check(Boolean(await page.$('[data-testid="coming-soon"]')), 'compliance tool → Coming soon state');
    await shot(page, '05-coming-soon');

    // ── Tools ───────────────────────────────────────────────────────────
    log('PDF to Excel');
    await go(page, '/tools/pdf-to-excel');
    await shot(page, '06-pdf-to-excel-idle');
    let r = await uploadAndRun(page, '/tools/pdf-to-excel', ['out/invoice.pdf']);
    check(/Conversion completed/.test(r) && /invoice\.xlsx/.test(r), 'pdf-to-excel → invoice.xlsx');
    await shot(page, '07-pdf-to-excel-success');
    await page.click('[data-testid="result-preview"]');
    await page.waitForSelector('[role="dialog"] table', { timeout: 15000 });
    await shot(page, '08-pdf-to-excel-preview');
    await page.keyboard.press('Escape');

    log('CSV to Excel');
    await go(page, '/tools/csv-to-excel');
    const input = await page.$('input[type="file"]');
    await input.uploadFile(resolve(FX, 'ledger.csv'));
    await page.waitForFunction(() => /Columns/.test(document.body.textContent), { timeout: 20000 });
    await shot(page, '09-csv-to-excel-options');
    await page.click('[data-testid="tool-run"]');
    await page.waitForSelector('[data-testid="result-panel"]', { timeout: 60000 });
    r = await text(page, '[data-testid="result-panel"]');
    check(/ledger\.xlsx/.test(r), 'csv-to-excel → ledger.xlsx');

    log('Excel to PDF / Word to PDF / PDF to Word');
    r = await uploadAndRun(page, '/tools/excel-to-pdf', ['invoice.xlsx']);
    check(/invoice\.pdf/.test(r), 'excel-to-pdf → invoice.pdf');
    r = await uploadAndRun(page, '/tools/word-to-pdf', ['letter.docx']);
    check(/letter\.pdf/.test(r), 'word-to-pdf → letter.pdf');
    r = await uploadAndRun(page, '/tools/pdf-to-word', ['out/letter.pdf']);
    check(/letter\.docx/.test(r), 'pdf-to-word → letter.docx');
    r = await uploadAndRun(page, '/tools/pdf-to-word', ['out/images.pdf'], { expectError: true });
    check(/no text layer/i.test(r), 'pdf-to-word on scan → "no text layer" error');
    await shot(page, '10-pdf-to-word-no-text-layer');

    log('Image to PDF');
    r = await uploadAndRun(page, '/tools/image-to-pdf', ['scan.png', 'scan.jpg', 'scan.webp']);
    check(/images-3\.pdf/.test(r), 'image-to-pdf (3 images, reorderable) → images-3.pdf');

    log('Merge PDF');
    await go(page, '/tools/merge-pdf');
    const mi = await page.$('input[type="file"]');
    await mi.uploadFile(resolve(FX, 'out/invoice.pdf'), resolve(FX, 'out/letter.pdf'));
    await page.waitForFunction(() => /pages in total/.test(document.body.textContent), { timeout: 20000 });
    await shot(page, '11-merge-ready');
    await page.click('[data-testid="tool-run"]');
    await page.waitForSelector('[data-testid="result-panel"]', { timeout: 60000 });
    r = await text(page, '[data-testid="result-panel"]');
    check(/merged\.pdf/.test(r) && /2 files combined into 3 pages/.test(r), 'merge-pdf → 3 pages');

    log('Split PDF');
    await go(page, '/tools/split-pdf');
    const si = await page.$('input[type="file"]');
    await si.uploadFile(resolve(FX, 'out/merged.pdf'));
    await page.waitForSelector('img[alt^="Page"]', { timeout: 30000 });
    await page.click('img[alt="Page 1"]');
    await page.click('img[alt="Page 3"]');
    await sleep(100);
    const ranges = await page.$eval('input[placeholder="1-3, 7, 10-12"]', (el) => el.value);
    check(ranges === '1, 3', `thumbnail picks build ranges (${ranges})`);
    await shot(page, '12-split-thumbnails');
    await page.click('[data-testid="tool-run"]');
    await page.waitForSelector('[data-testid="result-panel"]', { timeout: 60000 });
    r = await text(page, '[data-testid="result-panel"]');
    check(/split\.zip/.test(r) && /2 files/.test(r), 'split-pdf → ZIP with 2 files');

    log('Compress PDF');
    r = await uploadAndRun(page, '/tools/compress-pdf', ['out/merged.pdf']);
    check(/compressed\.pdf/.test(r), `compress-pdf → ${/(\d+(\.\d+)?% smaller|no reduction)/.exec(r)?.[0] ?? '?'}`);
    await shot(page, '13-compress-result');

    log('Unlock PDF');
    r = await uploadAndRun(page, '/tools/unlock-pdf', ['out/invoice-locked.pdf'], {
      expectError: true,
      before: async () => {
        await page.type('input[type="password"]', 'wrong');
        await page.click('input[type="checkbox"]');
      },
    });
    check(/Incorrect password/.test(r), 'unlock-pdf wrong password → "Incorrect password."');
    await shot(page, '14-unlock-wrong-password');
    await page.click('input[type="password"]');
    await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.type('input[type="password"]', 'secret');
    await page.click('[data-testid="tool-run"]');
    await page.waitForSelector('[data-testid="result-panel"]', { timeout: 60000 });
    r = await text(page, '[data-testid="result-panel"]');
    check(/unlocked\.pdf/.test(r), 'unlock-pdf correct password → unlocked.pdf');

    log('e-Sign PDF');
    r = await uploadAndRun(page, '/tools/esign-pdf', ['out/letter.pdf'], {
      before: async () => {
        await page.waitForFunction(() => document.querySelector('input[type="text"]')?.value?.length > 0, { timeout: 5000 }).catch(() => {});
        const inputs = await page.$$('input[type="text"]');
        await inputs[1].type('Managing Partner');
      },
    });
    check(/signed\.pdf/.test(r) && /Not a DSC signature/.test(r), 'esign-pdf → signed.pdf, labelled not a DSC');
    await shot(page, '15-esign-result');

    log('OCR Scan');
    r = await uploadAndRun(page, '/tools/ocr-scan', ['scan.png'], { timeout: 180000 });
    check(/searchable\.pdf/.test(r) && /Confidence/.test(r) && /Also saved/.test(r), 'ocr-scan → searchable PDF + txt, confidence shown');
    await page.click('button ::-p-text(Show extracted text)').catch(() => {});
    await shot(page, '16-ocr-result');

    // ── Documents ───────────────────────────────────────────────────────
    log('Documents');
    await go(page, '/tools/documents');
    await page.waitForSelector('table tbody tr', { timeout: 15000 });
    await shot(page, '17-documents-desktop');
    const rows = await page.$$('table tbody tr');
    check(rows.length >= 12, `documents listed (${rows.length})`);
    await page.click('[data-testid="documents-search"]');
    await page.type('[data-testid="documents-search"]', 'ledger');
    await page.waitForFunction(() => {
      const rs = [...document.querySelectorAll('table tbody tr')];
      return rs.length > 0 && rs.every((r) => /ledger/i.test(r.textContent));
    }, { timeout: 10000 }).catch(() => {});
    const filtered = await page.$$eval('table tbody tr', (els) => els.map((e) => e.textContent));
    check(filtered.length >= 1 && filtered.every((t) => /ledger/i.test(t)), `search "ledger" → ${filtered.length} matching row(s)`);
    await page.click('table tbody tr');
    await page.waitForSelector('[data-testid="document-drawer"]', { timeout: 10000 });
    await page.waitForFunction(() => /Audit trail/.test(document.querySelector('[data-testid="document-drawer"]')?.textContent ?? '') && /Uploaded/.test(document.querySelector('[data-testid="document-drawer"]')?.textContent ?? ''), { timeout: 10000 });
    await shot(page, '18-documents-drawer');
    const drawer = await text(page, '[data-testid="document-drawer"]');
    check(/Source file/.test(drawer) && /ledger\.csv/.test(drawer) && /Converted/.test(drawer), 'drawer shows source, job and audit trail');
    await page.click('[data-testid="document-delete"]');
    await page.click('[data-testid="document-delete-confirm"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="document-drawer"]'), { timeout: 10000 });
    check(true, 'delete via drawer (two-step confirm)');
    await page.setViewport({ width: 390, height: 844 });
    await go(page, '/tools/documents');
    await page.waitForSelector('ul li', { timeout: 15000 });
    await shot(page, '19-documents-mobile');
    await page.setViewport({ width: 1440, height: 900 });

    // ── Regressions ─────────────────────────────────────────────────────
    log('Existing modules still render');
    for (const [path, sel] of [['/', 'main'], ['/hrms/employees', 'main table, main [data-testid]'], ['/workstation', 'main'], ['/hrms/documents', 'main']]) {
      await go(page, path);
      check(Boolean(await page.$(sel)), `${path} renders`);
    }

    // ── Employee scope ──────────────────────────────────────────────────
    log('Employee scope');
    await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }));
    await login(page, 'meera@auditos.local', 'emp');
    await go(page, '/tools/documents');
    await sleep(500);
    const emp = await text(page, 'main');
    check(/your documents/.test(emp) && !/invoice\.xlsx/.test(emp), 'employee sees only own documents');
    await shot(page, '20-documents-employee');
  } catch (err) {
    failures.push(`crash: ${err.message}`);
    log(`  ✗ ${err.stack}`);
    await shot(page, 'zz-crash').catch(() => {});
  } finally {
    await browser.close();
  }

  const realErrors = consoleErrors.filter((e) => !/favicon|ERR_ABORTED|Failed to load resource: the server responded with a status of (401|403|404|422)/.test(e));
  log(`\nConsole errors: ${realErrors.length}`);
  realErrors.slice(0, 20).forEach((e) => log(`  ${e.slice(0, 200)}`));
  log(`Failures: ${failures.length}`);
  failures.forEach((f) => log(`  - ${f}`));
  process.exit(failures.length || realErrors.length ? 1 : 0);
}

main();
