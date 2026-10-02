import puppeteer from 'puppeteer-core';
import { resolve } from 'node:path';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = 'http://localhost:5173';
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1440, height: 900 },
});
const p = await browser.newPage();
await p.goto(APP, { waitUntil: 'domcontentloaded' });
await p.evaluate(() => localStorage.clear());
const c = await p.cookies(); if (c.length) await p.deleteCookie(...c);
await p.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
await p.type('input[type="email"]', 'ravi@auditos.local');
await p.type('input[type="password"]', 'md');
await p.click('button[type="submit"]');
await p.waitForFunction(() => window.location.pathname === '/');
await p.waitForSelector('aside nav a');

async function shot(path, name) {
  await p.goto(`${APP}${path}`, { waitUntil: 'networkidle0', timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1000));
  await p.screenshot({ path: resolve(`scripts/snap/${name}.png`), fullPage: false });
  console.log(`${name}.png`);
}

await shot('/hrms/attendance', 'mod-attendance');
await shot('/hrms/employees', 'mod-employees');
await shot('/hrms/payroll', 'mod-payroll');
await browser.close();
