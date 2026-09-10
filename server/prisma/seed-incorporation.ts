import type { PrismaClient } from '@prisma/client'
import {
  CHECKLIST_TEMPLATE, ENTITY_TYPE_SEED,
} from '../src/modules/incorporation/validate.js'

/**
 * INCORPORATION SERVICE seed.
 *
 * Two very different things live in this file, and the difference matters:
 *
 *   CONFIGURATION (entity types, checklist templates) is REAL data. It is
 *   what the module runs on, it is editable in Settings, and it carries no
 *   demo marking.
 *
 *   DEMO CASES are marked `isDemo: true` and every reference number they
 *   carry is prefixed `DEMO-`. That is deliberate: a sample SRN that looked
 *   like a real one is exactly the kind of fabricated government information
 *   this module exists to never produce.
 *
 * Idempotent — skips whatever already exists, and creates no client, no
 * employee and no document category of its own.
 */
export async function seedIncorporation(prisma: PrismaClient, organisationId: string) {
  // ── Configuration: entity types ─────────────────────────────────────────
  for (const [i, e] of ENTITY_TYPE_SEED.entries()) {
    await prisma.incorporationEntityType.upsert({
      where: { code: e.code },
      update: {},
      create: {
        organisationId,
        code: e.code,
        name: e.name,
        description: e.description,
        partyRolesJson: JSON.stringify(e.roles),
        minParties: e.minParties,
        maxParties: e.maxParties,
        defaultTargetDays: e.targetDays,
        sortOrder: i,
      },
    })
  }

  // ── Configuration: the baseline checklist ───────────────────────────────
  // entityTypeId = null, so every entity type inherits it. Per-type rows are
  // added in Settings on top of these.
  const templateCount = await prisma.incorporationChecklistTemplate.count({ where: { entityTypeId: null } })
  if (templateCount === 0) {
    await prisma.incorporationChecklistTemplate.createMany({
      data: CHECKLIST_TEMPLATE.map((t, i) => ({
        organisationId,
        entityTypeId: null,
        category: t.category,
        label: t.label,
        stage: t.stage,
        documentCategory: t.documentCategory ?? null,
        sortOrder: i,
      })),
    })
  }

  // ── Demo cases ──────────────────────────────────────────────────────────
  const existingCases = await prisma.incorporationCase.count()
  if (existingCases > 0) {
    return {
      entityTypes: await prisma.incorporationEntityType.count(),
      templates: await prisma.incorporationChecklistTemplate.count(),
      cases: existingCases,
    }
  }

  const clients = await prisma.client.findMany({
    where: { deletedAt: null }, take: 5, orderBy: { clientCode: 'asc' },
  })
  const staff = await prisma.employee.findMany({
    where: { organisationId, deletedAt: null, status: 'active' },
    select: { id: true }, take: 4,
  })
  if (clients.length === 0 || staff.length === 0) {
    return { entityTypes: await prisma.incorporationEntityType.count(), templates: templateCount, cases: 0 }
  }
  const pick = (i: number) => staff[i % staff.length].id

  const types = new Map(
    (await prisma.incorporationEntityType.findMany()).map((t) => [t.code, t]),
  )
  const templates = await prisma.incorporationChecklistTemplate.findMany({
    where: { entityTypeId: null, deletedAt: null }, orderBy: { sortOrder: 'asc' },
  })

  const iso = (offsetDays: number) =>
    new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)

  /**
   * One case per stage the Overview is meant to show something at. Every
   * reference number below starts DEMO- so nobody can mistake it for an
   * actual government reference.
   */
  const CASES: {
    clientIdx: number; typeCode: string; stage: string; status: string
    proposedName: string; alternate: string; activity: string; state: string; city: string
    priority: string; target: number
    parties: { role: string; name: string; phone: string }[]
  }[] = [
    {
      clientIdx: 0, typeCode: 'PVT_LTD', stage: 'new', status: 'active',
      proposedName: 'Harbourline Technologies Private Limited',
      alternate: 'Harbourline Systems Private Limited',
      activity: 'Software development and IT consulting', state: 'Tamil Nadu', city: 'Chennai',
      priority: 'medium', target: 28,
      parties: [
        { role: 'promoter', name: 'Sundar Raghavan', phone: '9840012345' },
        { role: 'director', name: 'Lakshmi Narayanan', phone: '9840012346' },
      ],
    },
    {
      clientIdx: 1, typeCode: 'LLP', stage: 'documents_pending', status: 'active',
      proposedName: 'Kadal Exports LLP', alternate: 'Kadal Trading LLP',
      activity: 'Export of textile goods', state: 'Tamil Nadu', city: 'Tiruppur',
      priority: 'high', target: 18,
      parties: [
        { role: 'designated_partner', name: 'Meenakshi Sundaram', phone: '9840022345' },
        { role: 'designated_partner', name: 'Rajesh Balan', phone: '9840022346' },
        { role: 'partner', name: 'Anitha Rajan', phone: '9840022347' },
      ],
    },
    {
      clientIdx: 2, typeCode: 'PVT_LTD', stage: 'government_processing', status: 'active',
      proposedName: 'Vellore Agritech Private Limited', alternate: 'Vellore Agri Solutions Private Limited',
      activity: 'Agricultural equipment manufacture', state: 'Tamil Nadu', city: 'Vellore',
      priority: 'medium', target: 9,
      parties: [
        { role: 'promoter', name: 'Karthik Subramanian', phone: '9840032345' },
        { role: 'director', name: 'Divya Venkatesh', phone: '9840032346' },
      ],
    },
    {
      clientIdx: 3, typeCode: 'OPC', stage: 'government_query', status: 'active',
      proposedName: 'Nilgiri Craft (OPC) Private Limited', alternate: 'Nilgiri Artisan (OPC) Private Limited',
      activity: 'Handicraft retail', state: 'Tamil Nadu', city: 'Coimbatore',
      priority: 'critical', target: 4,
      parties: [
        { role: 'promoter', name: 'Bhavani Krishnan', phone: '9840042345' },
        { role: 'nominee', name: 'Ganesh Krishnan', phone: '9840042346' },
      ],
    },
    {
      clientIdx: 4, typeCode: 'PARTNERSHIP', stage: 'completed', status: 'completed',
      proposedName: 'Marina Traders', alternate: 'Marina Commodities',
      activity: 'Wholesale trading', state: 'Tamil Nadu', city: 'Chennai',
      priority: 'low', target: -12,
      parties: [
        { role: 'partner', name: 'Prakash Iyer', phone: '9840052345' },
        { role: 'partner', name: 'Sowmya Prakash', phone: '9840052346' },
      ],
    },
  ]

  let created = 0
  for (const [ci, spec] of CASES.entries()) {
    const client = clients[spec.clientIdx % clients.length]
    const type = types.get(spec.typeCode)
    if (!type) continue
    const owner = pick(ci)
    const recorder = pick(ci + 1)
    const year = new Date().getUTCFullYear()

    const row = await prisma.incorporationCase.create({
      data: {
        organisationId,
        caseCode: `INC-${year}-${String(ci + 1).padStart(4, '0')}`,
        clientId: client.id,
        entityTypeId: type.id,
        proposedName: spec.proposedName,
        alternateName: spec.alternate,
        businessActivity: spec.activity,
        businessCategory: 'Services',
        state: spec.state,
        city: spec.city,
        registeredOfficeInfo: `${spec.city}, ${spec.state} — address on file with the client.`,
        incorporationObjective: 'Register the entity and hand over the statutory documents.',
        stage: spec.stage,
        status: spec.status,
        priority: spec.priority,
        assignedEmployeeId: owner,
        targetDate: iso(spec.target),
        internalNotes: 'Sample case seeded for the preview.',
        completedAt: spec.status === 'completed' ? new Date(Date.now() - 12 * 86_400_000) : null,
        isDemo: true,
        parties: {
          create: spec.parties.map((p, i) => ({
            role: p.role, name: p.name, contactNumber: p.phone,
            email: `${p.name.split(' ')[0].toLowerCase()}@example.in`,
            dscRequired: p.role !== 'nominee', sortOrder: i,
          })),
        },
        checklistItems: {
          create: templates.map((t, i) => ({
            templateId: t.id, category: t.category, label: t.label, stage: t.stage, sortOrder: i,
            // A finished case has a finished checklist; a live one is partway
            // through it, in the order the work is done.
            status: spec.status === 'completed'
              ? 'completed'
              : i < Math.round(templates.length * (ci + 1) / (CASES.length + 2)) ? 'completed' : 'pending',
          })),
        },
      },
      include: { parties: true },
    })
    created++

    // Document requests — the ASK. No files are created; ClientDocument owns
    // those, and a preview link is made by hand in the Documents tab.
    await prisma.incorporationDocumentRequest.createMany({
      data: [
        { caseId: row.id, clientId: client.id, category: 'identity_kyc', documentType: 'PAN card — each person', status: spec.stage === 'new' ? 'required' : 'received', requestedByEmployeeId: owner, requestedAt: new Date(), receivedAt: spec.stage === 'new' ? null : new Date() },
        { caseId: row.id, clientId: client.id, category: 'address_proof', documentType: 'Address proof — each person', status: spec.stage === 'new' ? 'required' : spec.stage === 'documents_pending' ? 'requested' : 'approved', requestedByEmployeeId: owner, requestedAt: new Date() },
        { caseId: row.id, clientId: client.id, category: 'registered_office', documentType: 'Registered office proof', status: spec.stage === 'documents_pending' ? 'requested' : 'received', requestedByEmployeeId: owner, requestedAt: new Date(), dueDate: iso(5) },
      ],
    })

    // DSC — tracking rows only. 'verified' here is an employee's own check.
    for (const p of row.parties.filter((x) => x.dscRequired)) {
      await prisma.incorporationDsc.create({
        data: {
          caseId: row.id, partyId: p.id, required: true,
          status: spec.stage === 'new' ? 'pending'
            : spec.stage === 'documents_pending' ? 'requested'
              : spec.status === 'completed' ? 'verified' : 'received',
          provider: 'DSC vendor — as recorded by employee',
          referenceNo: `DEMO-DSC-${row.caseCode.slice(-4)}-${p.sortOrder + 1}`,
          requestDate: iso(-20), receivedDate: spec.stage === 'new' ? null : iso(-14),
          expiryDate: iso(700),
          remarks: 'Sample record. Status entered by an employee, not checked with any provider.',
          recordedByEmployeeId: recorder,
        },
      })
    }

    // Proposed names.
    const nameStage = spec.stage === 'new' || spec.stage === 'documents_pending'
    await prisma.incorporationName.createMany({
      data: [
        {
          caseId: row.id, proposedName: spec.proposedName, priority: 1,
          status: nameStage ? 'draft' : spec.status === 'completed' ? 'approved' : 'submitted',
          submissionDate: nameStage ? null : iso(-16),
          applicationRef: nameStage ? null : `DEMO-RUN-${row.caseCode.slice(-4)}-A`,
          responseDate: spec.status === 'completed' ? iso(-13) : null,
          remarks: 'Preference 1. Status as recorded by employee.',
          recordedByEmployeeId: recorder,
        },
        {
          caseId: row.id, proposedName: spec.alternate, priority: 2,
          status: nameStage ? 'draft' : 'ready',
          remarks: 'Held in reserve.',
          recordedByEmployeeId: recorder,
        },
      ],
    })

    // Filing + query, for the cases that have got that far.
    if (['government_processing', 'government_query', 'completed'].includes(spec.stage)) {
      const filing = await prisma.incorporationFiling.create({
        data: {
          caseId: row.id,
          filingType: spec.typeCode === 'LLP' ? 'fillip' : 'spice_plus_part_b',
          portal: 'Filed on the government portal — recorded by employee',
          applicationRef: `DEMO-SRN-${row.caseCode.slice(-4)}`,
          acknowledgementRef: `DEMO-ACK-${row.caseCode.slice(-4)}`,
          preparedDate: iso(-11), submittedDate: iso(-10),
          status: spec.status === 'completed' ? 'approved'
            : spec.stage === 'government_query' ? 'query' : 'processing',
          assignedEmployeeId: owner,
          remarks: 'Sample filing. Every reference above was typed in by an employee.',
          recordedByEmployeeId: recorder,
        },
      })

      if (spec.stage === 'government_query') {
        await prisma.incorporationQuery.create({
          data: {
            caseId: row.id, filingId: filing.id,
            queryDate: iso(-4),
            authority: 'Registrar — as recorded by employee',
            description: 'Clarification sought on the registered office proof and one director’s address document.',
            assignedEmployeeId: owner,
            // Deliberately in the past, so the preview has a genuinely
            // overdue row rather than a decorative one.
            responseDueDate: iso(-1),
            status: 'preparing_response',
            remarks: 'Sample query recorded from the portal by an employee.',
            recordedByEmployeeId: recorder,
          },
        })
      }
    }

    // Deliverables and fees on the finished case.
    if (spec.status === 'completed') {
      await prisma.incorporationDeliverable.createMany({
        data: [
          { caseId: row.id, clientId: client.id, name: 'Certificate of Incorporation', type: 'certificate_of_incorporation', status: 'delivered', preparedDate: iso(-13), deliveredDate: iso(-12), deliveredByEmployeeId: owner, referenceNo: `DEMO-COI-${row.caseCode.slice(-4)}`, notes: 'Sample deliverable. Reference recorded by an employee.', recordedByEmployeeId: recorder },
          { caseId: row.id, clientId: client.id, name: 'PAN', type: 'pan', status: 'delivered', preparedDate: iso(-13), deliveredDate: iso(-12), deliveredByEmployeeId: owner, referenceNo: 'DEMO-PAN-0001A', recordedByEmployeeId: recorder },
          { caseId: row.id, clientId: client.id, name: 'TAN', type: 'tan', status: 'prepared', preparedDate: iso(-12), referenceNo: 'DEMO-TAN-0001A', recordedByEmployeeId: recorder },
        ],
      })
    }

    await prisma.incorporationFee.createMany({
      data: [
        { caseId: row.id, clientId: client.id, category: 'professional_fee', description: 'Incorporation professional fee', amountPaise: 2_500_000, status: spec.status === 'completed' ? 'paid' : 'pending', paidAmountPaise: spec.status === 'completed' ? 2_500_000 : 0, paidDate: spec.status === 'completed' ? iso(-11) : null, dueDate: iso(spec.target), recordedByEmployeeId: owner },
        { caseId: row.id, clientId: client.id, category: 'government_fee', description: 'Government filing fee, as paid by the firm', amountPaise: 800_000, status: spec.status === 'completed' ? 'paid' : 'pending', paidAmountPaise: spec.status === 'completed' ? 800_000 : 0, recordedByEmployeeId: owner },
      ],
    })

    await prisma.incorporationActivity.create({
      data: {
        caseId: row.id,
        action: 'incorporation.case.created',
        detail: `Sample case ${row.caseCode} seeded for the preview.`,
      },
    })
  }

  return {
    entityTypes: await prisma.incorporationEntityType.count(),
    templates: await prisma.incorporationChecklistTemplate.count(),
    cases: created,
  }
}
