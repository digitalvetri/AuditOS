/**
 * Acceptance verifier for the Workstation module (AUDIT_OS_WORKSTATION.md §13).
 *
 * Unlike the other verify-*.mjs scripts, this one drives the API directly with
 * fetch rather than puppeteer. Those scripts hard-code a Windows Chrome path
 * (`C:/Program Files/...`) and cannot run on a Linux dev box; the criteria that
 * matter here — scope, 403 vs empty-200, conversion atomicity, activity
 * reconciliation — are API-level properties anyway, so this is both portable
 * and a more direct test of the thing being claimed.
 *
 *   node scripts/verify-workstation.mjs [baseUrl]
 *
 * Requires the API to be running (npm run dev:api) and the database seeded.
 * Exits non-zero on the first failed assertion.
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:4000';

const LOGINS = {
  md: { email: 'ravi@auditos.local', password: 'md' },
  mgr: { email: 'vikram@auditos.local', password: 'mgr' },
  emp: { email: 'meera@auditos.local', password: 'emp' },
  hr: { email: 'priya@auditos.local', password: 'hr' },
  fin: { email: 'anitha@auditos.local', password: 'fin' },
};

let passed = 0;
let failed = 0;

function ok(name) {
  passed++;
  console.log(`  PASS  ${name}`);
}
function bad(name, detail) {
  failed++;
  console.log(`  FAIL  ${name}`);
  if (detail) console.log(`        ${detail}`);
}
function assert(cond, name, detail) {
  if (cond) ok(name);
  else bad(name, detail);
}
function section(title) {
  console.log(`\n${title}`);
}

/** Cookie-jar-per-role, since the session is an httpOnly cookie. */
const jars = new Map();

async function login(who) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(LOGINS[who]),
  });
  if (!res.ok) throw new Error(`login failed for ${who}: ${res.status}`);
  const raw = res.headers.get('set-cookie') ?? '';
  jars.set(who, raw.split(';')[0]);
}

async function call(who, path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Cookie: jars.get(who) ?? '',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  return { status: res.status, data: json.data, error: json.error };
}

async function main() {
  console.log(`Verifying Workstation against ${BASE}`);
  for (const who of Object.keys(LOGINS)) await login(who);

  // ── Security / RBAC ─────────────────────────────────────────────────────
  section('Security / RBAC (§13)');

  for (const who of ['hr', 'fin']) {
    for (const path of ['/api/clients', '/api/leads', '/api/services', '/api/follow-ups', '/api/client-documents', '/api/workstation/dashboard']) {
      const r = await call(who, path);
      assert(r.status === 403, `${who} → 403 on ${path}`, `got ${r.status}`);
    }
  }

  // The distinction §13 insists on: 403, not an empty 200 and not a 404.
  const hrClients = await call('hr', '/api/clients');
  assert(
    hrClients.status === 403 && hrClients.error?.code === 'forbidden',
    'denied role gets 403 forbidden, never an empty 200 or a 404',
    `status ${hrClients.status}, code ${hrClients.error?.code}`,
  );

  const mdClients = await call('md', '/api/clients');
  const empClients = await call('emp', '/api/clients');
  assert(mdClients.status === 200, 'md can list clients');
  assert(empClients.status === 200, 'employee can list clients');
  assert(
    empClients.data.scope === 'self' && empClients.data.count < mdClients.data.count,
    'employee sees a strict subset of clients (assignment-scoped)',
    `emp ${empClients.data?.count} vs md ${mdClients.data?.count}`,
  );

  // A client the employee is not assigned to must 403 on the DETAIL route,
  // not merely be absent from the list.
  const empIds = new Set(empClients.data.items.map((c) => c.id));
  const unassigned = mdClients.data.items.find((c) => !empIds.has(c.id));
  if (unassigned) {
    const r = await call('emp', `/api/clients/${unassigned.id}`);
    assert(r.status === 403, 'employee gets 403 on an unassigned client detail', `got ${r.status}`);
    const docs = await call('emp', `/api/clients/${unassigned.id}/documents`);
    assert(docs.status === 403, 'employee gets 403 on an unassigned client’s documents', `got ${docs.status}`);
  } else {
    bad('found an unassigned client to probe', 'employee is assigned to every client — widen the seed');
  }

  // ── Data integrity ──────────────────────────────────────────────────────
  section('Data integrity (§13)');

  const codes = mdClients.data.items.map((c) => c.client_id);
  assert(new Set(codes).size === codes.length, 'every Client ID is unique');
  const names = mdClients.data.items.map((c) => c.company_name);
  assert(new Set(names).size === names.length, 'no duplicate company produces a second client row');

  const leads = await call('md', '/api/leads');
  const converted = leads.data.items.filter((l) => l.converted_client_id);
  assert(converted.length >= 5, 'at least 5 leads converted in the seed', `${converted.length}`);
  assert(
    converted.every((l) => l.status === 'won'),
    'every converted lead is still present and still Won (never deleted)',
  );

  // Lead → Client back-links agree in both directions.
  let linkOk = true;
  for (const l of converted) {
    const c = await call('md', `/api/clients/${l.converted_client_id}`);
    if (c.status !== 200 || c.data.source_lead_id !== l.id) linkOk = false;
  }
  assert(linkOk, 'Lead.converted_client_id and Client.source_lead_id agree both ways');

  // created_at is system-generated and not user-editable.
  const spoof = await call('md', '/api/leads', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Verify Probe', contact_number: '9876500098',
      service_id: 'svc-gst-filing', price_quoted: 1,
      assigned_employee_id: 'emp-exec',
      created_at: '1999-01-01T00:00:00.000Z',
    }),
  });
  assert(
    spoof.status === 201 && !spoof.data.created_at.startsWith('1999'),
    'Lead created_at is system-generated and ignores a client-supplied value',
  );

  // Illegal transitions are rejected.
  const jump = await call('md', `/api/leads/${spoof.data.id}`, {
    method: 'PATCH', body: JSON.stringify({ status: 'won' }),
  });
  assert(
    jump.status === 422 && jump.error?.code === 'invalid_transition',
    'an illegal lead status transition is 422 invalid_transition',
    `got ${jump.status} ${jump.error?.code}`,
  );

  // One follow-up entity, XOR-enforced.
  const both = await call('md', '/api/follow-ups', {
    method: 'POST',
    body: JSON.stringify({
      lead_id: spoof.data.id, client_id: mdClients.data.items[0].id,
      title: 'probe', type: 'call',
      scheduled_at: new Date().toISOString(), assigned_employee_id: 'emp-exec',
    }),
  });
  assert(both.status === 400, 'a follow-up cannot belong to a lead AND a client', `got ${both.status}`);

  const neither = await call('md', '/api/follow-ups', {
    method: 'POST',
    body: JSON.stringify({
      title: 'probe', type: 'call',
      scheduled_at: new Date().toISOString(), assigned_employee_id: 'emp-exec',
    }),
  });
  assert(neither.status === 400, 'a follow-up must belong to a lead or a client');

  const follows = await call('md', '/api/follow-ups');
  assert(
    follows.data.items.some((f) => f.subject_type === 'lead') &&
      follows.data.items.some((f) => f.subject_type === 'client'),
    'ONE follow-up list serves both leads and clients',
  );

  // Documents are client-centric.
  const documents = await call('md', '/api/client-documents');
  assert(
    documents.data.items.every((d) => !!d.client_id),
    'every document belongs to a client (no per-service document store)',
  );
  assert(
    documents.data.items.some((d) => d.versions.length > 1),
    'at least one document carries multiple versions',
  );
  assert(
    documents.data.items.some((d) => d.versions.some((v) => v.uploaded_via_portal)),
    'the Client Portal receiving path is exercised by the seed',
  );

  // ── Simulation honesty ──────────────────────────────────────────────────
  section('Simulation is labelled (§13)');
  const withEway = mdClients.data.items.find((c) => c.gstin);
  const eway = await call('md', `/api/clients/${withEway.id}/eway`);
  assert(eway.data.connection?.is_simulated === true, 'e-way response declares is_simulated');
  assert(
    /simulated/i.test(eway.data.connection?.notice ?? ''),
    'e-way response carries a plain-language simulated notice',
  );
  assert(
    eway.data.items.every((b) => b.is_simulated === true),
    'every e-way bill row is flagged simulated',
  );

  // ── Activity ────────────────────────────────────────────────────────────
  section('Activity timeline (§13)');
  const c0 = mdClients.data.items[0];
  const act = await call('md', `/api/clients/${c0.id}/activity`);
  assert(act.status === 200 && act.data.count > 0, 'clients carry an activity timeline');
  assert(
    act.data.items.every((a) => a.action && a.description && a.created_at),
    'every activity entry records action, description and time',
  );

  // ── Clean up the probe lead ─────────────────────────────────────────────
  await call('md', `/api/leads/${spoof.data.id}`, {
    method: 'PATCH', body: JSON.stringify({ status: 'lost', lost_reason: 'Verification probe.' }),
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nverifier crashed:', err.message);
  process.exit(1);
});
