import puppeteer from 'puppeteer-core';
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
await p.waitForSelector('aside');
await new Promise(r => setTimeout(r, 600));
const rects = await p.evaluate(() => {
  const brand = document.querySelector('aside > div');
  const topbar = document.querySelector('header');
  const br = brand.getBoundingClientRect();
  const tr = topbar.getBoundingClientRect();
  return {
    brand: { top: br.top, bottom: br.bottom, height: br.height, borderBottom: getComputedStyle(brand).borderBottomWidth },
    topbar: { top: tr.top, bottom: tr.bottom, height: tr.height, borderBottom: getComputedStyle(topbar).borderBottomWidth },
  };
});
console.log(JSON.stringify(rects, null, 2));
await browser.close();
