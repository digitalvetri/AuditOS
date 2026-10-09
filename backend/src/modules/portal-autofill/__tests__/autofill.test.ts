/**
 * Portal autofill — isolation and safety tests (spec §27).
 *
 * The launch token binds client + registration + portal; redemption returns
 * exactly that one credential, once, and only on the matching portal page.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'

vi.hoisted(() => {
  process.env.PORTAL_ACCESS_ENC_KEY = Buffer.alloc(32, 7).toString('base64')
})

import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { encryptPortalSecret } from '../../../platform/portalCrypto.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'
import { issueLaunchToken } from '../launchToken.js'

let server: Server
let base = ''
let mdCookie = ''
let empCookie = ''
let orgId = ''
let mdUserId = ''
let employeeId = ''

async function seedRole(code: keyof typeof MATRIX) {
  for (const g of MATRIX[code]) {
    await prisma.permission.upsert({ where: { code: g.permission }, update: {}, create: { id: `perm-${g.permission}`, code: g.permission, description: g.permission } })
  }
  const role = await prisma.role.upsert({ where: { code }, update: {}, create: { id: `role-${code}`, code, name: code } })
  await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
  for (const g of MATRIX[code]) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: `perm-${g.permission}`, scope: g.scope } }).catch(() => undefined)
  }
  return role
}

async function api(path: string, opts: { method?: string; body?: unknown; as?: string } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.as ? { Cookie: opts.as } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body: body?.data ?? body, raw: text }
}

async function client(name: string) {
  return prisma.client.create({
    data: { id: uid('cli'), organisationId: orgId, clientCode: uid('CLI'), companyName: name, contactPerson: 'C', contactNumber: '9840011111', accountManagerId: uid('emp'), onboardingDate: '2026-01-01' },
  })
}
async function saveCred(clientId: string, slug: string, username: string, password: string) {
  await prisma.registrationCredential.create({
    data: { clientId, typeCode: slug, mode: 'existing', fieldsJson: JSON.stringify({ username }), passwordCiphertext: encryptPortalSecret(password, slug) },
  })
}
async function saveGst(clientId: string, username: string, password: string) {
  const p = await prisma.gstProfile.create({ data: { id: uid('gp'), clientId, gstin: '33ABCDE1234F1Z5', assignedEmployeeId: employeeId } as any })
  await prisma.gstPortalAccess.create({ data: { id: uid('ga'), gstProfileId: p.id, portalUsername: username, portalPasswordCiphertext: encryptPortalSecret(password, 'portal_password') } as any })
}

/** Launch (as the CRM would) then redeem (as the extension would). */
async function launchAndRedeem(clientId: string, registrationId: string, opts: { as?: string; pageUrl?: string; tamper?: Partial<Record<'clientId' | 'registrationId' | 'portalId', string>> } = {}) {
  const l = await api('/api/portal-autofill/launch', { method: 'POST', as: opts.as ?? mdCookie, body: { client_id: clientId, registration_id: registrationId } })
  if (l.status !== 200) return { launch: l, redeem: null as any }
  // The official starting URL — a page on that portal's own domain.
  const pageUrl = opts.pageUrl ?? l.body.launch_url
  const redeem = await api('/api/extension/credentials/request', {
    method: 'POST',
    body: { launchToken: l.body.launch_token, clientId, registrationId, portalId: l.body.portal_id, pageUrl, ...(opts.tamper ?? {}) },
  })
  return { launch: l, redeem }
}

beforeAll(async () => {
  const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
  orgId = org.id
  // A GST profile needs an assigned employee.
  const dept = await prisma.department.create({ data: { id: uid('dep'), organisationId: org.id, code: uid('D'), name: 'General' } })
  const desg = await prisma.designation.create({ data: { id: uid('desg'), organisationId: org.id, name: 'Executive' } })
  const loc = await prisma.workLocation.create({ data: { id: uid('loc'), organisationId: org.id, name: 'HQ', latitude: 13, longitude: 80 } })
  const sched = await prisma.workSchedule.create({ data: { id: uid('sch'), organisationId: org.id, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })
  const emp0 = await prisma.employee.create({ data: { id: uid('emp'), organisationId: org.id, employeeCode: uid('EC'), firstName: 'A', lastName: 'B', fullName: 'A B', type: 'executive', status: 'active', designationId: desg.id, departmentId: dept.id, workLocationId: loc.id, workScheduleId: sched.id, email: `${uid('e')}@x.local`, joiningDate: '2026-01-01' } })
  employeeId = emp0.id
  const md = await seedRole('md')
  const emp = await seedRole('employee')
  const u = await prisma.user.create({ data: { id: uid('u'), organisationId: org.id, email: `${uid('e')}@x.local`, passwordHash: 'x', roleId: md.id } })
  mdUserId = u.id
  mdCookie = `ao_access=${signToken(u.id)}`
  const e = await prisma.user.create({ data: { id: uid('u'), organisationId: org.id, email: `${uid('e')}@x.local`, passwordHash: 'x', roleId: emp.id } })
  empCookie = `ao_access=${signToken(e.id)}`
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('portal autofill — isolation', () => {
  it('client isolation: Client A + GST and Client B + GST get their own credentials', async () => {
    const a = await client('Client A'); const b = await client('Client B')
    await saveGst(a.id, 'a-gst-user', 'a-gst-pass'); await saveGst(b.id, 'b-gst-user', 'b-gst-pass')
    const ra = await launchAndRedeem(a.id, 'GST_REGISTRATION')
    const rb = await launchAndRedeem(b.id, 'GST_REGISTRATION')
    expect(ra.redeem.status).toBe(200); expect(rb.redeem.status).toBe(200)
    expect(ra.redeem.body).toEqual({ username: 'a-gst-user', password: 'a-gst-pass' })
    expect(rb.redeem.body).toEqual({ username: 'b-gst-user', password: 'b-gst-pass' })
  })

  it('registration isolation: MCA Private Limited and MCA LLP are separate credentials', async () => {
    const a = await client('Client MCA')
    await saveCred(a.id, 'private-limited', 'pvt-user', 'pvt-pass'); await saveCred(a.id, 'llp', 'llp-user', 'llp-pass')
    const pvt = await launchAndRedeem(a.id, 'PRIVATE_LIMITED')
    const llp = await launchAndRedeem(a.id, 'LLP_REGISTRATION')
    expect(pvt.launch.body.portal_id).toBe('MCA'); expect(llp.launch.body.portal_id).toBe('MCA')
    expect(pvt.redeem.body).toEqual({ username: 'pvt-user', password: 'pvt-pass' })
    expect(llp.redeem.body).toEqual({ username: 'llp-user', password: 'llp-pass' })
  })

  it('a token for one registration cannot be redeemed as another (no LLP from a Private Limited token)', async () => {
    const a = await client('Client Swap')
    await saveCred(a.id, 'private-limited', 'pvt-user', 'pvt-pass'); await saveCred(a.id, 'llp', 'llp-user', 'llp-pass')
    const r = await launchAndRedeem(a.id, 'PRIVATE_LIMITED', { tamper: { registrationId: 'LLP_REGISTRATION' } })
    expect(r.redeem.status).toBe(403)
    expect(r.redeem.raw).not.toContain('llp-pass'); expect(r.redeem.raw).not.toContain('pvt-pass')
  })

  it('a token for Client A cannot be redeemed for Client B', async () => {
    const a = await client('A2'); const b = await client('B2')
    await saveGst(a.id, 'a', 'pa'); await saveGst(b.id, 'b', 'pb')
    const r = await launchAndRedeem(a.id, 'GST_REGISTRATION', { tamper: { clientId: b.id } })
    expect(r.redeem.status).toBe(403)
    expect(r.redeem.raw).not.toContain('pb')
  })

  it('portal mismatch: a GST context on the MCA page does not autofill', async () => {
    const a = await client('Mismatch')
    await saveGst(a.id, 'u', 'p')
    const r = await launchAndRedeem(a.id, 'GST_REGISTRATION', { pageUrl: 'https://www.mca.gov.in/' })
    expect(r.redeem.status).toBe(403)
    const lookalike = await launchAndRedeem(a.id, 'GST_REGISTRATION', { pageUrl: 'https://www.gst.gov.in.evil.example/' })
    expect(lookalike.redeem.status).toBe(403)
    const plainHttp = await launchAndRedeem(a.id, 'GST_REGISTRATION', { pageUrl: 'http://www.gst.gov.in/' })
    expect(plainHttp.redeem.status).toBe(403)
  })

  it('a token works once; a second redemption is refused', async () => {
    const a = await client('Once')
    await saveCred(a.id, 'pf', 'pf-user', 'pf-pass')
    const l = await api('/api/portal-autofill/launch', { method: 'POST', as: mdCookie, body: { client_id: a.id, registration_id: 'PF_EPFO' } })
    const req = { launchToken: l.body.launch_token, clientId: a.id, registrationId: 'PF_EPFO', portalId: 'EPFO', pageUrl: 'https://unifiedportal-emp.epfindia.gov.in/epfo/' }
    expect((await api('/api/extension/credentials/request', { method: 'POST', body: req })).status).toBe(200)
    const again = await api('/api/extension/credentials/request', { method: 'POST', body: req })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('token_used')
    expect(again.body.error.message).toMatch(/expired/i)
  })

  it('two parallel redemptions of one token: exactly one gets the credential', async () => {
    const a = await client('Race')
    await saveCred(a.id, 'pf', 'pf-race', 'pf-race-pass')
    const l = await api('/api/portal-autofill/launch', { method: 'POST', as: mdCookie, body: { client_id: a.id, registration_id: 'PF_EPFO' } })
    const req = { launchToken: l.body.launch_token, clientId: a.id, registrationId: 'PF_EPFO', portalId: 'EPFO', pageUrl: 'https://unifiedportal-emp.epfindia.gov.in/epfo/' }
    const results = await Promise.all(Array.from({ length: 4 }, () => api('/api/extension/credentials/request', { method: 'POST', body: req })))
    const statuses = results.map((r) => r.status).sort()
    expect(statuses).toEqual([200, 409, 409, 409])
    expect(results.filter((r) => r.raw.includes('pf-race-pass'))).toHaveLength(1)
    expect(await prisma.autofillTokenUse.count({ where: { jti: { startsWith: `${JSON.parse(Buffer.from(l.body.launch_token.split('.')[0], 'base64url').toString()).jti}:` } } })).toBe(1)
  })

  it('expired token: no credential', async () => {
    const a = await client('Expired')
    await saveCred(a.id, 'esi', 'esi-user', 'esi-pass')
    const { token } = issueLaunchToken({ uid: mdUserId, cid: a.id, rid: 'ESI_ESIC', pid: 'ESIC' }, Date.now() - 11 * 60 * 1000)
    const r = await api('/api/extension/credentials/request', { method: 'POST', body: { launchToken: token, clientId: a.id, registrationId: 'ESI_ESIC', portalId: 'ESIC', pageUrl: 'https://portal.esic.gov.in/EmployerPortal/ESICInsurancePortal/Portal_Loginnew.aspx' } })
    expect(r.status).toBe(403)
    expect(r.body.error.message).toMatch(/expired/i)
  })

  it('forged token: refused', async () => {
    const r = await api('/api/extension/credentials/request', { method: 'POST', body: { launchToken: 'eyJ2IjoxfQ.AAAA', clientId: 'x', registrationId: 'GST_REGISTRATION', portalId: 'GST', pageUrl: 'https://www.gst.gov.in/' } })
    expect(r.status).toBe(403)
  })

  it('unauthorised user: a role without the reveal permission cannot launch', async () => {
    const a = await client('Unauth')
    await saveCred(a.id, 'pf', 'u', 'p')
    const l = await api('/api/portal-autofill/launch', { method: 'POST', as: empCookie, body: { client_id: a.id, registration_id: 'PF_EPFO' } })
    expect(l.status).toBe(403)
  })

  it('E-Invoice context may redeem on the GST login page it redirects to (and still gets the E-Invoice login)', async () => {
    const a = await client('EInv')
    await saveGst(a.id, 'gst-user', 'gst-pass')
    await saveCred(a.id, 'e-invoice', 'einv-user', 'einv-pass')
    const r = await launchAndRedeem(a.id, 'E_INVOICE', { pageUrl: 'https://services.gst.gov.in/services/login?flag=einvoice' })
    expect(r.redeem.body).toEqual({ username: 'einv-user', password: 'einv-pass' })
  })

  it('UDYAM is password-less: returns the Udyam number and mobile only', async () => {
    const a = await client('Udyam')
    await prisma.registrationCredential.create({ data: { clientId: a.id, typeCode: 'msme-udyam', fieldsJson: JSON.stringify({ udyam_number: 'UDYAM-TN-00-1234567', signatory_mobile: '9840011111' }) } })
    const r = await launchAndRedeem(a.id, 'MSME_UDYAM', { pageUrl: 'https://udyamregistration.gov.in/Udyam_Login.aspx' })
    expect(r.redeem.body).toEqual({ username: 'UDYAM-TN-00-1234567', password: '', mobile: '9840011111' })
  })

  it('unknown registration and missing credential fail safely', async () => {
    const a = await client('Missing')
    expect((await api('/api/portal-autofill/launch', { method: 'POST', as: mdCookie, body: { client_id: a.id, registration_id: 'NOPE' } })).status).toBe(400)
    const r = await launchAndRedeem(a.id, 'E_WAY_BILL')
    expect(r.launch.body.credential_ready).toBe(false)
    expect(r.redeem.status).toBe(403)
    expect(r.redeem.body.error.message).toMatch(/No credential configured/)
  })

  it('GST New Registration page: hands over the saved first-time details (no password), once', async () => {
    const a = await client('New GST Applicant')
    const details = { applicant_type: 'Taxpayer', state: 'Tamil Nadu', district: 'Coimbatore', legal_name: 'NEW GST APPLICANT PVT LTD', pan: 'AABCN1234M', email: 'a@x.local', mobile: '9840011111' }
    await prisma.registrationCredential.create({ data: { clientId: a.id, typeCode: 'gst', mode: 'new', fieldsJson: JSON.stringify(details) } })
    const pageUrl = 'https://reg.gst.gov.in/registration/'
    const { redeem } = await launchAndRedeem(a.id, 'GST_REGISTRATION', { pageUrl })
    expect(redeem.status).toBe(200)
    expect(redeem.body).toEqual({ kind: 'gst_new_registration', details })
    expect(JSON.stringify(redeem.body)).not.toContain('password')
    // The same page on a client with nothing saved: refused, nothing filled.
    const b = await client('Nothing Saved')
    const none = await launchAndRedeem(b.id, 'GST_REGISTRATION', { pageUrl })
    expect(none.redeem.status).toBe(403)
    expect(none.redeem.body.error.message).toMatch(/No first-time registration details/)
    // The GST login page still gets the login, not the details.
    await prisma.registrationCredential.update({ where: { id: (await prisma.registrationCredential.findFirstOrThrow({ where: { clientId: a.id, typeCode: 'gst' } })).id }, data: { fieldsJson: JSON.stringify({ ...details, username: 'gstuser1' }), passwordCiphertext: encryptPortalSecret('gst-pass', 'registration.gst') } })
    const login = await launchAndRedeem(a.id, 'GST_REGISTRATION', { pageUrl: 'https://services.gst.gov.in/services/login' })
    expect(login.redeem.body).toEqual({ username: 'gstuser1', password: 'gst-pass' })
  })

  it('ESIC: the Insured Person page gets the Insured Person login, never the employer password', async () => {
    const a = await client('ESI Employer')
    await prisma.registrationCredential.create({ data: {
      clientId: a.id, typeCode: 'esi', mode: 'existing',
      fieldsJson: JSON.stringify({ username: 'LIN777', ip_user_id: 'IP-31-0001', ip_password: 'enc:' + encryptPortalSecret('ip-pass', 'x') }),
      passwordCiphertext: encryptPortalSecret('employer-pass', 'registration.esi'),
    } })
    const ipPage = 'https://portal.esic.gov.in/EmployeePortal/login.aspx'
    expect((await launchAndRedeem(a.id, 'ESI_ESIC', { pageUrl: ipPage })).redeem.body).toEqual({ username: 'IP-31-0001', password: 'ip-pass' })
    const employerPage = 'https://portal.esic.gov.in/EmployerPortal/ESICInsurancePortal/Portal_Loginnew.aspx'
    expect((await launchAndRedeem(a.id, 'ESI_ESIC', { pageUrl: employerPage })).redeem.body).toEqual({ username: 'LIN777', password: 'employer-pass' })
    // No Insured Person login saved: refused — the employer login is not used instead.
    const b = await client('ESI No IP')
    await saveCred(b.id, 'esi', 'LIN888', 'employer-only')
    const r = await launchAndRedeem(b.id, 'ESI_ESIC', { pageUrl: ipPage })
    expect(r.redeem.status).toBe(403)
    expect(JSON.stringify(r.redeem.body)).not.toContain('employer-only')
  })

  it('EPFO: the member portal gets the UAN login, the employer portal the employer login', async () => {
    const a = await client('PF Employer')
    await prisma.registrationCredential.create({ data: {
      clientId: a.id, typeCode: 'pf', fieldsJson: JSON.stringify({ username: 'EMPUSER1', uan: '100200300400', uan_password: 'enc:' + encryptPortalSecret('uan-pass', 'x') }),
      passwordCiphertext: encryptPortalSecret('employer-pf-pass', 'registration.pf'),
    } })
    const member = 'https://unifiedportal-mem.epfindia.gov.in/memberinterface/'
    expect((await launchAndRedeem(a.id, 'PF_EPFO', { pageUrl: member })).redeem.body).toEqual({ username: '100200300400', password: 'uan-pass' })
    expect((await launchAndRedeem(a.id, 'PF_EPFO', { pageUrl: 'https://unifiedportal-emp.epfindia.gov.in/epfo/' })).redeem.body).toEqual({ username: 'EMPUSER1', password: 'employer-pf-pass' })
    const b = await client('PF No UAN')
    await saveCred(b.id, 'pf', 'EMPUSER2', 'employer-only-pf')
    const r = await launchAndRedeem(b.id, 'PF_EPFO', { pageUrl: member })
    expect(r.redeem.status).toBe(403)
    expect(JSON.stringify(r.redeem.body)).not.toContain('employer-only-pf')
  })

  it('DGFT / IEC: one launch fills the login once AND the registration form once', async () => {
    const a = await client('IEC Applicant')
    await prisma.registrationCredential.create({ data: {
      clientId: a.id, typeCode: 'import-export-code', mode: 'new',
      fieldsJson: JSON.stringify({ register_as: 'IEC Applicant', first_name: 'Ravi', reg_email: 'r@x.local', reg_mobile: '9840011111', pincode: '641001', district: 'Coimbatore', state: 'Tamil Nadu', city: 'Coimbatore', username: 'iecuser' }),
      passwordCiphertext: encryptPortalSecret('iec-pass', 'registration.import-export-code'),
    } })
    const l = await api('/api/portal-autofill/launch', { method: 'POST', as: mdCookie, body: { client_id: a.id, registration_id: 'IEC_REGISTRATION' } })
    const req = (purpose?: string) => api('/api/extension/credentials/request', { method: 'POST', body: { launchToken: l.body.launch_token, clientId: a.id, registrationId: 'IEC_REGISTRATION', portalId: 'DGFT', pageUrl: 'https://www.dgft.gov.in/CP/', ...(purpose ? { purpose } : {}) } })
    expect((await req()).body).toEqual({ username: 'iecuser', password: 'iec-pass' })
    const reg = await req('registration')
    expect(reg.body).toEqual({ kind: 'iec_registration', details: { register_as: 'IEC Applicant', first_name: 'Ravi', last_name: '', email: 'r@x.local', mobile: '9840011111', pincode: '641001', district: 'Coimbatore', state: 'Tamil Nadu', city: 'Coimbatore' } })
    expect(JSON.stringify(reg.body)).not.toContain('iec-pass')
    // Each purpose once.
    expect((await req()).status).toBe(409)
    expect((await req('registration')).status).toBe(409)
  })

  it('Labour TN: login and the applicant registration form each fill once from one launch', async () => {
    const a = await client('Shop Owner')
    await prisma.registrationCredential.create({ data: {
      clientId: a.id, typeCode: 'shops-establishment', mode: 'new',
      fieldsJson: JSON.stringify({ username: 'shopuser', applicant_name: 'Ravi Kumar', dob: '1985-06-15', aadhaar: 'enc:' + encryptPortalSecret('999988887777', 'x'), id_proof: 'PAN', id_proof_number: 'AABCK1234M', state: 'Tamil Nadu', district: 'Chennai', reg_mobile: '9876543210', reg_email: 'a@x.local' }),
      passwordCiphertext: encryptPortalSecret('shop-pass', 'registration.shops-establishment'),
    } })
    const l = await api('/api/portal-autofill/launch', { method: 'POST', as: mdCookie, body: { client_id: a.id, registration_id: 'SHOPS_ESTABLISHMENT' } })
    const req = (pageUrl: string, purpose?: string) => api('/api/extension/credentials/request', { method: 'POST', body: { launchToken: l.body.launch_token, clientId: a.id, registrationId: 'SHOPS_ESTABLISHMENT', portalId: 'LABOUR_TN', pageUrl, ...(purpose ? { purpose } : {}) } })
    expect((await req('https://labour.tn.gov.in/services/users/login')).body).toEqual({ username: 'shopuser', password: 'shop-pass' })
    const reg = await req('https://labour.tn.gov.in/services/Applicants/applicantRegistration', 'registration')
    expect(reg.body.kind).toBe('labour_registration')
    expect(reg.body.details).toMatchObject({ name: 'Ravi Kumar', dob: '1985-06-15', aadhaar: '999988887777', id_proof: 'PAN', id_number: 'AABCK1234M', state: 'Tamil Nadu', district: 'Chennai', password: 'shop-pass' })
    expect((await req('https://labour.tn.gov.in/services/Applicants/applicantRegistration', 'registration')).status).toBe(409)
  })

  it('TNREGINET: login and the Sign Up form each fill once from one launch', async () => {
    const a = await client('Firm Partner')
    await prisma.registrationCredential.create({ data: {
      clientId: a.id, typeCode: 'partnership-firm', mode: 'new',
      fieldsJson: JSON.stringify({ username: 'firmuser', user_type: 'Citizen', security_answer: 'enc:' + encryptPortalSecret('Tommy', 'registration_partnership_firm_password_security_answer'), identification_type: 'PAN', identification_no: 'enc:' + encryptPortalSecret('ABCPM1234K', 'registration_partnership_firm_password_identification_no'), first_name: 'Suresh', dob: '1980-04-12', state: 'Tamil Nadu', district: 'Chennai', reg_email: 'a@x.local', reg_mobile: '9876543210' }),
      passwordCiphertext: encryptPortalSecret('firm pass@2026', 'registration.partnership-firm'),
    } })
    const l = await api('/api/portal-autofill/launch', { method: 'POST', as: mdCookie, body: { client_id: a.id, registration_id: 'PARTNERSHIP_FIRM' } })
    const req = (purpose?: string) => api('/api/extension/credentials/request', { method: 'POST', body: { launchToken: l.body.launch_token, clientId: a.id, registrationId: 'PARTNERSHIP_FIRM', portalId: 'TNREGINET', pageUrl: 'https://tnreginet.gov.in/portal/', ...(purpose ? { purpose } : {}) } })
    expect((await req()).body).toEqual({ username: 'firmuser', password: 'firm pass@2026' })
    const reg = await req('registration')
    expect(reg.body.kind).toBe('tnreginet_registration')
    expect(reg.body.details).toMatchObject({ username: 'firmuser', password: 'firm pass@2026', security_answer: 'Tommy', identification_no: 'ABCPM1234K', email: 'a@x.local', mobile: '9876543210', dob: '1980-04-12' })
    expect((await req('registration')).status).toBe(409)
  })

  it('Udyam: the registration page gets the Aadhaar and entrepreneur name; the login stays passwordless', async () => {
    const a = await client('Udyam Owner')
    await prisma.registrationCredential.create({ data: {
      clientId: a.id, typeCode: 'msme-udyam', mode: 'new',
      fieldsJson: JSON.stringify({ udyam_number: 'UDYAM-TN-00-0000009', signatory_mobile: '9876543210', entrepreneur_name: 'Suresh Menon', aadhaar: 'enc:' + encryptPortalSecret('999988887777', 'registration_msme_udyam_password_aadhaar') }),
    } })
    const l = await api('/api/portal-autofill/launch', { method: 'POST', as: mdCookie, body: { client_id: a.id, registration_id: 'MSME_UDYAM' } })
    const req = (pageUrl: string, purpose?: string) => api('/api/extension/credentials/request', { method: 'POST', body: { launchToken: l.body.launch_token, clientId: a.id, registrationId: 'MSME_UDYAM', portalId: 'UDYAM', pageUrl, ...(purpose ? { purpose } : {}) } })
    const login = await req('https://udyamregistration.gov.in/Udyam_Login.aspx')
    expect(login.body).toEqual({ username: 'UDYAM-TN-00-0000009', password: '', mobile: '9876543210' })
    const reg = await req('https://udyamregistration.gov.in/UdyamRegistration.aspx', 'registration')
    expect(reg.body).toEqual({ kind: 'udyam_registration', details: { aadhaar: '999988887777', entrepreneur_name: 'Suresh Menon' } })
  })

  it('ESIC: the sign-up pages get the employer and Insured Person sign-up details, never a password', async () => {
    const a = await client('ESIC Signup')
    await prisma.registrationCredential.create({ data: {
      clientId: a.id, typeCode: 'esi', mode: 'new',
      fieldsJson: JSON.stringify({ company_name: 'ABC', principal_employer_name: 'Suresh', state: 'Tamil Nadu', region: 'Chennai', signup_email: 'a@x.local', ip_insurance_number: '5100123456', ip_dob: '1990-01-31', ip_mobile: '9876543210', ip_password: 'enc:' + encryptPortalSecret('ip-pass', 'registration_esi_password_ip_password') }),
      passwordCiphertext: encryptPortalSecret('emp-pass', 'registration.esi'),
    } })
    const l = await api('/api/portal-autofill/launch', { method: 'POST', as: mdCookie, body: { client_id: a.id, registration_id: 'ESI_ESIC' } })
    const reg = await api('/api/extension/credentials/request', { method: 'POST', body: { launchToken: l.body.launch_token, clientId: a.id, registrationId: 'ESI_ESIC', portalId: 'ESIC', pageUrl: 'https://portal.esic.gov.in/EmployeePortal/SignUp.aspx', purpose: 'registration' } })
    expect(reg.body).toMatchObject({ kind: 'esi_registration', details: { company_name: 'ABC', region: 'Chennai', email: 'a@x.local', ip_number: '5100123456', ip_dob: '1990-01-31', ip_mobile: '9876543210' } })
    expect(JSON.stringify(reg.body)).not.toMatch(/ip-pass|emp-pass/)
  })

  it('E-Way Bill: the registration form gets the GSTIN, and the login still fills from the same launch', async () => {
    const a = await client('EWB Reg')
    await prisma.registrationCredential.create({ data: {
      clientId: a.id, typeCode: 'e-way-bill', mode: 'new', fieldsJson: JSON.stringify({ gstin: '33ABCDE1234F1Z5', username: 'ewbuser' }),
      passwordCiphertext: encryptPortalSecret('ewb-pass', 'registration.e-way-bill'),
    } })
    const l = await api('/api/portal-autofill/launch', { method: 'POST', as: mdCookie, body: { client_id: a.id, registration_id: 'E_WAY_BILL' } })
    const req = (pageUrl: string, purpose?: string) => api('/api/extension/credentials/request', { method: 'POST', body: { launchToken: l.body.launch_token, clientId: a.id, registrationId: 'E_WAY_BILL', portalId: 'EWAYBILL', pageUrl, ...(purpose ? { purpose } : {}) } })
    expect((await req('https://ewaybillgst.gov.in/Login.aspx')).body).toEqual({ username: 'ewbuser', password: 'ewb-pass' })
    expect((await req('https://ewaybillgst.gov.in/Account/EWBUserRegistration.aspx', 'registration')).body).toEqual({ kind: 'ewb_registration', details: { gstin: '33ABCDE1234F1Z5' } })
  })

  it('never puts a credential in the launch response or audit log', async () => {
    const a = await client('NoLeak')
    await saveCred(a.id, 'e-invoice', 'ei-user', 'ei-secret-pass')
    const r = await launchAndRedeem(a.id, 'E_INVOICE')
    expect(r.launch.raw).not.toContain('ei-secret-pass')
    expect(r.launch.body.launch_url).not.toMatch(/password|username|token/i)
    const logs = await prisma.auditLog.findMany({ where: { action: { startsWith: 'portal_autofill.' } } })
    for (const row of logs) {
      const s = JSON.stringify(row)
      expect(s).not.toContain('ei-secret-pass')
      expect(s).not.toContain(r.launch.body.launch_token)
    }
  })
})
