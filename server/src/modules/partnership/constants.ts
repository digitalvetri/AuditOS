/** Shared by the module and its seed. */
import { CASE_STAGES, LLP_STAGES, LLP_TEMPLATE, MASTER_TEMPLATE, type TemplateCategorySeed } from './template.js'

export const PFR_SERVICE_CODE = 'PARTNERSHIP_FIRM_REGISTRATION'
export const PFR_DOC_CATEGORY_CODE = 'registration'
export const PFR_CODE_PREFIX = 'PFR'

/**
 * One case engine, two registration services. Everything that differs between
 * them lives here; the routes, tables and screens are shared.
 */
export const REGISTRATION_KINDS = ['PARTNERSHIP', 'LLP'] as const
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
}
