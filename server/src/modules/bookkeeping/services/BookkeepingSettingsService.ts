import { prisma } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { BookkeepingCompanyService } from './BookkeepingCompanyService.js'

/**
 * BookkeepingSettingsService — per-company configuration as key/JSON rows.
 *
 * Business rules the user should be able to change live here rather than
 * in code: whether negative stock is allowed, the default GST rate for a
 * new item, invoice print options, and so on. DEFAULTS below are the
 * documented shipped behaviour; a stored row overrides one.
 */

export const SETTING_GROUPS = {
  accounting: {
    allow_backdated_entry: true,
    require_narration: false,
    allow_negative_cash: false,
    bill_wise_accounting: true,
  },
  inventory: {
    maintain_inventory: true,
    allow_negative_stock: false,
    default_valuation_method: 'avg',
    track_godowns: true,
    track_batches: false,
  },
  gst: {
    gst_enabled: true,
    default_gst_rate_bp: 1800,
    round_off_invoices: true,
    require_hsn: true,
  },
  voucher: {
    auto_numbering: true,
    allow_voucher_delete: false,
    confirm_before_cancel: true,
  },
  invoice: {
    print_company_address: true,
    print_bank_details: true,
    terms_and_conditions: '',
    declaration: 'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.',
  },
  payroll: {
    pf_employee_pct_bp: 1200,
    pf_employer_pct_bp: 1200,
    esi_employee_pct_bp: 75,
    esi_employer_pct_bp: 325,
    professional_tax_monthly_paise: 0,
    payroll_enabled: true,
  },
  audit: {
    log_every_view: false,
    freeze_before_date: null as string | null,
  },
  security: {
    require_approval_above_paise: 0,
  },
} as const

export type SettingGroupKey = keyof typeof SETTING_GROUPS

export const BookkeepingSettingsService = {
  /** Every group, with stored overrides folded onto the defaults. */
  async getAll(session: Session, companyId: string) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const rows = await prisma.bookkeepingSetting.findMany({ where: { tallyCompanyId: companyId } })
    const stored = new Map(rows.map((r) => {
      let value: unknown
      try { value = JSON.parse(r.valueJson) } catch { value = null }
      return [r.key, value]
    }))
    const out: Record<string, Record<string, unknown>> = {}
    for (const [group, defaults] of Object.entries(SETTING_GROUPS)) {
      const override = stored.get(group)
      out[group] = { ...(defaults as Record<string, unknown>), ...(override && typeof override === 'object' ? override as Record<string, unknown> : {}) }
    }
    return out
  },

  /** Read one group — what the engine and the UI both call. */
  async get(companyId: string, group: SettingGroupKey): Promise<Record<string, unknown>> {
    const row = await prisma.bookkeepingSetting.findUnique({ where: { tallyCompanyId_key: { tallyCompanyId: companyId, key: group } } })
    let override: Record<string, unknown> = {}
    if (row) { try { override = JSON.parse(row.valueJson) as Record<string, unknown> } catch { override = {} } }
    return { ...(SETTING_GROUPS[group] as Record<string, unknown>), ...override }
  },

  async update(session: Session, companyId: string, group: string, patch: Record<string, unknown>) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    if (!(group in SETTING_GROUPS)) throw ApiError.badRequest(`Unknown settings group "${group}".`)
    const defaults = SETTING_GROUPS[group as SettingGroupKey] as Record<string, unknown>
    const unknownKeys = Object.keys(patch).filter((k) => !(k in defaults))
    if (unknownKeys.length) throw ApiError.badRequest(`Unknown setting(s): ${unknownKeys.join(', ')}.`)
    const current = await BookkeepingSettingsService.get(companyId, group as SettingGroupKey)
    const next = { ...current, ...patch }
    await prisma.bookkeepingSetting.upsert({
      where: { tallyCompanyId_key: { tallyCompanyId: companyId, key: group } },
      create: { tallyCompanyId: companyId, key: group, valueJson: JSON.stringify(next) },
      update: { valueJson: JSON.stringify(next) },
    })
    return { group, values: next }
  },
}
