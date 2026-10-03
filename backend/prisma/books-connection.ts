/**
 * Zoho Books connections — DEVELOPER ONLY. The app has no screen for adding
 * a connection; users only switch between the ones configured here.
 *
 *   npm run books:connection -- list
 *   npm run books:connection -- add
 *   npm run books:connection -- rename "<current name>" "<new name>"
 *   npm run books:connection -- remove "<name>"
 *
 * `add` reads these from the environment, or asks for them (secrets are not
 * echoed). Never pass secrets as command-line arguments — they end up in
 * shell history and `ps`.
 *
 *   BOOKS_CONN_NAME           e.g. "Testing Account"
 *   BOOKS_CONN_METHOD         SERVER_OAUTH | SELF_CLIENT
 *   BOOKS_CONN_CLIENT_ID      the Zoho API console client id
 *   BOOKS_CONN_CLIENT_SECRET
 *   BOOKS_CONN_REFRESH_TOKEN  or BOOKS_CONN_CODE (a fresh 1000.… grant code)
 *   BOOKS_CONN_DC             in | com | eu | com.au | jp | ca | sa | uk   (default in)
 *   BOOKS_CONN_ORG_IDS        Zoho organization_ids to turn on, comma-separated (default: all)
 *
 * In Docker:  docker compose run --rm migrate npm run books:connection -- add
 */
import '../src/lib/env.js'
import readline from 'node:readline'
import { PrismaClient } from '@prisma/client'
import { addConfiguredConnection, disconnect, type AuthMethod } from '../src/modules/books/connection.js'

const prisma = new PrismaClient()

const DC: Record<string, string> = {
  in: 'https://accounts.zoho.in', com: 'https://accounts.zoho.com', eu: 'https://accounts.zoho.eu', 'com.au': 'https://accounts.zoho.com.au',
  jp: 'https://accounts.zoho.jp', ca: 'https://accounts.zohocloud.ca', sa: 'https://accounts.zoho.sa', uk: 'https://accounts.zoho.uk',
}

function ask(question: string, secret = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  if (secret) {
    // Hide what is typed: write the prompt once, swallow the echo.
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream }
    out._writeToOutput = (s: string) => { if (s.includes(question)) out.output.write(s) }
  }
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); if (secret) process.stdout.write('\n'); resolve(a.trim()) }))
}
const val = async (env: string, question: string, secret = false) => process.env[env]?.trim() || ask(question, secret)

async function firm(): Promise<string> {
  const orgs = await prisma.organisation.findMany({ select: { id: true, name: true } })
  if (orgs.length === 1) return orgs[0].id
  const pick = process.env.BOOKS_CONN_FIRM_ID ?? await ask(`Firm id (${orgs.map((o) => `${o.id} = ${o.name}`).join(', ')}): `)
  if (!orgs.some((o) => o.id === pick)) throw new Error('Unknown firm id.')
  return pick
}

async function list() {
  const conns = await prisma.booksZohoConnection.findMany({ where: { deletedAt: null, status: { not: 'disconnected' } }, include: { organizations: true }, orderBy: { createdAt: 'asc' } })
  if (!conns.length) return console.log('No Zoho Books connections.')
  for (const c of conns) {
    console.log(`${c.name ?? '(unnamed)'} · ${c.authMethod ?? 'method not recorded'} · ${c.status} · own client: ${c.clientId ? 'yes' : 'no (server-wide ZBOOKS_CLIENT_ID)'} · ${c.accountsServer ?? ''}`)
    for (const o of c.organizations) console.log(`    ${o.isActive ? '●' : '○'} ${o.name}  (organization_id ${o.zohoOrgId})`)
  }
}

async function add() {
  const organisationId = await firm()
  const name = await val('BOOKS_CONN_NAME', 'Connection name (e.g. Testing Account): ')
  const method = (await val('BOOKS_CONN_METHOD', 'Method — SERVER_OAUTH or SELF_CLIENT: ')).toUpperCase()
  if (method !== 'SERVER_OAUTH' && method !== 'SELF_CLIENT') throw new Error('Method must be SERVER_OAUTH or SELF_CLIENT.')
  const clientId = await val('BOOKS_CONN_CLIENT_ID', 'Zoho Client ID: ')
  const clientSecret = await val('BOOKS_CONN_CLIENT_SECRET', 'Zoho Client Secret (hidden): ', true)
  let refreshToken = process.env.BOOKS_CONN_REFRESH_TOKEN?.trim() ?? ''
  let code = process.env.BOOKS_CONN_CODE?.trim() ?? ''
  if (!refreshToken && !code) {
    const r = await ask('Refresh token, or a fresh grant code starting 1000. (hidden): ', true)
    if (/^1000\.[0-9a-f]{32}\.[0-9a-f]{32}$/i.test(r) && r.length < 80) code = r
    else refreshToken = r
  }
  const dcKey = (process.env.BOOKS_CONN_DC ?? 'in').trim().toLowerCase()
  const accountsServer = DC[dcKey]
  if (!accountsServer) throw new Error(`Unknown data centre "${dcKey}". Use one of ${Object.keys(DC).join(', ')}.`)
  const ids = process.env.BOOKS_CONN_ORG_IDS?.split(',').map((s) => s.trim()).filter(Boolean)
  if (!name || !clientId || !clientSecret || (!refreshToken && !code)) throw new Error('Name, client id, client secret and a refresh token / code are all required.')

  const r = await addConfiguredConnection({
    organisationId, name, authMethod: method as AuthMethod, clientId, clientSecret, accountsServer,
    ...(refreshToken ? { refreshToken } : { code }), activate: ids?.length ? ids : 'all',
  })
  console.log(`Added "${name}" (${method}). Organisations it can see:`)
  for (const o of r.organizations) console.log(`    ${o.isActive ? '● on ' : '○ off'}  ${o.name}  (organization_id ${o.zohoOrgId})`)
}

async function rename(from: string, to: string) {
  const c = await prisma.booksZohoConnection.findFirst({ where: { name: from, deletedAt: null } })
  if (!c) throw new Error(`No connection named "${from}".`)
  await prisma.booksZohoConnection.update({ where: { id: c.id }, data: { name: to } })
  console.log(`Renamed "${from}" → "${to}".`)
}

async function remove(name: string) {
  const c = await prisma.booksZohoConnection.findFirst({ where: { name, deletedAt: null } })
  if (!c) throw new Error(`No connection named "${name}".`)
  // Revokes at Zoho, wipes the tokens, turns its organisations off. History stays.
  await disconnect({ organisationId: c.organisationId, connectionId: c.id, userId: 'developer' })
  console.log(`Removed "${name}". Its organisations are switched off; their sync history is kept.`)
}

const [cmd, a, b] = process.argv.slice(2)
const run = cmd === 'list' ? list() : cmd === 'add' ? add() : cmd === 'rename' && a && b ? rename(a, b) : cmd === 'remove' && a ? remove(a)
  : Promise.reject(new Error('Usage: books:connection -- list | add | rename "<from>" "<to>" | remove "<name>"'))
run.catch((e) => { console.error(`✗ ${e instanceof Error ? e.message : e}`); process.exitCode = 1 }).finally(() => prisma.$disconnect())
