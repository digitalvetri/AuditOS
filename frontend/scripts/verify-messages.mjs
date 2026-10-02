/**
 * End-to-end verify for Messages (§8.7).
 *
 * Discriminator probes (highest blast radius first):
 *   1. Membership: Meera POSTs to Management group (she's not in) → 403.
 *      Not empty 200, not 404.
 *   2. DM uniqueness: two POST /chats calls with the same DM pair return the
 *      SAME chat id (created:false on the second).
 *   3. Read receipt: Meera posts in a shared group → Vikram's unread=1,
 *      Meera's own unread=0. Vikram POST /read → his unread→0.
 *   4. Reply-to: POST with parent_id persists; GET returns the child with
 *      parent_preview populated.
 *   5. DM notification: DM to Meera creates a chat.dm_new notification.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = 'http://localhost:5173';
const SHOTS = resolve('scripts/shots');
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

const LOGINS = {
  md: { email: 'ravi@auditos.local', password: 'md' },
  hr: { email: 'priya@auditos.local', password: 'hr' },
  fin: { email: 'anitha@auditos.local', password: 'fin' },
  mgr: { email: 'vikram@auditos.local', password: 'mgr' },
  emp: { email: 'meera@auditos.local', password: 'emp' },
};

function log(msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }
async function shot(page, name) {
  const path = resolve(SHOTS, `msg-${name}.png`);
  await page.screenshot({ path });
  log(`  📸 msg-${name}.png`);
}
async function loginTo(page, who) {
  const { email, password } = LOGINS[who];
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle0', timeout: 15000 });
  await page.waitForSelector('input[type="email"]', { timeout: 5000 });
  await page.evaluate(() => {
    document.querySelector('input[type="email"]').value = '';
    document.querySelector('input[type="password"]').value = '';
  });
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.location.pathname === '/', { timeout: 15000 });
  await page.waitForSelector('aside nav a', { timeout: 5000 });
}
async function logoutViaUI(page) {
  await page.goto(APP, { waitUntil: 'networkidle0' });
  const trigger = await page.$('button[aria-haspopup="menu"]');
  if (!trigger) return;
  await trigger.click();
  await page.waitForSelector('div[role="menu"]', { timeout: 3000 });
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('button[role="menuitem"]'));
    const logout = items.find((b) => b.textContent.trim() === 'Log out');
    logout?.click();
  });
  await page.waitForSelector('input[type="email"]', { timeout: 5000 });
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1440, height: 900 },
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (err) => log(`  pageerror: ${err.message}`));

    // Fresh DB (v9).
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });

    // ── Meera opens Messages: sees the groups she's a member of ──────────
    log('Login as Employee (Meera) → /hrms/messages');
    await loginTo(page, 'emp');
    await page.goto(`${APP}/hrms/messages`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="chat-sidebar"]');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid^="chat-item-"]').length > 0,
      { timeout: 5000 },
    );
    const meeraChats = await page.$$eval('[data-testid^="chat-item-"]', (rs) =>
      rs.map((r) => r.getAttribute('data-testid').replace('chat-item-', '')),
    );
    log(`  Meera sees ${meeraChats.length} chats: ${meeraChats.join(', ')}`);
    // Meera (emp-exec, Ops dept) should be in: General, GST, Ops + her DM with Vikram.
    // She should NOT be in: Management, HR Team, Finance Team.
    for (const bad of ['chat-mgmt', 'chat-hr', 'chat-finance']) {
      if (meeraChats.includes(bad)) throw new Error(`Meera should not see ${bad}`);
    }
    for (const good of ['chat-general', 'chat-ops', 'chat-gst', 'chat-dm-meera-vikram']) {
      if (!meeraChats.includes(good)) throw new Error(`Meera missing ${good}`);
    }
    await shot(page, 'emp-messages');

    // ── Membership probe: Meera POSTs to Management (not a member) → 403 ─
    log('Meera POST /api/chats/chat-mgmt/messages → 403');
    const badPost = await page.evaluate(async () => {
      const r = await fetch('/api/chats/chat-mgmt/messages', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'hi from a non-member' }),
      });
      return r.status;
    });
    log(`  status: ${badPost}`);
    if (badPost !== 403) throw new Error(`Meera-to-Mgmt post expected 403, got ${badPost}`);

    // ── DM uniqueness probe ──────────────────────────────────────────────
    log('POST /api/chats with existing DM pair (Meera↔Vikram) — returns same chat, created:false');
    const dmDuplicate = await page.evaluate(async () => {
      const r = await fetch('/api/chats', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'dm', other_employee_id: 'emp-mgr' }),
      });
      return r.json();
    });
    log(`  chat id ${dmDuplicate.data.chat.id}, created ${dmDuplicate.data.created}`);
    if (dmDuplicate.data.created !== false)
      throw new Error(`expected created:false for existing DM pair`);
    if (dmDuplicate.data.chat.id !== 'chat-dm-meera-vikram')
      throw new Error(`expected same chat id chat-dm-meera-vikram, got ${dmDuplicate.data.chat.id}`);

    // ── Reply-to probe: Meera replies to a message in the Ops group ─────
    log('Meera replies to the newest message in chat-ops with parent_id');
    const opsMessages = await page.evaluate(async () => {
      const r = await fetch('/api/chats/chat-ops/messages', { credentials: 'include' });
      return r.json();
    });
    const parent = opsMessages.data.items[opsMessages.data.items.length - 1];
    const replyRes = await page.evaluate(async (parentId) => {
      const r = await fetch('/api/chats/chat-ops/messages', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'Sounds good.', parent_id: parentId }),
      });
      return r.json();
    }, parent.id);
    const childId = replyRes.data.message.id;
    log(`  child id ${childId}, parent_id in response: ${replyRes.data.message.parent_id}`);
    if (replyRes.data.message.parent_id !== parent.id) throw new Error('parent_id not stored');

    // Reload messages — child should have parent_preview populated.
    const reloaded = await page.evaluate(async () => {
      const r = await fetch('/api/chats/chat-ops/messages', { credentials: 'include' });
      return r.json();
    });
    const child = reloaded.data.items.find((m) => m.id === childId);
    log(`  parent_preview on GET: ${child?.parent_preview ? `"${child.parent_preview.body.slice(0, 40)}"` : 'missing'}`);
    if (!child?.parent_preview) throw new Error('parent_preview missing on GET');
    if (child.parent_preview.id !== parent.id) throw new Error('parent_preview id mismatch');

    // ── Read receipt probe ───────────────────────────────────────────────
    // Clean starting state: Meera reads everything, then asserts unread=0.
    // Then she posts a new message and asserts unread STAYS 0 — proves that
    // her own message doesn't count against her unread.
    log('Meera POST /read (all in chat-ops) → unread=0');
    await page.evaluate(async (id) => {
      await fetch('/api/chats/chat-ops/read', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_id: id }),
      });
    }, childId);
    const meeraChatsList = await page.evaluate(async () => {
      const r = await fetch('/api/chats', { credentials: 'include' });
      return r.json();
    });
    const meeraOps = meeraChatsList.data.items.find((c) => c.id === 'chat-ops');
    log(`  Meera chat-ops unread after /read: ${meeraOps?.unread}`);
    if (meeraOps?.unread !== 0) throw new Error(`Meera unread after /read expected 0, got ${meeraOps?.unread}`);

    log('Meera posts another message — her own message doesn\'t count against her unread');
    await page.evaluate(async () => {
      await fetch('/api/chats/chat-ops/messages', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'Confirming for Thursday.' }),
      });
    });
    const meeraChatsList2 = await page.evaluate(async () => {
      const r = await fetch('/api/chats', { credentials: 'include' });
      return r.json();
    });
    const meeraOps2 = meeraChatsList2.data.items.find((c) => c.id === 'chat-ops');
    log(`  Meera chat-ops unread after own post: ${meeraOps2?.unread}`);
    if (meeraOps2?.unread !== 0) throw new Error(`Meera (author) unread expected 0 after own post, got ${meeraOps2?.unread}`);

    log('Logout, login as Vikram — chat-ops shows unread ≥1 for the new message');
    await logoutViaUI(page);
    await loginTo(page, 'mgr');
    const vikramChats = await page.evaluate(async () => {
      const r = await fetch('/api/chats', { credentials: 'include' });
      return r.json();
    });
    const vikramOps = vikramChats.data.items.find((c) => c.id === 'chat-ops');
    log(`  Vikram chat-ops unread: ${vikramOps?.unread} (total_unread ${vikramChats.data.total_unread})`);
    if ((vikramOps?.unread ?? 0) < 1) throw new Error(`Vikram unread expected ≥1, got ${vikramOps?.unread}`);
    if ((vikramChats.data.total_unread ?? 0) < 1) throw new Error(`total_unread expected ≥1`);

    log('Vikram POST /read with the NEWEST message id → unread → 0');
    // Fetch the newest message id to mark up to it (inclusive semantics).
    const opsNewest = await page.evaluate(async () => {
      const r = await fetch('/api/chats/chat-ops/messages', { credentials: 'include' });
      const body = await r.json();
      const items = body.data.items;
      return items[items.length - 1]?.id;
    });
    const readRes = await page.evaluate(async (id) => {
      const r = await fetch('/api/chats/chat-ops/read', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_id: id }),
      });
      return r.json();
    }, opsNewest);
    log(`  marked read: ${readRes.data.marked}`);
    const vikramChatsAfter = await page.evaluate(async () => {
      const r = await fetch('/api/chats', { credentials: 'include' });
      return r.json();
    });
    const vikramOpsAfter = vikramChatsAfter.data.items.find((c) => c.id === 'chat-ops');
    log(`  Vikram chat-ops unread after read: ${vikramOpsAfter?.unread}`);
    if ((vikramOpsAfter?.unread ?? 99) !== 0)
      throw new Error(`unread expected 0 after read, got ${vikramOpsAfter?.unread}`);

    // ── DM notification probe ────────────────────────────────────────────
    log('Vikram sends Meera a DM → chat.dm_new notification for Meera');
    const dmSend = await page.evaluate(async () => {
      const r = await fetch('/api/chats/chat-dm-meera-vikram/messages', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'Quick question about the audit.' }),
      });
      return r.status;
    });
    log(`  DM send status: ${dmSend}`);
    if (dmSend !== 200) throw new Error(`DM send expected 200, got ${dmSend}`);

    await logoutViaUI(page);
    await loginTo(page, 'emp');
    const notifs = await page.evaluate(async () => {
      const r = await fetch('/api/notifications', { credentials: 'include' });
      return r.json();
    });
    const hasDMNotif = notifs.data.items.some((n) => n.type === 'chat.dm_new');
    log(`  Meera has chat.dm_new notification: ${hasDMNotif}`);
    if (!hasDMNotif) throw new Error('Meera missing chat.dm_new notification');

    // TopBar messages badge should show >0.
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="messages-badge"]');
    // Wait a beat for the query.
    await new Promise((r) => setTimeout(r, 800));
    const badgeText = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="messages-unread"]');
      return el ? el.textContent.trim() : '0';
    });
    log(`  TopBar messages badge: ${badgeText}`);
    if (badgeText === '0') throw new Error('TopBar messages badge expected >0');
    await shot(page, 'emp-with-unread');

    await browser.close();
    log('DONE — all messages checks passed');
    process.exit(0);
  } catch (e) {
    log(`FAIL: ${e.message}`);
    console.error(e.stack);
    await browser.close();
    process.exit(1);
  }
}

main();
