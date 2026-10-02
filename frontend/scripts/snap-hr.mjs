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
await p.type('input[type="email"]', 'priya@auditos.local');
await p.type('input[type="password"]', 'hr');
await p.click('button[type="submit"]');
await p.waitForFunction(() => window.location.pathname === '/');
await p.waitForSelector('aside nav a');
await new Promise((r) => setTimeout(r, 800));
await p.screenshot({ path: resolve('scripts/snap/hr-full.png'), fullPage: false });
console.log('hr-full.png');
await p.screenshot({ path: resolve('scripts/snap/hr-sidebar.png'), clip: { x: 0, y: 0, width: 260, height: 900 } });
console.log('hr-sidebar.png');
const labels = await p.$$eval('aside nav a', (as) => as.map((a) => a.textContent.trim()));
console.log('sidebar:', labels.join(' · '));
await browser.close();
