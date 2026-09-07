import puppeteer from 'puppeteer-core';
import { resolve } from 'node:path';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = 'http://localhost:5173';
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1600, height: 1100, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.clear());
const c = await page.cookies(); if (c.length) await page.deleteCookie(...c);
await page.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
await page.type('input[type="email"]', 'ravi@auditos.local');
await page.type('input[type="password"]', 'md');
await page.click('button[type="submit"]');
await page.waitForFunction(() => window.location.pathname === '/');
await page.waitForSelector('aside nav a');
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: resolve('scripts/snap/big-md.png'), fullPage: false });
console.log('big-md.png');
await browser.close();
