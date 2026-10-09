import type { Router } from 'express'
import JSZip from 'jszip'
import { prisma, alive } from '../../lib/prisma.js'
import { handler } from '../../lib/http.js'
import { formatINR, toNum } from '../../lib/money.js'
import { fmtDate, fmtDateTime } from '../../lib/dates.js'
import { AUDIT_TYPE_LABEL, type AuditType } from './data.js'
import { activeTemplates, appliesTo, auditStorage, blockersOf, clientsById, employeeNames, progressFor } from './service.js'
import { audit, fileAccess } from './common.js'

/**
 * GET /api/audits/:id/export — the peer review pack: one zip with
 * index.html (the whole file on one page) and every evidence file under
 * working-papers/<ref>/<file>. Audit-logged.
 */

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const safePart = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file'
const money = (p: bigint | null | undefined) => (p == null ? '—' : formatINR(toNum(p)))
const dt = (d: Date | null | undefined) => (d ? fmtDateTime(d) : '—')

function table(head: string[], rows: unknown[][]): string {
  if (!rows.length) return '<p class="empty">None.</p>'
  return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${r.map((c) => `<td>${c instanceof Raw ? c.html : esc(c)}</td>`).join('')}</tr>`).join('')
  }</tbody></table>`
}
class Raw { constructor(public html: string) {} }

export function registerExport(r: Router) {
  r.get('/:id/export', handler(async (req, res) => {
    const { session, e } = await fileAccess(req, 'read')
    const [team, papers, notes, risks, observations, responses, udins, templates, clients, prog] = await Promise.all([
      prisma.auditTeamMember.findMany({ where: { engagementId: e.id, ...alive }, orderBy: { createdAt: 'asc' } }),
      prisma.auditWorkingPaper.findMany({ where: { engagementId: e.id, ...alive }, include: { files: { where: alive, orderBy: { uploadedAt: 'asc' } } } }),
      prisma.auditReviewNote.findMany({ where: { engagementId: e.id, ...alive }, include: { workingPaper: { select: { ref: true } } }, orderBy: { raisedAt: 'asc' } }),
      prisma.auditRisk.findMany({ where: { engagementId: e.id, ...alive }, orderBy: { createdAt: 'asc' } }),
      prisma.auditObservation.findMany({ where: { engagementId: e.id, ...alive } }),
      prisma.auditChecklistResponse.findMany({ where: { engagementId: e.id } }),
      prisma.auditUdin.findMany({ where: { engagementId: e.id }, orderBy: { createdAt: 'asc' } }),
      activeTemplates(),
      clientsById([e.clientId]),
      progressFor([e]),
    ])
    papers.sort((a, b) => a.ref.localeCompare(b.ref, 'en', { numeric: true }))
    observations.sort((a, b) => a.ref.localeCompare(b.ref, 'en', { numeric: true }))
    const names = await employeeNames([
      e.signingPartnerId, e.managerId, e.acceptanceApprovedBy, e.lockedBy,
      ...team.map((t) => t.employeeId),
      ...papers.flatMap((p) => [p.preparedBy, p.reviewedBy, p.assignedTo, ...p.files.map((f) => f.uploadedBy)]),
      ...notes.flatMap((n) => [n.raisedBy, n.respondedBy, n.clearedBy]),
      ...observations.flatMap((o) => [o.ownerId, o.resolvedBy]),
      ...responses.flatMap((x) => [x.preparedBy, x.reviewedBy]),
      ...udins.map((u) => u.partnerId),
    ])
    const n = (id: string | null | undefined) => (id ? names.get(id)?.full_name ?? id : '—')
    const client = clients.get(e.clientId)
    const blockers = blockersOf(e, prog.get(e.id)!)

    const zip = new JSZip()
    // Evidence first, so the index can link the exact paths written.
    const linkOf = new Map<string, string>()
    for (const p of papers) {
      const used = new Set<string>()
      for (const f of p.files) {
        let name = safePart(f.originalName)
        if (used.has(name)) name = `${f.id.slice(0, 8)}-${name}`
        used.add(name)
        const path = `working-papers/${safePart(p.ref)}/${name}`
        try {
          zip.file(path, await auditStorage.get(f.fileKey))
          linkOf.set(f.id, path)
        } catch { /* missing bytes are reported in the index */ }
      }
    }

    const fileCell = (p: (typeof papers)[number]) => new Raw(p.files.map((f) => {
      const path = linkOf.get(f.id)
      const label = `${esc(f.originalName)}${f.isAddendum ? ' (addendum)' : ''}<br><span class="hash">sha256 ${esc(f.sha256)}</span>`
      return path ? `<a href="${esc(path)}">${label}</a>` : `${label} <em>(file missing from storage)</em>`
    }).join('<br>') || '—')

    const checklistHtml = templates.filter((t) => appliesTo(t, e.auditType) || responses.some((x) => x.templateCode === t.code)).map((t) => {
      const by = new Map(responses.filter((x) => x.templateCode === t.code).map((x) => [x.clause, x]))
      return `<h3>${esc(t.name)}</h3>${table(['Clause', 'Answer', 'Remarks', 'WP', 'Prepared', 'Reviewed'],
        t.items.map((i) => {
          const x = by.get(i.clause)
          return [i.clause, x?.answer ?? 'pending', x?.remarks ?? '', x?.workingPaperRef ?? '',
            x?.preparedBy ? `${n(x.preparedBy)} · ${dt(x.preparedAt)}` : '—', x?.reviewedBy ? `${n(x.reviewedBy)} · ${dt(x.reviewedAt)}` : '—']
        }))}`
    }).join('')

    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(e.auditCode)} — ${esc(client?.companyName)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#111}h1{font-size:20px}h2{font-size:16px;margin-top:28px;border-bottom:1px solid #ccc}h3{font-size:14px}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}th{background:#f3f3f3}
.hash{font:11px monospace;color:#555}.empty{color:#777}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px}dt{font-weight:600}</style></head><body>
<h1>${esc(e.auditCode)} · ${esc(e.title)}</h1>
<dl>
<dt>Client</dt><dd>${esc(client?.companyName)} (${esc(client?.clientCode)})</dd>
<dt>Financial year</dt><dd>${esc(e.financialYear)}</dd>
<dt>Audit type</dt><dd>${esc(AUDIT_TYPE_LABEL[e.auditType as AuditType] ?? e.auditType)}</dd>
<dt>Status</dt><dd>${esc(e.status)}</dd>
<dt>Signing partner</dt><dd>${esc(n(e.signingPartnerId))}${e.partnerMembershipNo ? ` (M.No. ${esc(e.partnerMembershipNo)})` : ''}</dd>
<dt>Manager</dt><dd>${esc(n(e.managerId))}</dd>
<dt>Acceptance approved</dt><dd>${e.acceptanceApprovedAt ? `${esc(n(e.acceptanceApprovedBy))} · ${esc(dt(e.acceptanceApprovedAt))}` : 'No'}</dd>
<dt>Report date</dt><dd>${esc(e.reportDate ? fmtDate(e.reportDate) : '—')}${e.reportPlace ? `, ${esc(e.reportPlace)}` : ''}</dd>
<dt>Opinion</dt><dd>${esc(e.opinionType ?? '—')}</dd>
<dt>Assembly due</dt><dd>${esc(e.assemblyDueDate ? fmtDate(e.assemblyDueDate) : '—')}</dd>
<dt>Locked</dt><dd>${e.lockedAt ? `${esc(dt(e.lockedAt))} by ${esc(n(e.lockedBy))}` : 'No'}</dd>
<dt>Exported</dt><dd>${esc(dt(new Date()))}</dd>
</dl>
${blockers.length ? `<p><strong>Open before signing:</strong> ${blockers.map((b) => esc(b.message)).join(' ')}</p>` : ''}
<h2>Team</h2>${table(['Name', 'Role', 'Independence declared', 'Note'], team.map((t) => [n(t.employeeId), t.role, dt(t.independenceDeclaredAt), t.independenceNote ?? '']))}
<h2>Materiality (SA 320)</h2>${table(['Benchmark', 'Base', 'Percent', 'Overall', 'Performance', 'Clearly trivial', 'Rationale'],
      e.overallMaterialityPaise == null ? [] : [[e.materialityBenchmark ?? '', money(e.materialityBasePaise), `${e.materialityPercent ?? ''}%`, money(e.overallMaterialityPaise), money(e.performanceMaterialityPaise), money(e.clearlyTrivialPaise), e.materialityRationale ?? '']])}
<h2>Risks (SA 315)</h2>${table(['Area', 'Assertion', 'Description', 'Level', 'Fraud', 'Response', 'WPs'], risks.map((x) => [x.area, x.assertion ?? '', x.description, x.level, x.fraudRisk ? 'Yes' : 'No', x.response ?? '', x.workingPaperRefs ?? '']))}
<h2>Working papers</h2>${table(['Ref', 'Title', 'Status', 'Conclusion', 'Prepared', 'Reviewed', 'Evidence'],
      papers.map((p) => [p.ref + (p.isAddendum ? ' (addendum)' : ''), p.title, p.status, p.conclusion ?? '',
        p.preparedBy ? `${n(p.preparedBy)} · ${dt(p.preparedAt)}` : '—', p.reviewedBy ? `${n(p.reviewedBy)} · ${dt(p.reviewedAt)}` : '—', fileCell(p)]))}
${papers.filter((p) => p.isAddendum).map((p) => `<p><strong>Addendum ${esc(p.ref)}:</strong> ${esc(p.addendumReason)} (${esc(dt(p.createdAt))})</p>`).join('')}
<h2>Review notes</h2>${table(['WP', 'Note', 'Raised', 'Response', 'Status', 'Cleared'],
      notes.map((x) => [x.workingPaper?.ref ?? '—', x.note, `${n(x.raisedBy)} · ${dt(x.raisedAt)}`, x.response ? `${x.response} (${n(x.respondedBy)})` : '', x.status, x.clearedBy ? `${n(x.clearedBy)} · ${dt(x.clearedAt)}` : '—']))}
<h2>Observations</h2>${table(['Ref', 'Title', 'Kind', 'Severity', 'Amount', 'Adjusted', 'Report impact', 'Management response', 'Status'],
      observations.map((o) => [o.ref, o.title, o.kind, o.severity, money(o.amountPaise), o.adjusted == null ? '—' : o.adjusted ? 'Yes' : 'No', o.reportImpact, o.managementResponse ?? '', o.status]))}
<h2>Checklists</h2>${checklistHtml || '<p class="empty">None.</p>'}
<h2>UDINs</h2>${table(['UDIN', 'Document', 'Date', 'Partner', 'M.No.', 'Generated', 'Revoked'],
      udins.map((u) => [u.udin, u.documentType, u.documentDate, n(u.partnerId), u.membershipNo ?? '', u.generatedOn, u.revokedAt ? `${dt(u.revokedAt)} — ${u.revokedReason ?? ''}` : '']))}
</body></html>`
    zip.file('index.html', html)
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    await audit(req, session, 'export', 'AuditEngagement', e.id, undefined, { files: linkOf.size, bytes: buf.length })
    const name = `${e.auditCode}-${safePart(client?.companyName ?? 'client')}.zip`
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Length', String(buf.length))
    res.send(buf)
  }))
}
