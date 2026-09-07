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
await new Promise(r => setTimeout(r, 800));
const info = await p.evaluate(() => {
  const aside = document.querySelector('aside');
  const cs = getComputedStyle(aside);
  const nav = aside.querySelector('nav');
  const csNav = getComputedStyle(nav);
  const firstLink = aside.querySelector('nav a');
  const csLink = firstLink ? getComputedStyle(firstLink) : null;
  return {
    asideBg: cs.backgroundColor,
    asideColor: cs.color,
    asideClassName: aside.className,
    navBg: csNav.backgroundColor,
    linkColor: csLink?.color,
    linkClassName: firstLink?.className,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
