import { describe, expect, it } from 'vitest'
import { taskToApi } from '../service.js'

/**
 * `is_overdue` on the Tasks API: due before TODAY IN IST and not completed
 * or cancelled. Pure serializer checks — no database.
 */

type Row = Parameters<typeof taskToApi>[0]

function row(over: Partial<Record<string, unknown>> = {}): Row {
  const t = new Date('2026-09-01T04:00:00Z')
  return {
    id: 't1', organisationId: 'o', title: 'File GSTR-3B', description: null,
    status: 'pending', priority: 'medium', dueDate: '2026-09-10',
    assignedEmployeeId: 'e1', assignedEmployee: { id: 'e1', fullName: 'A B', employeeCode: 'E1', departmentId: null },
    assignedById: null, assignedBy: null, clientId: null, client: null, clientServiceId: null, clientService: null,
    auditEngagementId: null, estimatedMinutes: null, actualMinutes: 0, pauseMinutes: 0,
    startedAt: null, endedAt: null, completedAt: null, cancelledAt: null, cancelReason: null,
    notes: null, attachmentUrl: null, sessions: [], createdAt: t, updatedAt: t, deletedAt: null,
    ...over,
  } as unknown as Row
}

describe('task is_overdue', () => {
  it('is a boolean, never null', () => {
    const api = taskToApi(row({ dueDate: null }), new Date('2026-09-20T06:00:00Z'))
    expect(api.is_overdue).toBe(false)
  })

  it('uses the IST calendar day: 01:30 IST on the 11th makes a task due on the 10th overdue', () => {
    // 2026-09-10T20:00Z is 2026-09-11 01:30 IST — still the 10th in UTC.
    const api = taskToApi(row({ dueDate: '2026-09-10' }), new Date('2026-09-10T20:00:00Z'))
    expect(api.is_overdue).toBe(true)
    expect(api.overdue).toBe(true)
  })

  it('is not overdue on the due date itself', () => {
    expect(taskToApi(row({ dueDate: '2026-09-10' }), new Date('2026-09-10T12:00:00Z')).is_overdue).toBe(false)
  })

  it('a completed or cancelled task is never overdue', () => {
    const late = new Date('2026-09-20T06:00:00Z')
    expect(taskToApi(row({ status: 'completed' }), late).is_overdue).toBe(false)
    expect(taskToApi(row({ status: 'cancelled' }), late).is_overdue).toBe(false)
    expect(taskToApi(row({ status: 'in_progress' }), late).is_overdue).toBe(true)
  })
})
