// Snap sidebar in expanded vs folded state after clicking the AUDIT header.
import puppeteer from 'puppeteer-core';
import { resolve } from 'node:path';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', args: ['--no-sandbox'],
  defaultViewport: { width: 1440, height: 900 },
});
const p = await browser.newPage();
await p.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
await p.evaluate(() => localStorage.clear());
await p.goto('http://localhost:5173/login', { waitUntil: 'networkidle0' });
await p.type('input[type="email"]', 'ravi@auditos.local');
await p.type('input[type="password"]', 'md');
await p.click('button[type="submit"]');
await p.waitForFunction(() => window.location.pathname === '/');
await p.waitForSelector('aside nav');
await new Promise(r => setTimeout(r, 800));
// Expanded state
await p.screenshot({ path: resolve('scripts/snap/fold-expanded.png'), clip: { x: 0, y: 0, width: 320, height: 900 } });
console.log('fold-expanded.png');
// Click AUDIT to collapse
await p.evaluate(() => {
  const btn = [...document.querySelectorAll('aside button')].find(b => b.textContent?.trim().startsWith('AUDIT'));
  btn?.click();
});
await new Promise(r => setTimeout(r, 400));
await p.screenshot({ path: resolve('scripts/snap/fold-audit-folded.png'), clip: { x: 0, y: 0, width: 320, height: 900 } });
console.log('fold-audit-folded.png');
await browser.close();
