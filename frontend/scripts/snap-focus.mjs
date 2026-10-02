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
async function login(page, email, password) {
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  const c = await page.cookies(); if (c.length) await page.deleteCookie(...c);
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.location.pathname === '/');
  await page.waitForSelector('aside nav a');
  await new Promise((r) => setTimeout(r, 800));
}
const md = await browser.newPage();
await login(md, 'ravi@auditos.local', 'md');
// Full dashboard shot
await md.screenshot({ path: resolve('scripts/snap/full-dashboard.png'), fullPage: false });
console.log('full-dashboard.png');
// Sidebar-only crop (clip to left ~260px)
await md.screenshot({ path: resolve('scripts/snap/sidebar-only.png'), clip: { x: 0, y: 0, width: 260, height: 900 } });
console.log('sidebar-only.png');
// TopBar-only crop (top 80px, exclude left sidebar)
await md.screenshot({ path: resolve('scripts/snap/topbar-only.png'), clip: { x: 246, y: 0, width: 1440 - 246, height: 80 } });
console.log('topbar-only.png');
await browser.close();
