import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { TallyCompanyService } from './TallyCompanyService.js'
import { TallyBootstrapService } from './TallyBootstrapService.js'
import { postVoucher } from '../engine/posting.js'
import { ledgerBalances, trialBalance } from '../engine/balances.js'
import { formatPaise } from '../engine/primitives.js'

/**
 * TallyDataService — import, export, backup and restore.
 *
 * IMPORT IS TWO-PHASE. Phase 1 validates every row and reports what would
 * happen; phase 2 commits, in one transaction per entity type. A file with
 * a bad row imports NOTHING unless the caller explicitly asks to skip the
 * invalid rows — so a failed import can never leave the books half-written.
 *
 * RESTORE never silently overwrites: it creates a new company unless the
 * caller passes an explicit confirmation to replace an existing one.
 */

export type ImportEntity = 'groups' | 'ledgers' | 'stock_items' | 'vouchers' | 'opening_balances'

export interface ImportIssue { row: number; field?: string; message: string; severity: 'error' | 'warning' }
export interface ImportPreview {
  entity: ImportEntity
  total_rows: number
  valid_rows: number
  invalid_rows: number
  duplicate_rows: number
  issues: ImportIssue[]
  sample: unknown[]
}

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export const TallyDataService = {
  /** Phase 1 — validate without writing anything. */
  async validateImport(session: Session, companyId: string, entity: ImportEntity, rows: Record<string, unknown>[]): Promise<ImportPreview> {
    await TallyCompanyService.requireOwned(session, companyId)
    const issues: ImportIssue[] = []
    let duplicates = 0
    const invalid = new Set<number>()

    const err = (row: number, message: string, field?: string) => { issues.push({ row, message, field, severity: 'error' }); invalid.add(row) }
    const warn = (row: number, message: string, field?: string) => issues.push({ row, message, field, severity: 'warning' })

    if (entity === 'groups' || entity === 'ledgers' || entity === 'stock_items') {
      const existingNames = new Set(
        entity === 'groups'
          ? (await prisma.tallyGroup.findMany({ where: { tallyCompanyId: companyId, ...alive }, select: { name: true } })).map((r) => r.name.toLowerCase())
          : entity === 'ledgers'
            ? (await prisma.tallyLedger.findMany({ where: { tallyCompanyId: companyId, ...alive }, select: { name: true } })).map((r) => r.name.toLowerCase())
            : (await prisma.tallyStockItem.findMany({ where: { tallyCompanyId: companyId, ...alive }, select: { name: true } })).map((r) => r.name.toLowerCase()),
      )
      const seen = new Set<string>()
      const groupNames = new Map(
        (await prisma.tallyGroup.findMany({ where: { tallyCompanyId: companyId, ...alive }, select: { id: true, name: true } }))
          .map((g) => [g.name.toLowerCase(), g.id]),
      )
      rows.forEach((r, i) => {
        const n = String(r.name ?? '').trim()
        if (!n) { err(i, 'Name is required.', 'name'); return }
        const key = n.toLowerCase()
        if (existingNames.has(key) || seen.has(key)) { duplicates++; warn(i, `"${n}" already exists — it will be skipped.`, 'name') }
        seen.add(key)
        if (entity === 'ledgers') {
          const under = String(r.under ?? r.group ?? '').trim()
          if (!under) err(i, 'Under-group is required.', 'under')
          else if (!groupNames.has(under.toLowerCase())) err(i, `No group named "${under}" in this company.`, 'under')
          const gstin = String(r.gstin ?? '').trim()
          if (gstin && !GSTIN_RE.test(gstin)) err(i, `"${gstin}" is not a valid GSTIN.`, 'gstin')
          const pan = String(r.pan ?? '').trim()
          if (pan && !PAN_RE.test(pan)) err(i, `"${pan}" is not a valid PAN.`, 'pan')
          const ob = r.opening_balance
          if (ob !== undefined && ob !== '' && !Number.isFinite(Number(ob))) err(i, 'Opening balance is not a number.', 'opening_balance')
          const dc = String(r.dr_cr ?? 'dr').toLowerCase()
          if (!['dr', 'cr'].includes(dc)) err(i, 'Dr/Cr must be dr or cr.', 'dr_cr')
        }
        if (entity === 'groups') {
          const nature = String(r.nature ?? '').trim().toLowerCase()
          const parent = String(r.under ?? r.parent ?? '').trim()
          if (!parent && !['assets', 'liabilities', 'income', 'expenses'].includes(nature)) {
            err(i, 'Either an under-group or a nature (assets/liabilities/income/expenses) is required.', 'nature')
          }
          if (parent && !groupNames.has(parent.toLowerCase())) err(i, `No group named "${parent}".`, 'under')
        }
        if (entity === 'stock_items') {
          const rate = r.gst_rate_pct
          if (rate !== undefined && rate !== '' && !Number.isFinite(Number(rate))) err(i, 'GST rate is not a number.', 'gst_rate_pct')
          if (!r.hsn_code) warn(i, 'No HSN/SAC — GST returns will flag this item.', 'hsn_code')
        }
      })
    }

    if (entity === 'opening_balances') {
      const ledgers = new Map(
        (await prisma.tallyLedger.findMany({ where: { tallyCompanyId: companyId, ...alive }, select: { id: true, name: true } }))
          .map((l) => [l.name.toLowerCase(), l.id]),
      )
      rows.forEach((r, i) => {
        const name = String(r.ledger ?? r.name ?? '').trim()
        if (!name) { err(i, 'Ledger name is required.', 'ledger'); return }
        if (!ledgers.has(name.toLowerCase())) err(i, `No ledger named "${name}".`, 'ledger')
        if (!Number.isFinite(Number(r.amount))) err(i, 'Amount is not a number.', 'amount')
        if (!['dr', 'cr'].includes(String(r.dr_cr ?? '').toLowerCase())) err(i, 'Dr/Cr must be dr or cr.', 'dr_cr')
      })
    }

    if (entity === 'vouchers') {
      const ledgers = new Map(
        (await prisma.tallyLedger.findMany({ where: { tallyCompanyId: companyId, ...alive }, select: { id: true, name: true } }))
          .map((l) => [l.name.toLowerCase(), l.id]),
      )
      const types = new Set((await prisma.tallyVoucherType.findMany({ where: { tallyCompanyId: companyId, ...alive }, select: { code: true } })).map((t) => t.code))
      // A voucher import row is one LINE; rows sharing a voucher_key form one voucher.
      const byKey = new Map<string, { rows: number[]; dr: number; cr: number }>()
      rows.forEach((r, i) => {
        const key = String(r.voucher_key ?? r.voucher_number ?? '').trim()
        if (!key) { err(i, 'voucher_key (or voucher_number) is required so lines can be grouped into vouchers.', 'voucher_key'); return }
        const date = String(r.date ?? '')
        if (!DATE_RE.test(date)) err(i, 'Date must be YYYY-MM-DD.', 'date')
        const type = String(r.voucher_type ?? '').trim().toLowerCase().replace(/\s+/g, '_')
        if (!types.has(type)) err(i, `Unknown voucher type "${r.voucher_type}".`, 'voucher_type')
        const ledger = String(r.ledger ?? '').trim()
        if (!ledgers.has(ledger.toLowerCase())) err(i, `No ledger named "${ledger}".`, 'ledger')
        const amount = Number(r.amount)
        if (!Number.isFinite(amount) || amount <= 0) err(i, 'Amount must be a positive number.', 'amount')
        const dc = String(r.dr_cr ?? '').toLowerCase()
        if (!['dr', 'cr'].includes(dc)) err(i, 'Dr/Cr must be dr or cr.', 'dr_cr')
        if (!byKey.has(key)) byKey.set(key, { rows: [], dr: 0, cr: 0 })
        const g = byKey.get(key)!
        g.rows.push(i)
        if (dc === 'dr') g.dr += Math.round(amount * 100)
        else if (dc === 'cr') g.cr += Math.round(amount * 100)
      })
      for (const [key, g] of byKey) {
        if (g.dr !== g.cr) {
          for (const row of g.rows) err(row, `Voucher "${key}" is out of balance: Dr ${formatPaise(g.dr)} vs Cr ${formatPaise(g.cr)}.`)
        }
      }
    }

    return {
      entity,
      total_rows: rows.length,
      valid_rows: rows.length - invalid.size,
      invalid_rows: invalid.size,
      duplicate_rows: duplicates,
      issues: issues.slice(0, 500),
      sample: rows.slice(0, 5),
    }
  },

  /** Phase 2 — commit. Refuses outright if anything is invalid, unless skip_invalid. */
  async commitImport(session: Session, companyId: string, entity: ImportEntity, rows: Record<string, unknown>[], opts: { skipInvalid?: boolean } = {}) {
    await TallyCompanyService.requireOwned(session, companyId)
    await TallyBootstrapService.ensure(companyId)
    const preview = await TallyDataService.validateImport(session, companyId, entity, rows)
    if (preview.invalid_rows > 0 && !opts.skipInvalid) {
      throw ApiError.unprocessable('invalid_rows', `${preview.invalid_rows} of ${preview.total_rows} rows are invalid. Fix them, or re-run with skip_invalid.`, preview.issues.slice(0, 50))
    }
    const badRows = new Set(preview.issues.filter((i) => i.severity === 'error').map((i) => i.row))
    const usable = rows.filter((_, i) => !badRows.has(i))

    if (entity === 'groups') {
      const groups = new Map((await prisma.tallyGroup.findMany({ where: { tallyCompanyId: companyId, ...alive }, select: { id: true, name: true, nature: true, affectsPL: true } })).map((g) => [g.name.toLowerCase(), g]))
      let created = 0, skipped = 0
      for (const r of usable) {
        const name = String(r.name).trim()
        if (groups.has(name.toLowerCase())) { skipped++; continue }
        const parentName = String(r.under ?? r.parent ?? '').trim()
        const parent = parentName ? groups.get(parentName.toLowerCase()) : undefined
        const row = await prisma.tallyGroup.create({
          data: {
            tallyCompanyId: companyId, name,
            parentGroupId: parent?.id ?? null,
            nature: parent?.nature ?? String(r.nature ?? 'assets').toLowerCase(),
            affectsPL: parent?.affectsPL ?? Boolean(r.affects_pl),
          },
        })
        groups.set(name.toLowerCase(), { id: row.id, name: row.name, nature: row.nature, affectsPL: row.affectsPL })
        created++
      }
      return { entity, created, skipped }
    }

    if (entity === 'ledgers') {
      const groups = new Map((await prisma.tallyGroup.findMany({ where: { tallyCompanyId: companyId, ...alive }, select: { id: true, name: true } })).map((g) => [g.name.toLowerCase(), g.id]))
      const existing = new Set((await prisma.tallyLedger.findMany({ where: { tallyCompanyId: companyId, ...alive }, select: { name: true } })).map((l) => l.name.toLowerCase()))
      let created = 0, skipped = 0
      for (const r of usable) {
        const name = String(r.name).trim()
        if (existing.has(name.toLowerCase())) { skipped++; continue }
        const groupId = groups.get(String(r.under ?? r.group).trim().toLowerCase())!
        await prisma.tallyLedger.create({
          data: {
            tallyCompanyId: companyId, name, groupId,
            openingBalancePaise: Math.round(Number(r.opening_balance ?? 0) * 100),
            openingBalanceType: String(r.dr_cr ?? 'dr').toLowerCase(),
            gstin: r.gstin ? String(r.gstin).trim() : null,
            pan: r.pan ? String(r.pan).trim() : null,
            state: r.state ? String(r.state).trim() : null,
            address: r.address ? String(r.address).trim() : null,
            contact: r.contact ? String(r.contact).trim() : null,
            creditPeriodDays: r.credit_period_days ? Number(r.credit_period_days) : null,
          },
        })
        existing.add(name.toLowerCase())
        created++
      }
      return { entity, created, skipped }
    }

    if (entity === 'stock_items') {
      const existing = new Set((await prisma.tallyStockItem.findMany({ where: { tallyCompanyId: companyId, ...alive }, select: { name: true } })).map((l) => l.name.toLowerCase()))
      const units = new Map((await prisma.tallyUnit.findMany({ where: { tallyCompanyId: companyId, ...alive }, select: { id: true, name: true } })).map((u) => [u.name.toLowerCase(), u.id]))
      let created = 0, skipped = 0
      for (const r of usable) {
        const name = String(r.name).trim()
        if (existing.has(name.toLowerCase())) { skipped++; continue }
        const item = await prisma.tallyStockItem.create({
          data: {
            tallyCompanyId: companyId, name,
            unitId: units.get(String(r.unit ?? 'Nos').toLowerCase()) ?? null,
            hsnCode: r.hsn_code ? String(r.hsn_code).trim() : null,
            gstRateBp: Math.round(Number(r.gst_rate_pct ?? 0) * 100),
            standardCostPaise: Math.round(Number(r.standard_cost ?? 0) * 100),
            standardPricePaise: Math.round(Number(r.standard_price ?? 0) * 100),
            reorderLevelMilli: Math.round(Number(r.reorder_level ?? 0) * 1000),
          },
        })
        const openQty = Math.round(Number(r.opening_qty ?? 0) * 1000)
        if (openQty) {
          const rate = Math.round(Number(r.opening_rate ?? 0) * 100)
          await prisma.tallyStockOpening.create({
            data: { tallyCompanyId: companyId, stockItemId: item.id, qtyMilli: openQty, ratePaise: rate, valuePaise: Math.round((openQty * rate) / 1000) },
          })
        }
        existing.add(name.toLowerCase())
        created++
      }
      return { entity, created, skipped }
    }

    if (entity === 'opening_balances') {
      const ledgers = new Map((await prisma.tallyLedger.findMany({ where: { tallyCompanyId: companyId, ...alive }, select: { id: true, name: true } })).map((l) => [l.name.toLowerCase(), l.id]))
      let updated = 0
      for (const r of usable) {
        const id = ledgers.get(String(r.ledger ?? r.name).trim().toLowerCase())!
        await prisma.tallyLedger.update({
          where: { id },
          data: { openingBalancePaise: Math.round(Number(r.amount) * 100), openingBalanceType: String(r.dr_cr).toLowerCase() },
        })
        updated++
      }
      return { entity, updated }
    }

    // vouchers — group the lines by voucher_key and post each through the engine
    const ledgers = new Map((await prisma.tallyLedger.findMany({ where: { tallyCompanyId: companyId, ...alive }, select: { id: true, name: true } })).map((l) => [l.name.toLowerCase(), l.id]))
    const groupsByKey = new Map<string, Record<string, unknown>[]>()
    for (const r of usable) {
      const key = String(r.voucher_key ?? r.voucher_number ?? '').trim()
      if (!groupsByKey.has(key)) groupsByKey.set(key, [])
      groupsByKey.get(key)!.push(r)
    }
    let posted = 0
    const failures: { voucher_key: string; message: string }[] = []
    for (const [key, lines] of groupsByKey) {
      const head = lines[0]
      try {
        await postVoucher(companyId, {
          voucherTypeCode: String(head.voucher_type).trim().toLowerCase().replace(/\s+/g, '_'),
          date: String(head.date),
          voucherNumber: head.voucher_number ? String(head.voucher_number) : undefined,
          narration: head.narration ? String(head.narration) : null,
          referenceNumber: head.reference ? String(head.reference) : null,
          entries: lines.map((l) => ({
            ledgerId: ledgers.get(String(l.ledger).trim().toLowerCase())!,
            entryType: String(l.dr_cr).toLowerCase() as 'dr' | 'cr',
            amountPaise: Math.round(Number(l.amount) * 100),
          })),
        }, session.userId)
        posted++
      } catch (e) {
        failures.push({ voucher_key: key, message: e instanceof Error ? e.message : 'Unknown error' })
      }
    }
    return { entity, posted, failed: failures.length, failures: failures.slice(0, 50) }
  },

  // ── Export ─────────────────────────────────────────────────────────

  /** A company's masters and vouchers as JSON — also the backup payload. */
  async exportJson(session: Session, companyId: string, opts: { includeVouchers?: boolean } = {}) {
    const company = await TallyCompanyService.requireOwned(session, companyId)
    const [financialYears, groups, ledgers, voucherTypes, stockItems, units, godowns, openings, taxRates, settings] = await Promise.all([
      prisma.tallyFinancialYear.findMany({ where: { tallyCompanyId: companyId } }),
      prisma.tallyGroup.findMany({ where: { tallyCompanyId: companyId, ...alive } }),
      prisma.tallyLedger.findMany({ where: { tallyCompanyId: companyId, ...alive } }),
      prisma.tallyVoucherType.findMany({ where: { tallyCompanyId: companyId, ...alive } }),
      prisma.tallyStockItem.findMany({ where: { tallyCompanyId: companyId, ...alive } }),
      prisma.tallyUnit.findMany({ where: { tallyCompanyId: companyId, ...alive } }),
      prisma.tallyGodown.findMany({ where: { tallyCompanyId: companyId, ...alive } }),
      prisma.tallyStockOpening.findMany({ where: { tallyCompanyId: companyId } }),
      prisma.tallyTaxRate.findMany({ where: { tallyCompanyId: companyId, ...alive } }),
      prisma.tallySetting.findMany({ where: { tallyCompanyId: companyId } }),
    ])
    const vouchers = opts.includeVouchers === false ? [] : await prisma.tallyVoucher.findMany({
      where: { tallyCompanyId: companyId, ...alive },
      include: { entries: { include: { allocations: true } }, items: true },
      orderBy: { date: 'asc' },
    })
    return {
      format: 'auditos.tally.company.v1',
      exported_at: new Date().toISOString(),
      company,
      financial_years: financialYears,
      groups, ledgers, voucher_types: voucherTypes,
      stock_items: stockItems, units, godowns, stock_openings: openings,
      tax_rates: taxRates, settings,
      vouchers,
      counts: { groups: groups.length, ledgers: ledgers.length, vouchers: vouchers.length, stock_items: stockItems.length },
    }
  },

  /** CSV for any tabular report the UI already has. */
  toCsv(rows: Record<string, unknown>[], columns?: { key: string; label: string }[]): string {
    if (!rows.length) return ''
    const cols = columns ?? Object.keys(rows[0]).map((k) => ({ key: k, label: k }))
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    return [cols.map((c) => esc(c.label)).join(','), ...rows.map((r) => cols.map((c) => esc(r[c.key])).join(','))].join('\n')
  },

  /**
   * Tally-style XML for vouchers. Best-effort shape of the ENVELOPE /
   * TALLYMESSAGE structure so the data can be moved into a Tally company;
   * it is an export format, not a certified integration.
   */
  async exportVoucherXml(session: Session, companyId: string, filter: { from?: string; to?: string } = {}) {
    const company = await TallyCompanyService.requireOwned(session, companyId)
    const vouchers = await prisma.tallyVoucher.findMany({
      where: {
        tallyCompanyId: companyId, ...alive, status: 'active',
        ...(filter.from || filter.to ? { date: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } } : {}),
      },
      include: { entries: { include: { ledger: { select: { name: true } } } }, voucherType: true },
      orderBy: { date: 'asc' },
    })
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const ymd = (iso: string) => iso.replace(/-/g, '')
    const body = vouchers.map((v) => `
      <TALLYMESSAGE xmlns:UDF="TallyUDF">
        <VOUCHER VCHTYPE="${esc(v.voucherType.name)}" ACTION="Create">
          <DATE>${ymd(v.date)}</DATE>
          <VOUCHERTYPENAME>${esc(v.voucherType.name)}</VOUCHERTYPENAME>
          <VOUCHERNUMBER>${esc(v.voucherNumber)}</VOUCHERNUMBER>
          <NARRATION>${esc(v.narration ?? '')}</NARRATION>
${v.entries.map((e) => `          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>${esc(e.ledger.name)}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>${e.entryType === 'dr' ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
            <AMOUNT>${e.entryType === 'dr' ? '-' : ''}${(e.amountPaise / 100).toFixed(2)}</AMOUNT>
          </ALLLEDGERENTRIES.LIST>`).join('\n')}
        </VOUCHER>
      </TALLYMESSAGE>`).join('')
    return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES><SVCURRENTCOMPANY>${esc(company.name)}</SVCURRENTCOMPANY></STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>${body}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`
  },

  // ── Backup / restore ───────────────────────────────────────────────

  async createBackup(session: Session, companyId: string, label?: string) {
    const company = await TallyCompanyService.requireOwned(session, companyId)
    const payload = await TallyDataService.exportJson(session, companyId)
    const json = JSON.stringify(payload)
    const row = await prisma.tallyBackup.create({
      data: {
        tallyCompanyId: companyId,
        label: label?.trim() || `${company.name} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
        payloadJson: json,
        sizeBytes: Buffer.byteLength(json, 'utf8'),
        voucherCount: payload.counts.vouchers,
        ledgerCount: payload.counts.ledgers,
        createdByUserId: session.userId,
      },
    })
    return { id: row.id, label: row.label, size_bytes: row.sizeBytes, voucher_count: row.voucherCount, ledger_count: row.ledgerCount, created_at: row.createdAt.toISOString() }
  },

  async listBackups(session: Session, companyId: string) {
    await TallyCompanyService.requireOwned(session, companyId)
    const rows = await prisma.tallyBackup.findMany({
      where: { tallyCompanyId: companyId }, orderBy: { createdAt: 'desc' },
      select: { id: true, label: true, sizeBytes: true, voucherCount: true, ledgerCount: true, createdAt: true, createdByUserId: true },
    })
    return rows.map((r) => ({
      id: r.id, label: r.label, size_bytes: r.sizeBytes, voucher_count: r.voucherCount,
      ledger_count: r.ledgerCount, created_at: r.createdAt.toISOString(), created_by: r.createdByUserId,
    }))
  },

  async downloadBackup(session: Session, companyId: string, backupId: string) {
    await TallyCompanyService.requireOwned(session, companyId)
    const row = await prisma.tallyBackup.findFirst({ where: { id: backupId, tallyCompanyId: companyId } })
    if (!row) throw ApiError.notFound('No such backup.')
    return { label: row.label, payload: row.payloadJson }
  },

  /**
   * Restore into a NEW company. The source company is untouched, and the
   * caller must name the new company — there is no in-place overwrite
   * path in the UI, by design.
   */
  async restoreBackup(session: Session, companyId: string, backupId: string, newCompanyName: string) {
    await TallyCompanyService.requireOwned(session, companyId)
    const row = await prisma.tallyBackup.findFirst({ where: { id: backupId, tallyCompanyId: companyId } })
    if (!row) throw ApiError.notFound('No such backup.')
    const name = newCompanyName.trim()
    if (!name) throw ApiError.badRequest('A name for the restored company is required.')

    let payload: Awaited<ReturnType<typeof TallyDataService.exportJson>>
    try { payload = JSON.parse(row.payloadJson) } catch { throw ApiError.unprocessable('corrupt_backup', 'This backup could not be parsed.') }
    if (payload.format !== 'auditos.tally.company.v1') throw ApiError.unprocessable('unknown_format', 'Unrecognised backup format.')

    const created = await TallyCompanyService.create(session, {
      name,
      booksBeginFrom: payload.company.booksBeginFrom,
      fyBeginMonth: payload.company.fyBeginMonth,
      gstin: payload.company.gstin ?? undefined,
      pan: payload.company.pan ?? undefined,
      state: payload.company.state ?? undefined,
      address: payload.company.address ?? undefined,
    })

    // Map old ids to new ones as each layer is recreated.
    const groupMap = new Map<string, string>()
    const existingGroups = await prisma.tallyGroup.findMany({ where: { tallyCompanyId: created.id, ...alive }, select: { id: true, name: true } })
    const byName = new Map(existingGroups.map((g) => [g.name, g.id]))
    for (const g of payload.groups) {
      const already = byName.get(g.name)
      if (already) { groupMap.set(g.id, already); continue }
      const row2 = await prisma.tallyGroup.create({
        data: {
          tallyCompanyId: created.id, name: g.name, nature: g.nature, affectsPL: g.affectsPL,
          parentGroupId: g.parentGroupId ? groupMap.get(g.parentGroupId) ?? null : null,
        },
      })
      groupMap.set(g.id, row2.id)
    }
    const ledgerMap = new Map<string, string>()
    for (const l of payload.ledgers) {
      const existing = await prisma.tallyLedger.findFirst({ where: { tallyCompanyId: created.id, name: l.name, ...alive }, select: { id: true } })
      if (existing) { ledgerMap.set(l.id, existing.id); continue }
      const row2 = await prisma.tallyLedger.create({
        data: {
          tallyCompanyId: created.id, name: l.name, groupId: groupMap.get(l.groupId)!,
          openingBalancePaise: l.openingBalancePaise, openingBalanceType: l.openingBalanceType,
          gstin: l.gstin, pan: l.pan, state: l.state, address: l.address, contact: l.contact,
          creditPeriodDays: l.creditPeriodDays, taxConfigJson: l.taxConfigJson,
          bankAccountName: l.bankAccountName, bankAccountNumber: l.bankAccountNumber, bankIfsc: l.bankIfsc,
        },
      })
      ledgerMap.set(l.id, row2.id)
    }
    let vouchersRestored = 0
    const voucherFailures: string[] = []
    for (const v of payload.vouchers) {
      if (v.status !== 'active') continue
      try {
        await postVoucher(created.id, {
          voucherTypeCode: v.voucherTypeCode,
          date: v.date,
          voucherNumber: v.voucherNumber,
          narration: v.narration,
          referenceNumber: v.referenceNumber,
          partyLedgerId: v.partyLedgerId ? ledgerMap.get(v.partyLedgerId) ?? null : null,
          placeOfSupply: v.placeOfSupply,
          roundOffPaise: v.roundOffPaise,
          entries: v.entries.map((e) => ({
            ledgerId: ledgerMap.get(e.ledgerId)!,
            entryType: e.entryType as 'dr' | 'cr',
            amountPaise: e.amountPaise,
            narration: e.narration,
            isPartyLedger: e.isPartyLedger,
          })),
        }, session.userId)
        vouchersRestored++
      } catch (e) {
        voucherFailures.push(`${v.voucherNumber}: ${e instanceof Error ? e.message : 'failed'}`)
      }
    }
    return {
      restored_company_id: created.id,
      restored_company_name: created.name,
      groups: groupMap.size, ledgers: ledgerMap.size,
      vouchers_restored: vouchersRestored,
      voucher_failures: voucherFailures.slice(0, 25),
    }
  },

  /** Post-restore proof: the two companies' trial balances should agree. */
  async verifyRestore(session: Session, sourceCompanyId: string, restoredCompanyId: string) {
    await TallyCompanyService.requireOwned(session, sourceCompanyId)
    await TallyCompanyService.requireOwned(session, restoredCompanyId)
    const [a, b] = await Promise.all([trialBalance(sourceCompanyId, {}), trialBalance(restoredCompanyId, {})])
    const [la, lb] = await Promise.all([ledgerBalances(sourceCompanyId, {}), ledgerBalances(restoredCompanyId, {})])
    const mapB = new Map(lb.map((l) => [l.ledgerName, l.closingPaise]))
    const mismatches = la
      .filter((l) => (mapB.get(l.ledgerName) ?? 0) !== l.closingPaise)
      .map((l) => ({ ledger: l.ledgerName, source_paise: l.closingPaise, restored_paise: mapB.get(l.ledgerName) ?? null }))
    return {
      source_total_debit_paise: a.totals.closingDebitPaise,
      restored_total_debit_paise: b.totals.closingDebitPaise,
      matches: mismatches.length === 0 && a.totals.closingDebitPaise === b.totals.closingDebitPaise,
      mismatches: mismatches.slice(0, 50),
    }
  },
}
