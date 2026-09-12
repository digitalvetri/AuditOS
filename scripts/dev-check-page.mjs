/**
 * Drive Chrome via CDP, log in, hit /workstation/services/e-invoice, and
 * report console errors + a snapshot of the visible DOM. Used to diagnose
 * "blank page" bugs when the server side is 200 across the board.
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const WebSocket = require(path.resolve('server/node_modules/ws'))

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL_PAGE = process.argv[2] ?? 'http://localhost:5173/workstation/services/e-invoice'
const EMAIL = 'vikram@auditos.local'
const PASSWORD = 'mgr'

// ── boot Chrome with remote debugging ──────────────────────────────────────
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-debug-'))
const port = 19222
const proc = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' })

async function waitForDebugger() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const list = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
          let body = ''
          res.on('data', (c) => body += c)
          res.on('end', () => resolve(JSON.parse(body)))
        }).on('error', reject)
      })
      return list.webSocketDebuggerUrl
    } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  throw new Error('Chrome DevTools not ready')
}

const wsUrl = await waitForDebugger()
const browserWs = new WebSocket(wsUrl)
let msgId = 0
function send(ws, method, params) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    const onMsg = (raw) => {
      const msg = JSON.parse(raw)
      if (msg.id === id) {
        ws.off('message', onMsg)
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`))
        else resolve(msg.result)
      }
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
function on(ws, event, cb) {
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw)
    if (msg.method === event) cb(msg.params)
  })
}
await new Promise((r) => browserWs.on('open', r))

// Open a new tab.
const target = await send(browserWs, 'Target.createTarget', { url: 'about:blank' })
const attach = await send(browserWs, 'Target.attachToTarget', { targetId: target.targetId, flatten: true })
const sessionId = attach.sessionId
// We need to send messages targeted at the session — build a small wrapper.
function tabSend(method, params) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    const onMsg = (raw) => {
      const msg = JSON.parse(raw)
      if (msg.id === id && msg.sessionId === sessionId) {
        browserWs.off('message', onMsg)
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`))
        else resolve(msg.result)
      }
    }
    browserWs.on('message', onMsg)
    browserWs.send(JSON.stringify({ sessionId, id, method, params }))
  })
}
const tabEvents = new Map()
function tabOn(event, cb) {
  const list = tabEvents.get(event) ?? []
  list.push(cb); tabEvents.set(event, list)
}
browserWs.on('message', (raw) => {
  const msg = JSON.parse(raw)
  if (msg.sessionId !== sessionId || !msg.method) return
  const cbs = tabEvents.get(msg.method) ?? []
  for (const cb of cbs) cb(msg.params)
})

await tabSend('Runtime.enable')
await tabSend('Log.enable')
await tabSend('Network.enable')
await tabSend('Page.enable')

const consoleMessages = []
const exceptions = []
const failedRequests = []
tabOn('Runtime.consoleAPICalled', (p) => {
  const text = (p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')
  consoleMessages.push({ level: p.type, text })
})
tabOn('Network.requestWillBeSent', (p) => {
  if (p.request.url.startsWith('http://localhost:5173/src/main')) {
    consoleMessages.push({ level: 'req', text: `→ ${p.request.url}` })
  }
})
tabOn('Network.responseReceived', (p) => {
  if (p.response.url.startsWith('http://localhost:5173/src/main')) {
    consoleMessages.push({ level: 'res', text: `← ${p.response.url} : ${p.response.status}` })
  }
})
tabOn('Runtime.exceptionThrown', (p) => {
  const d = p.exceptionDetails
  exceptions.push({
    text: d.text,
    message: d.exception?.description ?? d.exception?.value,
    url: d.url, line: d.lineNumber, col: d.columnNumber,
    stack: (d.stackTrace?.callFrames ?? []).map((f) => `${f.functionName} @ ${f.url}:${f.lineNumber}`).join('\n'),
  })
})
tabOn('Network.loadingFailed', (p) => { failedRequests.push({ url: p.requestId, err: p.errorText }) })
tabOn('Log.entryAdded', (p) => {
  const e = p.entry
  if (e.level === 'error' || e.level === 'warning') {
    consoleMessages.push({ level: `log-${e.level}`, text: `${e.source}: ${e.text}` })
  }
})

// 1) Log in via the API — cookie will attach to same-origin fetches.
console.log('[step] logging in via API...')
await tabSend('Page.navigate', { url: 'http://localhost:5173/' })
await new Promise((r) => setTimeout(r, 1000))
await tabSend('Runtime.evaluate', {
  expression: `fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: '${EMAIL}', password: '${PASSWORD}' }),
  }).then(r => r.json())`,
  awaitPromise: true, returnByValue: true,
})

// 2) Navigate to the page.
console.log(`[step] navigating to ${URL_PAGE}`)
await tabSend('Page.navigate', { url: URL_PAGE })
await new Promise((r) => setTimeout(r, 5000)) // let react-query settle

// 3) Grab DOM snapshot + current URL.
const urlResult = await tabSend('Runtime.evaluate', {
  expression: 'location.href',
  returnByValue: true,
})
console.log('[step] current URL:', urlResult.result.value)
const domResult = await tabSend('Runtime.evaluate', {
  expression: `JSON.stringify({
    innerText: document.body?.innerText?.slice(0, 500) ?? '',
    rootHtmlLen: document.getElementById('root')?.innerHTML?.length ?? 0,
    rootHtml: document.getElementById('root')?.innerHTML?.slice(0, 1500) ?? '',
    bodyHtmlLen: document.body?.innerHTML?.length ?? 0,
  })`,
  returnByValue: true,
})

console.log('\n===== CONSOLE MESSAGES =====')
if (consoleMessages.length === 0) console.log('(none)')
for (const m of consoleMessages) console.log(`[${m.level}] ${m.text}`)

console.log('\n===== EXCEPTIONS =====')
if (exceptions.length === 0) console.log('(none)')
for (const e of exceptions) {
  console.log(`- ${e.message ?? e.text}`)
  if (e.stack) console.log(e.stack)
}

console.log('\n===== FAILED REQUESTS =====')
if (failedRequests.length === 0) console.log('(none)')
for (const r of failedRequests) console.log(`- ${r.err}`)

console.log('\n===== DOM (#root, first 4000 chars) =====')
console.log(domResult.result.value)

process.exit(0)
