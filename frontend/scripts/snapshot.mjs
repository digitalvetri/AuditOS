import puppeteer from 'puppeteer-core';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = 'http://localhost:5173';
const OUT = resolve('scripts/snap');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

async function login(page, email, password) {
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle0', timeout: 15000 });
  await page.waitForSelector('input[type="email"]');
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.location.pathname === '/', { timeout: 15000 });
  await page.waitForSelector('aside nav a', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 800));
}

async function shot(page, name) {
  const path = resolve(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  console.log(`  -> ${path}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1440, height: 900 },
});
try {
  const md = await browser.newPage();
  await md.goto(APP, { waitUntil: 'domcontentloaded' });
  await md.evaluate(() => localStorage.clear());
  const c = await md.cookies();
  if (c.length) await md.deleteCookie(...c);

  console.log('MD login + dashboard');
  await login(md, 'ravi@auditos.local', 'md');
  await shot(md, '01-md-dashboard');

  console.log('MD sidebar collapsed');
  await md.click('button[aria-label="Collapse sidebar"]');
  await new Promise((r) => setTimeout(r, 500));
  await shot(md, '02-md-collapsed');
  await md.click('button[aria-label="Expand sidebar"]');

  console.log('MD → Tools');
  await md.evaluate(() => {
    const a = Array.from(document.querySelectorAll('aside nav a')).find((el) => el.textContent.trim() === 'Tools');
    a.click();
  });
  await md.waitForFunction(() => window.location.pathname === '/tools', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 500));
  await shot(md, '03-md-tools');

  await md.close();

  const emp = await browser.newPage();
  await emp.goto(APP, { waitUntil: 'domcontentloaded' });
  const c2 = await emp.cookies();
  if (c2.length) await emp.deleteCookie(...c2);
  await emp.evaluate(() => localStorage.clear());
  console.log('Employee login + dashboard');
  await login(emp, 'meera@auditos.local', 'emp');
  await shot(emp, '04-emp-dashboard');
  await emp.close();

  console.log('DONE');
  await browser.close();
} catch (e) {
  console.error(e);
  await browser.close();
  process.exit(1);
}
