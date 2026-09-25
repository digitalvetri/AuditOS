/** Shared by the module and its seed. */
import {
  CASE_STAGES, GST_STAGES, GST_TEMPLATE, GSTR1_STAGES, GSTR1_TEMPLATE,
  GSTR2B_STAGES, GSTR2B_TEMPLATE, GSTR3B_STAGES, GSTR3B_TEMPLATE,
  LLP_STAGES, LLP_TEMPLATE, MASTER_TEMPLATE, PVT_STAGES, PVT_TEMPLATE,
  type TemplateCategorySeed,
} from './template.js'

export const PFR_SERVICE_CODE = 'PARTNERSHIP_FIRM_REGISTRATION'
export const PFR_DOC_CATEGORY_CODE = 'registration'
export const PFR_CODE_PREFIX = 'PFR'

/**
 * One case engine, seven services. Everything that differs between them
 * lives here; the routes, tables and screens are shared.
 *   PARTNERSHIP · LLP · GST · PRIVATE_LIMITED — one-time registration cases
 *   GSTR1 · GSTR2B · GSTR3B — monthly return checklists (one case per
 *   client per period)
 */
export const REGISTRATION_KINDS = ['PARTNERSHIP', 'LLP', 'GST', 'GSTR1', 'GSTR2B', 'GSTR3B', 'PRIVATE_LIMITED'] as const
export type RegistrationKind = (typeof REGISTRATION_KINDS)[number]

export interface KindConfig {
  label: string
  serviceCode: string
  serviceId: string
  codePrefix: string
  stages: readonly string[]
  template: TemplateCategorySeed[]
  /**
   * Whether a client is enrolled in this kind as a sellable service. True for
   * the one-time registrations; false for the return kinds, which only exist
   * to hang a master checklist off — no per-period case flow yet as a
   * standalone service, so a Service row would leak into /api/service-catalog
   * and offer them for enrolment. When that flow lands, flip this and add
   * the Service upsert.
   */
  hasCaseFlow: boolean
}

export const KINDS: Record<RegistrationKind, KindConfig> = {
  PARTNERSHIP: {
    label: 'Partnership Firm Registration',
    serviceCode: PFR_SERVICE_CODE,
    serviceId: 'svc-partnership-reg',
    codePrefix: PFR_CODE_PREFIX,
    stages: CASE_STAGES,
    template: MASTER_TEMPLATE,
    hasCaseFlow: true,
  },
  LLP: {
    label: 'LLP Registration',
    serviceCode: 'LLP_REGISTRATION',
    serviceId: 'svc-llp-reg',
    codePrefix: 'LLP',
    stages: LLP_STAGES,
    template: LLP_TEMPLATE,
    hasCaseFlow: true,
  },
  GST: {
    label: 'GST Registration',
    serviceCode: 'GST_REGISTRATION',
    serviceId: 'svc-gst-reg',
    codePrefix: 'GST',
    stages: GST_STAGES,
    template: GST_TEMPLATE,
    hasCaseFlow: true,
  },
  PRIVATE_LIMITED: {
    label: 'Private Limited Incorporation',
    serviceCode: 'PVT_LTD_INCORPORATION',
    serviceId: 'svc-pvt-ltd-inc',
    codePrefix: 'PVT',
    stages: PVT_STAGES,
    template: PVT_TEMPLATE,
    hasCaseFlow: true,
  },
  GSTR1: {
    label: 'GSTR-1',
    serviceCode: 'GSTR1_RETURN',
    serviceId: 'svc-gstr1',
    codePrefix: 'GSTR1',
    stages: GSTR1_STAGES,
    template: GSTR1_TEMPLATE,
    hasCaseFlow: false,
  },
  GSTR2B: {
    label: 'IMS + GSTR-2B',
    serviceCode: 'GSTR2B_RETURN',
    serviceId: 'svc-gstr2b',
    codePrefix: 'GSTR2B',
    stages: GSTR2B_STAGES,
    template: GSTR2B_TEMPLATE,
    hasCaseFlow: false,
  },
  GSTR3B: {
    label: 'GSTR-3B',
    serviceCode: 'GSTR3B_RETURN',
    serviceId: 'svc-gstr3b',
    codePrefix: 'GSTR3B',
    stages: GSTR3B_STAGES,
    template: GSTR3B_TEMPLATE,
    hasCaseFlow: false,
  },
}
