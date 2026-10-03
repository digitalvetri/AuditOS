// Unit tests for the extension's context rules (node --test --experimental-strip-types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, launchUrlAllowed } from '../src/security/context-validator';
import type { LaunchContext } from '../src/types';

const base: LaunchContext = {
  launchToken: 't', clientId: 'A', clientName: 'Client A', clientCode: 'CLI-A',
  registrationId: 'PRIVATE_LIMITED', registrationName: 'Private Limited', portalId: 'MCA', portalName: 'MCA Portal',
  status: 'PARTIAL', crmOrigin: 'http://localhost:5173',
  expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'ready',
};

test('no context → none', () => assert.equal(evaluate(null, 'https://www.mca.gov.in/').kind, 'none'));
test('MCA context on an MCA page → ready, and it responds once the login form appears', () => {
  const s = evaluate(base, 'https://www.mca.gov.in/content/mca/global/en/home.html');
  assert.equal(s.kind, 'ready');
  assert.equal(s.kind === 'ready' && s.autoFill, true);
  assert.equal(s.kind === 'ready' && 'launchToken' in s.ctx, false); // token never leaves the worker
});
test('GST context on the MCA page → mismatch (portal isolation)', () => {
  const gst = { ...base, registrationId: 'GST_REGISTRATION', portalId: 'GST', portalName: 'GST Portal' };
  assert.equal(evaluate(gst, 'https://www.mca.gov.in/').kind, 'mismatch');
});
test('registration must belong to the portal (no LLP on a GST portal id)', () => {
  assert.equal(evaluate({ ...base, portalId: 'GST', registrationId: 'LLP_REGISTRATION' }, 'https://www.gst.gov.in/').kind, 'mismatch');
});
test('lookalike domain is refused', () => assert.equal(evaluate(base, 'https://mca.gov.in.evil.example/').kind, 'mismatch'));
test('http (not https) is refused for real portals', () => assert.equal(evaluate(base, 'http://www.mca.gov.in/').kind, 'mismatch'));
test('expired context → expired (no autofill)', () => {
  assert.equal(evaluate({ ...base, expiresAt: new Date(Date.now() - 1000).toISOString() }, 'https://www.mca.gov.in/').kind, 'expired');
});
test('used context → used (single fill per launch)', () => assert.equal(evaluate({ ...base, state: 'filled' }, 'https://www.mca.gov.in/').kind, 'used'));
test('E-Invoice context may fill on the GST login page it redirects to; GST context stays separate', () => {
  const ei = { ...base, registrationId: 'E_INVOICE', portalId: 'EINVOICE', portalName: 'E-Invoice Portal' };
  assert.equal(evaluate(ei, 'https://services.gst.gov.in/services/login?flag=einvoice').kind, 'ready');
  assert.equal(evaluate(ei, 'https://www.mca.gov.in/').kind, 'mismatch');
});
test('EPFO employer login domain (epfindia.gov.in) is allowed for PF only', () => {
  const pf = { ...base, registrationId: 'PF_EPFO', portalId: 'EPFO', portalName: 'EPFO' };
  assert.equal(evaluate(pf, 'https://unifiedportal-emp.epfindia.gov.in/epfo/').kind, 'ready');
  assert.equal(evaluate({ ...base, registrationId: 'ESI_ESIC', portalId: 'ESIC', portalName: 'ESIC' }, 'https://unifiedportal-emp.epfindia.gov.in/epfo/').kind, 'mismatch');
});
test('launch URL must be a registry starting URL', () => {
  assert.equal(launchUrlAllowed('https://www.gst.gov.in/', 'GST'), 'https://www.gst.gov.in/');
  assert.equal(launchUrlAllowed('https://phish.example/', 'GST'), null);
  assert.equal(launchUrlAllowed('https://www.gst.gov.in/', 'MCA'), null);
});
