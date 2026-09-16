/**
 * Sample tasks for development (spec §34).
 *
 * Opt-in only — `npm --prefix server run seed:tasks`. It is NOT part of the
 * main seed and never runs at start-up, so no sample work can appear in a
 * production database by accident. Re-running it is safe: tasks are matched
 * by title and skipped if already present.
 */
import '../src/lib/env.js'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const SAMPLES = [
  { title: 'GST Monthly Review', priority: 'high', estimatedMinutes: 120, slot: 0 },
  { title: 'Client Ledger Verification', priority: 'medium', estimatedMinutes: 90, slot: 1 },
  { title: 'Audit Working Paper Preparation', priority: 'urgent', estimatedMinutes: 180, slot: 0 },
]

async function main() {
  const employees = await prisma.employee.findMany({
    where: { deletedAt: null, status: { not: 'inactive' } },
    select: { id: true, fullName: true },
    orderBy: { fullName: 'asc' },
    take: 2,
  })
  if (employees.length === 0) {
    console.error('No employees found — run the main seed first.')
    process.exit(1)
  }
  const manager = await prisma.user.findFirst({ where: { role: { code: 'md' } }, select: { id: true, employeeId: true } })

  const due = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
  let created = 0
  for (const s of SAMPLES) {
    const existing = await prisma.task.findFirst({ where: { title: s.title, deletedAt: null }, select: { id: true } })
    if (existing) continue
    const assignee = employees[s.slot % employees.length]
    const task = await prisma.task.create({
      data: {
        title: s.title,
        description: `Sample task for development. Assigned to ${assignee.fullName}.`,
        assignedEmployeeId: assignee.id,
        assignedById: manager?.employeeId ?? null,
        priority: s.priority,
        status: 'pending',
        dueDate: due,
        estimatedMinutes: s.estimatedMinutes,
        createdBy: manager?.id ?? null,
      },
    })
    await prisma.taskAuditLog.create({
      data: { taskId: task.id, action: 'task_created', performedByUserId: manager?.id ?? null, performedByEmployeeId: manager?.employeeId ?? null, newStatus: 'pending' },
    })
    await prisma.taskAuditLog.create({
      data: {
        taskId: task.id, action: 'task_assigned',
        performedByUserId: manager?.id ?? null, performedByEmployeeId: manager?.employeeId ?? null,
        metaJson: JSON.stringify({ employee_id: assignee.id, employee_name: assignee.fullName }),
      },
    })
    created++
    console.log(`  + ${s.title} → ${assignee.fullName} (${s.priority}, ${s.estimatedMinutes}m)`)
  }
  console.log(created ? `Seeded ${created} sample task(s).` : 'Sample tasks already present — nothing to do.')
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
