/**
 * Registration seed — the ten registrations, mirroring the frontend
 * catalogue at src/pages/workstation/registration/services.ts.
 *
 * The two must agree: the frontend keeps icons and long-form copy, the
 * server owns what EXISTS. Portal URLs are the exact destinations the firm
 * uses — several are deep links to the form itself, not a site root, and
 * must not be tidied back to bare domains.
 *
 * Idempotent: upsert by code, so `docker compose up` re-running the seed
 * neither duplicates types nor resets a live registration.
 */
import type { PrismaClient } from '@prisma/client'

const TYPES = [
  { code: 'gst', name: 'GST Registration', shortName: 'GST', kind: 'tax',
    authority: 'CGST Act, 2017', form: 'REG-01 → GSTIN', portalScope: 'india',
    portalUrl: 'https://www.gst.gov.in/', portalLabel: 'GST Portal · Government of India',
    outputDocument: 'GST Registration Certificate (REG-06)', renewalMonths: null },
  { code: 'private-limited', name: 'Private Limited Company Registration', shortName: 'Private Limited',
    kind: 'entity', authority: 'MCA · Companies Act, 2013', form: 'SPICe+ → CoI', portalScope: 'india',
    portalUrl: 'https://www.mca.gov.in/content/mca/global/en/home.html',
    portalLabel: 'MCA Portal · Ministry of Corporate Affairs',
    outputDocument: 'Certificate of Incorporation (with PAN and TAN)', renewalMonths: null },
  { code: 'llp', name: 'LLP Registration', shortName: 'LLP', kind: 'entity',
    authority: 'MCA · LLP Act, 2008', form: 'FiLLiP → CoI', portalScope: 'india',
    portalUrl: 'https://www.mca.gov.in', portalLabel: 'MCA Portal · Ministry of Corporate Affairs',
    outputDocument: 'LLP Certificate of Incorporation', renewalMonths: null },
  { code: 'partnership-firm', name: 'Partnership Firm Registration', shortName: 'Partnership',
    kind: 'entity', authority: 'Registrar of Firms · Partnership Act, 1932', form: 'Form A → Certificate',
    portalScope: 'tamil-nadu', portalUrl: 'https://tnreginet.gov.in/portal/',
    portalLabel: 'TNREGINET · Inspector General of Registration, Tamil Nadu',
    outputDocument: 'Certificate of Registration of Firm', renewalMonths: null },
  { code: 'proprietorship', name: 'Proprietorship Registration', shortName: 'Proprietorship',
    kind: 'entity', authority: 'No separate statute', form: 'Via GST / UDYAM / bank',
    portalScope: 'india', portalUrl: 'https://www.gst.gov.in/',
    portalLabel: 'GST Portal · Government of India (no proprietorship registry exists)',
    outputDocument: 'GST certificate / UDYAM certificate / bank proof', renewalMonths: null },
  { code: 'msme-udyam', name: 'MSME UDYAM Registration', shortName: 'MSME UDYAM', kind: 'licence',
    authority: 'Ministry of MSME', form: 'UDYAM certificate', portalScope: 'india',
    portalUrl: 'https://www.udyamregistration.gov.in/UdyamRegistration.aspx',
    portalLabel: 'UDYAM Registration · Ministry of MSME',
    outputDocument: 'UDYAM Registration Certificate', renewalMonths: null },
  { code: 'shops-establishment', name: 'Shops and Establishment Registration', shortName: 'Shops & Estab.',
    kind: 'licence', authority: 'State Labour Department', form: 'State licence', portalScope: 'tamil-nadu',
    portalUrl: 'https://labour.tn.gov.in/services/shop-establishments/registration',
    portalLabel: 'Labour Department · Government of Tamil Nadu',
    outputDocument: 'Shops and Establishment Registration Certificate',
    /* Per premises and renewed on the state's own cycle — annual in TN. */
    renewalMonths: 12 },
  { code: 'import-export-code', name: 'Import Export Code Registration', shortName: 'IEC',
    kind: 'licence', authority: 'DGFT · Ministry of Commerce', form: 'ANF-2A → IEC',
    portalScope: 'india', portalUrl: 'https://www.dgft.gov.in/CP/',
    portalLabel: 'DGFT · Ministry of Commerce and Industry', outputDocument: 'IEC Certificate',
    /* Since 2021 an IEC must be confirmed every year between April and June
       or it is deactivated — the one hard annual deadline in this list. */
    renewalMonths: 12 },
  { code: 'pf', name: 'PF Registration', shortName: 'PF', kind: 'labour',
    authority: 'EPFO · EPF Act, 1952', form: 'Shram Suvidha → Code', portalScope: 'india',
    portalUrl: 'https://www.epfindia.gov.in', portalLabel: 'EPFO · Ministry of Labour & Employment',
    outputDocument: 'PF Establishment Code / Registration Certificate', renewalMonths: null },
  { code: 'esi', name: 'ESI Registration', shortName: 'ESI', kind: 'labour',
    authority: 'ESIC · ESI Act, 1948', form: 'Form 01 → Code', portalScope: 'india',
    portalUrl: 'https://esic.gov.in/', portalLabel: 'ESIC · Ministry of Labour & Employment',
    outputDocument: 'ESI Registration Certificate (Form C-11)', renewalMonths: null },
]

export async function seedRegistration(prisma: PrismaClient, organisationId: string) {
  for (const [i, t] of TYPES.entries()) {
    const data = { ...t, organisationId, sortOrder: i + 1, isActive: true }
    await prisma.registrationType.upsert({
      where: { code: t.code },
      create: data,
      // Update the catalogue facts, never the sort position of a type an
      // operator may have reordered by hand.
      update: { ...data, sortOrder: undefined },
    })
  }
  return { registrationTypes: await prisma.registrationType.count() }
}
