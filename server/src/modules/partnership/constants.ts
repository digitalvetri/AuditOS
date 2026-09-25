/** Shared by the module and its seed. */
import { CASE_STAGES, GST_STAGES, GST_TEMPLATE, LLP_STAGES, LLP_TEMPLATE, MASTER_TEMPLATE, PVT_STAGES, PVT_TEMPLATE, type TemplateCategorySeed } from './template.js'

export const PFR_SERVICE_CODE = 'PARTNERSHIP_FIRM_REGISTRATION'
export const PFR_DOC_CATEGORY_CODE = 'registration'
export const PFR_CODE_PREFIX = 'PFR'

/**
 * One case engine, two registration services. Everything that differs between
 * them lives here; the routes, tables and screens are shared.
 */
export const REGISTRATION_KINDS = ['PARTNERSHIP', 'LLP', 'GST', 'PRIVATE_LIMITED'] as const
export type RegistrationKind = (typeof REGISTRATION_KINDS)[number]

export interface KindConfig {
  label: string
  serviceCode: string
  serviceId: string
  codePrefix: string
  stages: readonly string[]
  template: TemplateCategorySeed[]
}

export const KINDS: Record<RegistrationKind, KindConfig> = {
  PARTNERSHIP: {
    label: 'Partnership Firm Registration',
    serviceCode: PFR_SERVICE_CODE,
    serviceId: 'svc-partnership-reg',
    codePrefix: PFR_CODE_PREFIX,
    stages: CASE_STAGES,
    template: MASTER_TEMPLATE,
  },
  LLP: {
    label: 'LLP Registration',
    serviceCode: 'LLP_REGISTRATION',
    serviceId: 'svc-llp-reg',
    codePrefix: 'LLP',
    stages: LLP_STAGES,
    template: LLP_TEMPLATE,
  },
  GST: {
    label: 'GST Registration',
    // The existing Services row (svc-gst-reg) — upserted by code, not duplicated.
    serviceCode: 'GST_REGISTRATION',
    serviceId: 'svc-gst-reg',
    codePrefix: 'GST',
    stages: GST_STAGES,
    template: GST_TEMPLATE,
  },
  PRIVATE_LIMITED: {
    label: 'Private Limited Incorporation',
    serviceCode: 'PVT_LTD_INCORPORATION',
    serviceId: 'svc-pvt-ltd-inc',
    codePrefix: 'PVT',
    stages: PVT_STAGES,
    template: PVT_TEMPLATE,
  },
}
